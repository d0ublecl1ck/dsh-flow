#!/usr/bin/env node
/**
 * Real-browser acceptance run for dsh-flow against a running DSH Web instance.
 *
 * The unit tests cover the pure logic and the slot wiring. They cannot tell you
 * whether the button actually lands to the right of the shipped search control,
 * whether the shipped sidebar still answers to `[data-row-key="session:<id>"]`,
 * whether a folded Workspace group is really opened before the scroll, or
 * whether the settings page's switch really removes the button. This script
 * answers exactly those questions, and puts back every state it changes.
 *
 * Every gesture is dispatched as a real mouse event through
 * `Input.dispatchMouseEvent`, never `element.click()`. A programmatic click
 * skips hit testing and pointer sequencing, so it can stay green while a real
 * press would land on a different element.
 *
 * It authenticates the way the shell does: the browser session cookie is
 * `v1.<base64url payload>.<base64url HMAC-SHA256>`, signed with the
 * `client-connection/browser-session` secret in the instance's
 * `.credentials.yaml`, under the name `dsh-auth-` + base64url(sha256(authority)).
 *
 * Usage:
 *   node scripts/verify-browser.mjs
 *   node scripts/verify-browser.mjs --url http://127.0.0.1:43129 --shots /tmp/dsh-flow
 *   node scripts/verify-browser.mjs --client ./client.js
 *
 * `--client` serves that file as this plugin's browser half in place of the one
 * the instance installed, by rewriting the combined plugin bundle in flight.
 * That is what lets a worktree be verified against a running instance without
 * repointing the installed plugin at the worktree. Without the flag, whatever
 * the instance loaded is what gets tested.
 *
 * Preconditions: a DSH Web instance is running at --url, and Google Chrome is
 * installed at the default macOS path (override with --chrome).
 *
 * @module dsh-flow/scripts/verify-browser
 */
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = {
  url: 'http://127.0.0.1:43129',
  home: process.env.DSH_HOME ?? join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness'),
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  shots: null,
  client: null,
  timeoutMs: 30000,
}

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf('--' + name)
  return at === -1 ? fallback : argv[at + 1]
}

const config = {
  ...DEFAULTS,
  url: option('url', DEFAULTS.url),
  home: option('home', DEFAULTS.home),
  chrome: option('chrome', DEFAULTS.chrome),
  shots: option('shots', DEFAULTS.shots),
  client: option('client', DEFAULTS.client),
}

const passes = []
const failures = []
const skips = []
const pass = (message) => { passes.push(message); console.log('  PASS  ' + message) }
const fail = (message) => { failures.push(message); console.log('  FAIL  ' + message) }
const skip = (message) => { skips.push(message); console.log('  SKIP  ' + message) }

const base64url = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The one fact this script needs out of .credentials.yaml; avoids a YAML dependency. */
function readBrowserSessionSecret(text) {
  const lines = text.split(/\r?\n/)
  let inside = false
  let recordIndent = -1
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (!inside) {
      if (trimmed === 'client-connection/browser-session:') { inside = true; recordIndent = indent }
      continue
    }
    if (indent <= recordIndent) break
    const match = trimmed.match(/^secret:\s*(.+)$/)
    if (match) return match[1].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error('no client-connection/browser-session secret in ' + join(config.home, '.credentials.yaml'))
}

function sessionCookie(url, secret) {
  const authority = new URL(url).host
  const name = 'dsh-auth-' + base64url(createHash('sha256').update(authority).digest())
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000
  const body = base64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))
  const signature = createHmac('sha256', Buffer.from(secret, 'base64')).update(body).digest()
  return { name, value: 'v1.' + body + '.' + base64url(signature) }
}

/** Minimal flattened-protocol CDP client over the built-in WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.handlers = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) {
        // Protocol events are the request/response stream's other half; a
        // handler that throws must not take the socket listener down with it.
        for (const handler of this.handlers.get(message.method) ?? []) {
          Promise.resolve(handler(message.params, message.sessionId)).catch(() => {})
        }
        return
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  /**
   * Subscribe to one protocol event.
   * @param method - protocol method name.
   * @param handler - called with the event params and its session id.
   */
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(handler)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method))
      }, config.timeoutMs)
    })
  }
}

async function connect(port) {
  const deadline = Date.now() + config.timeoutMs
  for (;;) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version')
      const info = await response.json()
      const socket = new WebSocket(info.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', () => reject(new Error('devtools websocket failed')), { once: true })
      })
      return { cdp: new Cdp(socket), socket }
    } catch {
      if (Date.now() > deadline) throw new Error('Chrome devtools endpoint never came up on port ' + port)
      await sleep(200)
    }
  }
}

/** Evaluate in the page and return the value; throws on a page-side error. */
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error('page evaluation failed: ' + detail)
  }
  return result.result.value
}

/** Poll a page-side boolean expression until it is true or the timeout runs out. */
async function waitFor(cdp, sessionId, expression, label, timeoutMs = config.timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await evaluate(cdp, sessionId, '(() => { try { return Boolean(' + expression + ') } catch { return false } })()')) return
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
    await sleep(150)
  }
}

/** Click an element the way a person does: hit-tested pointer events, not element.click(). */
/**
 * Aim at one element: scroll it in, then wait until a press at its centre would
 * actually land on it.
 *
 * A dialog's entrance animation moves a control out from under a centre that was
 * measured a frame earlier, and a press that lands on whatever is covering the
 * target is indistinguishable from a press that did nothing. Measuring,
 * hit-testing and retrying is what keeps a green run honest.
 *
 * @param selector - the element to aim at.
 * @returns the hit-tested centre.
 */
async function aim(cdp, sessionId, selector) {
  await evaluate(cdp, sessionId, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (target !== null) target.scrollIntoView({ block: 'nearest' });
    return true;
  })()`)
  const deadline = Date.now() + 4000
  for (;;) {
    await sleep(150)
    const centre = await evaluate(cdp, sessionId, `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (target === null) return null;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(hit === target || target.contains(hit) || hit.contains(target))) return null;
      return { x, y };
    })()`)
    if (centre !== null) return centre
    if (Date.now() > deadline) throw new Error('nothing clickable at ' + selector)
  }
}

async function click(cdp, sessionId, selector) {
  const centre = await aim(cdp, sessionId, selector)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, button: 'none', buttons: 0 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
}

/** Open an element's own context menu with a real right press. */
async function rightClick(cdp, sessionId, selector) {
  const centre = await aim(cdp, sessionId, selector)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, button: 'none', buttons: 0 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'right', buttons: 2, clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'right', buttons: 0, clickCount: 1 }, sessionId)
  await sleep(400)
}


/**
 * Open one Session row's own menu.
 *
 * The press is a real, hit-tested right button event; the delivery that follows
 * is not. Headless Chrome never turns a right press into `contextmenu`, so the
 * event the browser would have delivered is dispatched at the row's real
 * coordinates, on the element a person's press would have hit. Everything from
 * the shell's row handler down is therefore the shipped code.
 *
 * A blank "new Session" row opens no menu by design, which is why callers ask
 * the shell rather than assume.
 *
 * @param rowKey - the `data-row-key` of the row to open.
 */
async function openRowMenu(cdp, sessionId, rowKey) {
  const selector = '[data-row-key=' + JSON.stringify(rowKey) + ']'
  const inView = await evaluate(cdp, sessionId, `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (row === null) return false;
    row.scrollIntoView({ block: 'nearest' });
    return true;
  })()`)
  if (!inView) throw new Error('no Session row ' + rowKey)
  await sleep(250)
  await rightClick(cdp, sessionId, selector)
  await evaluate(cdp, sessionId, `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (row === null) return false;
    const rect = row.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit === null) return false;
    hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2, clientX: x, clientY: y }));
    return true;
  })()`)
  await sleep(400)
}
/** Click the Session row menu entry whose label contains `label`. */
async function clickMenuEntry(cdp, sessionId, label) {
  // Same discipline as aim(): the menu portals in, so the entry is pressed only
  // once a press at its centre would really land on it.
  const deadline = Date.now() + 4000
  for (;;) {
    await sleep(150)
    const centre = await evaluate(cdp, sessionId, `(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (item === undefined) return null;
      const rect = item.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(hit === item || item.contains(hit) || hit.contains(item))) return null;
      return { x, y };
    })()`)
    if (centre !== null) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, button: 'none', buttons: 0 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
      return
    }
    if (Date.now() > deadline) throw new Error('no menu entry labelled ' + label)
  }
}

/**
 * Click the one menu row whose label is exactly `label`.
 *
 * The shell's Session-row menu and this plugin's inline-code menu both render
 * `[role="menuitem"]` rows, and one label is a prefix of the other ("复制"
 * against "复制会话 ID"), so this matches exactly and presses the way every
 * other gesture in this script does: measure, hit-test, then press.
 *
 * @param label - the row's exact text.
 */
async function clickExactMenuEntry(cdp, sessionId, label) {
  const deadline = Date.now() + 4000
  for (;;) {
    await sleep(150)
    const centre = await evaluate(cdp, sessionId, `(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      if (item === undefined) return null;
      const rect = item.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(hit === item || item.contains(hit) || hit.contains(item))) return null;
      return { x, y };
    })()`)
    if (centre !== null) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, button: 'none', buttons: 0 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
      return true
    }
    // A row that never appears is a verdict for the caller to report: throwing
    // here aborted the whole run and hid every leg after it.
    if (Date.now() > deadline) return false
  }
}

/**
 * Find one element by expression, hit-test its centre, and press it.
 *
 * `aim()` addresses a CSS selector; the inline-code legs need "the first code
 * element this feature would claim", which is a predicate rather than a
 * selector, so the same measure-then-press discipline is applied to an
 * expression. When `contextMenu` is set, the press is followed by the
 * `contextmenu` event headless Chrome never delivers on its own, dispatched at
 * the element the press really hit.
 *
 * @param find - a page-side expression yielding the element, or null.
 * @param options.contextMenu - dispatch a `contextmenu` at the pressed element.
 * @param options.timeoutMs - how long to keep looking for something pressable.
 * @returns the pressed centre and the element's text, or null when nothing was
 * there to press.
 */
async function pressElement(cdp, sessionId, find, { contextMenu = false, timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await sleep(150)
    const centre = await evaluate(cdp, sessionId, `(() => {
      const target = ${find};
      if (!(target instanceof Element)) return null;
      // The press point is what has to be on screen, not the element: an inline code
      // is one line tall, and a press a few pixels outside the viewport hits
      // nothing at all.
      const point = (r) => ({ x: r.x + Math.min(r.width / 2, 24), y: r.y + r.height / 2 });
      const onScreen = (r) => { const p = point(r); return r.width > 0 && r.height > 0 && p.x > 0 && p.x < window.innerWidth && p.y > 0 && p.y < window.innerHeight };
      let rect = target.getBoundingClientRect();
      if (!onScreen(rect)) {
        // The element's own scrollport, scrolled directly: this leaves the element
        // placed before the next retry measures it, where a smooth or
        // shell-managed scroll would not.
        let scroller = target.parentElement;
        while (scroller !== null && !(scroller.scrollHeight > scroller.clientHeight + 4)) scroller = scroller.parentElement;
        if (scroller === null) {
          target.scrollIntoView({ block: 'center' });
        } else {
          const box = scroller.getBoundingClientRect();
          scroller.scrollTop += (rect.top - box.top) - (box.height - rect.height) / 2;
        }
        rect = target.getBoundingClientRect();
      }
      if (!onScreen(rect)) return null;
      if (rect.width === 0 || rect.height === 0) return null;
      const x = rect.x + Math.min(rect.width / 2, 24);
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(hit === target || target.contains(hit))) return null;
      return { x, y, text: target.textContent.trim() };
    })()`)
    if (centre !== null) {
      // A right press is what opens this menu; a left one would run the shell's
      // own click on the way, which is a side effect this leg must not have.
      const button = contextMenu ? 'right' : 'left'
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, button: 'none', buttons: 0 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button, buttons: contextMenu ? 2 : 1, clickCount: 1 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button, buttons: 0, clickCount: 1 }, sessionId)
      if (contextMenu) {
        await sleep(200)
        // The same point the press measured, on the element that press hit.
        await evaluate(cdp, sessionId, `(() => {
          const hit = document.elementFromPoint(${centre.x}, ${centre.y});
          if (hit === null) return false;
          hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2, clientX: ${centre.x}, clientY: ${centre.y} }));
          return true;
        })()`)
        await sleep(400)
      }
      return centre
    }
    if (Date.now() > deadline) return null
  }
}

/**
 * Open a Session whose conversation really renders inline code.
 *
 * The shell opens whatever Session was used last, and a fresh draft ("新会话")
 * renders no body at all — which is exactly how a code-element count of zero
 * turns into a false failure. So labelled rows are tried in order until the
 * rendered conversation holds at least one `code`.
 *
 * @returns `{ok, rowKey, codes}`, or `{ok: false, rows}` when none did.
 */
async function openContentSession(cdp, sessionId) {
  const rows = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('[class*="listArea"] [data-row-key^="session:"]')]
    .map((row) => ({ key: row.dataset.rowKey, label: (row.innerText || '').trim() })))()`)
  const candidates = rows.filter((row) => row.label !== '' && !row.label.includes('新会话'))
  const tried = []
  // Two rounds: a long conversation can take seconds to render, and a first
  // attempt that runs out of patience is worth one retry before it is called a
  // missing body.
  for (let round = 0; round < 2; round += 1) {
    for (const row of candidates) {
      try {
        await click(cdp, sessionId, '[data-row-key=' + JSON.stringify(row.key) + ']')
      } catch {
        continue
      }
      try {
        const count = 'document.querySelectorAll("code").length'
        await waitFor(cdp, sessionId, count + ' > 0', 'inline code in ' + row.key, 20000)
        // The poll can be satisfied by a body that then re-renders to zero — the
        // shell swaps transcript views while a Session settles, and a run that
        // trusted the poll's verdict read "0 code elements" off a body it had
        // just declared ready. So the count is read back, not assumed.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const codes = await evaluate(cdp, sessionId, count)
          if (codes > 0) return { ok: true, rowKey: row.key, codes }
          await sleep(500)
        }
        if (!tried.includes(row.key)) tried.push(row.key)
      } catch {
        // The next row may be the one with a body; a row that never renders one
        // is not an error, it is the reason this loop exists.
        if (!tried.includes(row.key)) tried.push(row.key)
      }
    }
  }
  return { ok: false, rows: tried }
}

/**
 * Open a Session whose transcript ends with a 已编辑 N 个文件 card.
 *
 * The same reason `openContentSession` exists: the shell opens whatever Session
 * was used last, and only a turn that really changed files renders the card this
 * feature hangs its menu on. A Session whose card was never recorded — the Host
 * restarted since — shows none, so labelled rows are tried until one does.
 *
 * @returns `{ok, rowKey, rows}`, or `{ok: false, rows}` when none did.
 */
async function openChangedFilesSession(cdp, sessionId) {
  const rows = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('[class*="listArea"] [data-row-key^="session:"]')]
    .map((row) => ({ key: row.dataset.rowKey, label: (row.innerText || '').trim() })))()`)
  const candidates = rows.filter((row) => row.label !== '' && !row.label.includes('新会话'))
  const tried = []
  for (const row of candidates) {
    try {
      await click(cdp, sessionId, '[data-row-key=' + JSON.stringify(row.key) + ']')
    } catch {
      continue
    }
    const expression = `document.querySelectorAll('[data-changed-files] button[aria-describedby]').length`
    try {
      await waitFor(cdp, sessionId, expression + ' > 0', 'a changed-files card in ' + row.key, 8000)
      const count = await evaluate(cdp, sessionId, expression)
      if (count > 0) return { ok: true, rowKey: row.key, rows: count }
    } catch {
      // The next row may be the one with a card; a row without one is the reason
      // this loop exists.
    }
    if (!tried.includes(row.key)) tried.push(row.key)
  }
  return { ok: false, rows: tried }
}

/**
 * Wait for exactly `count` menus to be on screen, and report how many are.
 *
 * A menu is React state, not a synchronous consequence of the press: reading
 * the count once a fixed sleep later is how a passing run and a failing one get
 * told apart by timing. This never throws — the caller reports the number.
 *
 * @returns the number of menus on screen after the wait.
 */
async function settleMenus(cdp, sessionId, count, timeoutMs = 5000) {
  try {
    await waitFor(cdp, sessionId, `document.querySelectorAll('[role="menu"]').length === ${count}`, count + ' menus', timeoutMs)
  } catch { /* the read-back below is the report */ }
  return evaluate(cdp, sessionId, `document.querySelectorAll('[role="menu"]').length`)
}

/** Read the inline-code preference off the 心流 page's fourth row. */
async function codeMenuSwitchState(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const node = document.querySelector(${JSON.stringify(CODE_MENU_SWITCH)});
    return node === null ? null : node.getAttribute('aria-checked');
  })()`)
}

/**
 * Drive the inline-code switch to `want` on the already-open 心流 page.
 *
 * The write is a Host round trip, so the switch is waited for instead of read
 * after a guessed sleep; the answer says whether the preference really moved.
 *
 * @returns whether the switch reads back as `want`.
 */
async function setCodeMenu(cdp, sessionId, want) {
  return pressFlowSwitch(cdp, sessionId, CODE_MENU_SWITCH, want)
}

/** Read one 心流 switch's `aria-checked`, or null when its row is not on screen. */
async function flowSwitchState(cdp, sessionId, selector) {
  return evaluate(cdp, sessionId, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return node === null ? null : node.getAttribute('aria-checked');
  })()`)
}

/**
 * Press one 心流 switch until it reads back as `want`.
 *
 * A preference write is a Host round trip. Two facts measured on a live instance
 * shape the bounds below: the new value can land several seconds after the press
 * (a switch read back `false` for a whole 8s wait and showed the new value on
 * the next read), and a press that lands while the form is still settling is
 * simply lost. So the press is retried on a bounded wait instead of being trusted
 * once — a switch that really refuses still reads back wrong after every attempt,
 * and the caller reports that as the failure it is.
 *
 * @returns whether the switch reads back as `want`.
 */
async function pressFlowSwitch(cdp, sessionId, selector, want) {
  const quoted = JSON.stringify(selector)
  const settled = `(() => { const node = document.querySelector(${quoted}); return node !== null && node.getAttribute('aria-checked') === ${JSON.stringify(want)} })()`
  const pressable = `(() => { const node = document.querySelector(${quoted}); return node !== null && node.disabled === false })()`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await flowSwitchState(cdp, sessionId, selector) === want) return true
    await waitFor(cdp, sessionId, pressable, 'the switch to become pressable', 4000).catch(() => { /* the press below is the next try */ })
    try {
      await click(cdp, sessionId, selector)
    } catch {
      // Nothing hit-testable yet; the next attempt waits again.
    }
    await waitFor(cdp, sessionId, settled, 'the preference to settle at ' + want, 12000).catch(() => { /* the read-back below reports it */ })
  }
  return await flowSwitchState(cdp, sessionId, selector) === want
}

/** Read the send-key preference off the 心流 page's fifth row. */
async function modEnterSwitchState(cdp, sessionId) {
  return flowSwitchState(cdp, sessionId, MOD_ENTER_SWITCH)
}

/**
 * Drive the send-key switch to `want` on the already-open 心流 page.
 *
 * Same discipline as the inline-code switch: the write is a Host round trip, so
 * the answer is waited for rather than read after a guessed sleep.
 *
 * Two facts measured on a live instance shape the bounds below: a preference
 * write can land several seconds after the press (the switch read back `false`
 * for the whole of an 8s wait and then showed the new value on the next read),
 * and a press that lands while the form is still settling is simply lost. So the
 * press is retried on the same bounded wait instead of being trusted once — a
 * switch that really refuses still reads back wrong after all three tries, and
 * the caller reports that as the failure it is.
 *
 * @returns whether the switch reads back as `want`.
 */
async function setModEnter(cdp, sessionId, want) {
  return pressFlowSwitch(cdp, sessionId, MOD_ENTER_SWITCH, want)
}

/** What the composer currently holds, and whether it would take a keystroke. */
async function composerState(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const node = document.querySelector('[data-composer-input]');
    if (node === null) return null;
    return {
      editable: node.getAttribute('contenteditable'),
      focused: document.activeElement === node || node.contains(document.activeElement),
      text: node.innerText,
    };
  })()`)
}

/** Press the composer like a person, and wait for it to really hold focus. */
async function focusComposer(cdp, sessionId) {
  await click(cdp, sessionId, '[data-composer-input]')
  await waitFor(
    cdp,
    sessionId,
    `(() => { const n = document.querySelector('[data-composer-input]'); return n !== null && (document.activeElement === n || n.contains(document.activeElement)) })()`,
    'the composer to take focus',
    6000,
  ).catch(() => { /* the assertions below report what they see */ })
}

/**
 * Bring up a composer that really accepts a keystroke.
 *
 * The shell can open on the no-Session state, whose composer is mounted but
 * inert; any Session row brings an editable one back. Labelled rows are tried
 * first because they are the ones a person would click.
 *
 * @returns whether an editable composer is on screen.
 */
async function ensureEditableComposer(cdp, sessionId) {
  const editable = `(() => { const n = document.querySelector('[data-composer-input]'); return n !== null && n.getAttribute('contenteditable') === 'true' })()`
  if (await evaluate(cdp, sessionId, editable)) return true
  const rows = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('[class*="listArea"] [data-row-key^="session:"]')]
    .map((row) => ({ key: row.dataset.rowKey, label: (row.innerText || '').trim() })))`)
  const candidates = rows.filter((row) => row.label !== '' && !row.label.includes('新会话')).concat(rows)
  for (const row of candidates) {
    try {
      await click(cdp, sessionId, '[data-row-key=' + JSON.stringify(row.key) + ']')
    } catch {
      continue
    }
    try {
      await waitFor(cdp, sessionId, editable, 'an editable composer for ' + row.key, 8000)
      return true
    } catch { /* the next row may be the one that opens an editable composer */ }
  }
  return false
}

/**
 * Stand in for the host clipboard, recording what a copy actually wrote.
 *
 * A headless page has no clipboard permission, and the write path is the
 * shipped `writeClipboard`, which prefers `navigator.clipboard.writeText`; the
 * record is therefore the copy's real payload rather than a mock's echo.
 */
async function stubClipboard(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__copied = text } },
    });
    return true;
  })()`)
}

/**
 * Wait for the copy preference's switch to read back as `expected`.
 *
 * The write is a Host round trip, so the switch is polled instead of read once
 * after a fixed sleep; running out of patience is not an error here, because the
 * assertion that follows reports what the switch actually says.
 *
 * @param expected - the `aria-checked` value to wait for.
 */
async function settled(cdp, sessionId, expected) {
  const expression = '(() => { const n = document.querySelector(' + JSON.stringify('[role="dialog"] .flow-row:nth-child(2) [role="switch"]') + '); return n !== null && n.getAttribute("aria-checked") === ' + JSON.stringify(expected) + ' })()'
  try {
    await waitFor(cdp, sessionId, expression, 'the copy preference to settle at ' + expected, 8000)
  } catch {
    // Report through the assertion that follows, with the row's own error text.
  }
}

/** Put the copy preference back on, whatever a previous run left behind. */
async function ensureCopyOn(cdp, sessionId) {
  await openFlowTab(cdp, sessionId)
  const checked = await evaluate(cdp, sessionId, '(() => { const n = document.querySelector(' + JSON.stringify('[role="dialog"] .flow-row:nth-child(2) [role="switch"]') + '); return n === null ? null : n.getAttribute("aria-checked") })()')
  if (checked !== 'true') {
    await click(cdp, sessionId, '[role="dialog"] .flow-row:nth-child(2) [role="switch"]')
    await settled(cdp, sessionId, 'true')
  }
  await pressEscape(cdp, sessionId)
}

/**
 * Answer the plugin open routes inside the page, and record every call.
 *
 * Letting one through would launch this machine's default browser mid-run, so
 * both routes are answered locally. Recording the route as well as the body is
 * what makes "which plugin took this click" an assertion instead of a guess: a
 * second plugin that opens external links may still be installed beside this
 * one, and its calls must not be mistaken for this plugin's.
 */
async function stubOpenRoutes(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    window.__openCalls = [];
    if (window.__openRoutesStubbed === true) return true;
    const real = window.fetch.bind(window);
    const answer = (route, init) => {
      window.__openCalls.push({ route, body: init?.body ?? null });
      return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (url.endsWith('/flow/open-external') || url.endsWith('/external-link/open')) return answer(url, init);
      return real(input, init);
    };
    window.__openRoutesStubbed = true;
    return true;
  })()`)
}

/**
 * Put the two probe anchors on the page, above everything else.
 *
 * One is off-origin (the case the feature owns), one is same-origin (the case it
 * must never take). A bubble-phase guard prevents any navigation nothing else
 * prevented, so a leg where both plugins decline the click still cannot move the
 * page off the application.
 */
async function installProbeAnchors(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    for (const stale of document.querySelectorAll('[data-flow-probe]')) stale.remove();
    const make = (key, href, bottom) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.dataset.flowProbe = key;
      anchor.textContent = 'flow probe ' + key;
      anchor.style.cssText = 'position:fixed;left:8px;bottom:' + bottom + 'px;z-index:2147483647;'
        + 'background:#fff;color:#000;padding:2px 6px;font:12px monospace';
      document.body.appendChild(anchor);
    };
    make('off-origin', 'http://127.0.0.1:9/flow-probe', 8);
    make('same-origin', location.origin + '/flow-probe-same-origin', 40);
    if (window.__flowProbeGuard !== true) {
      document.addEventListener('click', (event) => {
        const anchor = event.target?.closest?.('[data-flow-probe]');
        if (anchor !== null && anchor !== undefined) event.preventDefault();
      }, false);
      window.__flowProbeGuard = true;
    }
    return true;
  })()`)
}

/** Take the probe anchors back off the page. */
async function removeProbeAnchors(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    for (const stale of document.querySelectorAll('[data-flow-probe]')) stale.remove();
    return true;
  })()`)
}

/** Every call the two open routes have taken so far. */
const OPEN_PROBE = `(() => ({ calls: (window.__openCalls ?? []).map((call) => ({ route: call.route, body: call.body })) }))()`

/** What the copy surfaces look like right now. */
const COPY_PROBE = `(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  const copyItem = items.find((b) => b.textContent.includes('复制会话 ID'));
  return {
    menuItems: items.map((b) => b.textContent),
    copyItem: copyItem !== undefined,
    // The row's key hint is its own span; the leading icon is hidden from
    // assistive technology and would answer an aria-hidden query first.
    copyHint: copyItem?.querySelector('[class*="shortcut"]')?.textContent ?? null,
    alerts: [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent),
    copied: window.__copied ?? null,
    sectionTitles: [...document.querySelectorAll('[role="dialog"] .flow-row__title')].map((n) => n.textContent),
    switches: [...document.querySelectorAll('[role="dialog"] [role="switch"]')].map((n) => n.getAttribute('aria-checked')),
    rowErrors: [...document.querySelectorAll('[role="dialog"] .flow-row')].map((n) => n.querySelector('.flow-row__error')?.textContent ?? null),
  };
})()`

/**
 * Page-side predicate: a copy notice is on screen right now.
 *
 * The panel's own warnings use the same role, so the sentence is part of the
 * predicate rather than the role alone.
 */
const NOTICE_VISIBLE = `[...document.querySelectorAll('[role="alert"]')].some((n) => n.textContent.includes('已复制会话 ID'))`

/**
 * The inline `code` elements this feature claims, in the shell's own DOM.
 *
 * A file mention — the inline code a left click opens — is `code > button`;
 * everything else is plain text. Anchors, fenced blocks and codes outside a
 * markdown body are never claimed, so no finder below returns one.
 */
const CODE_CLAIM = {
  mention: 'c.querySelector("button") !== null',
  plain: 'c.querySelector("button") === null && c.querySelector("a") === null',
}

/**
 * The expression that finds one inline `code` this feature claims.
 *
 * A code already inside the viewport wins over one further up the transcript:
 * scrolling the transcript is not free — the shell pages older turns in as it
 * scrolls and re-renders the nodes underneath — and a right-click in real use
 * lands on what is on screen anyway. The first claimed code is the fallback
 * for a viewport that holds none.
 */
const codeFinder = (kind) => `(() => {
  const claimed = [...document.querySelectorAll("code")].filter((c) => c.closest("pre") === null && c.closest("a[href]") === null && c.closest("[contenteditable]") === null && c.closest("[class*=\'_markdown_\']") !== null && (${CODE_CLAIM[kind]}));
  const pressable = claimed.filter((c) => {
    const r = c.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const x = r.x + Math.min(r.width / 2, 24);
    const y = r.y + r.height / 2;
    return x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight;
  });
  if (pressable.length > 0) return pressable[0];
  // Nothing under the pointer right now: hand back the claimed code closest to
  // the middle of the viewport, which is the one a scroll has to travel least to
  // reach.
  const middle = window.innerHeight / 2;
  return claimed.slice().sort((a, b) => {
    const da = Math.abs(a.getBoundingClientRect().top + a.getBoundingClientRect().height / 2 - middle);
    const db = Math.abs(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2 - middle);
    return da - db;
  })[0] ?? null;
})()`

/** What the inline-code menu surfaces look like right now. */
const CODE_PROBE = `(() => {
  const labelled = (label) => [...document.querySelectorAll('[role="menuitem"]')].some((n) => n.textContent.trim() === label);
  return {
    codes: document.querySelectorAll('code').length,
    menus: document.querySelectorAll('[role="menu"]').length,
    items: [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent.trim()),
    openItem: labelled('打开'),
    copyItem: labelled('复制'),
    copied: window.__copied ?? null,
    clicks: (window.__codeClicks ?? []).slice(),
    alerts: [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent),
    sectionTitles: [...document.querySelectorAll('[role="dialog"] .flow-row__title')].map((n) => n.textContent),
    switches: [...document.querySelectorAll('[role="dialog"] [role="switch"]')].map((n) => n.getAttribute('aria-checked')),
    rowErrors: [...document.querySelectorAll('[role="dialog"] .flow-row')].map((n) => n.querySelector('.flow-row__error')?.textContent ?? null),
  };
})()`

/**
 * Why an inline code could not be pressed: what exists, and what is in the way.
 *
 * Included in the failure messages so the next red run says "nothing was found"
 * or "something covered it" instead of only "nothing happened".
 */
const CODE_DIAGNOSTICS = `(() => {
  const claimed = [...document.querySelectorAll('code')].filter((c) => c.closest('pre') === null && c.closest('[class*="_markdown_"]') !== null);
  const at = (c) => {
    const r = c.getBoundingClientRect();
    const x = Math.round(r.x + Math.min(r.width / 2, 24));
    const y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: Math.round(r.width), inside: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
      hit: hit === null ? null : (hit === c ? "code" : (c.contains(hit) ? "inside-code" : hit.tagName + (typeof hit.className === "string" && hit.className ? "." + String(hit.className).slice(0, 20) : ""))) };
  };
  let scroller = claimed[0] ?? null;
  while (scroller !== null && !(scroller.scrollHeight > scroller.clientHeight + 4)) scroller = scroller.parentElement;
  const conversation = document.querySelector('[slot="conversation.view"]');
  return {
    codes: document.querySelectorAll('code').length,
    claimed: claimed.length,
    viewport: [window.innerWidth, window.innerHeight],
    pressable: claimed.filter((c) => { const i = at(c); return i.inside }).length,
    pressablePlain: claimed.filter((c) => at(c).inside && c.querySelector("button") === null && c.querySelector("a") === null).length,
    pressableMention: claimed.filter((c) => at(c).inside && c.querySelector("button") !== null).length,
    first: claimed.length === 0 ? null : at(claimed[0]),
    scroller: scroller === null ? null : { scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    conversationRect: conversation === null ? null : { x: Math.round(conversation.getBoundingClientRect().x), w: Math.round(conversation.getBoundingClientRect().width) },
  };
})()`

/** The changed-file row this feature claims: the card's own file button. */
const CHANGED_FILE_FINDER = `(() => {
  const rows = [...document.querySelectorAll('[data-changed-files] button[aria-describedby]')];
  const pressable = rows.filter((b) => {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    return x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight;
  });
  return (pressable[0] ?? rows[0]) ?? null;
})()`

/** What the changed-file menu and the card it hangs from look like right now. */
const CHANGED_FILES_PROBE = `(() => {
  const rows = [...document.querySelectorAll('[data-changed-files] button[aria-describedby]')];
  const first = rows[0] ?? null;
  const described = first === null ? null : (() => {
    const id = String(first.getAttribute('aria-describedby') || '').trim().split(' ')[0];
    const node = id === '' ? null : document.getElementById(id);
    return node === null ? null : node.textContent.trim();
  })();
  const anchor = document.querySelector('[data-flow-changes-path]');
  return {
    cards: document.querySelectorAll('[data-changed-files]').length,
    rows: rows.length,
    menus: document.querySelectorAll('[role="menu"]').length,
    items: [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent.trim()),
    path: anchor === null ? null : anchor.getAttribute('data-flow-changes-path'),
    described,
  };
})()`


/** The 心流 page's fourth row: the inline-code menu switch. */
const CODE_MENU_SWITCH = '[role="dialog"] .flow-row:nth-child(4) [role="switch"]'

/** The 心流 page's fifth row: the changed-file menu switch. */
const CHANGES_FILE_SWITCH = '[role="dialog"] .flow-row:nth-child(5) [role="switch"]'

/** The 心流 page's sixth row: the swapped send key. */
const MOD_ENTER_SWITCH = '[role="dialog"] .flow-row:nth-child(6) [role="switch"]'

/**
 * Wait until one element's box has stopped moving.
 *
 * A dialog slides in. A press measured mid-animation lands where the control no
 * longer is, which is indistinguishable from a control that does nothing — the
 * exact shape of the "the copy preference did not come back" red herring. The
 * caller wants the layout to be still before anything measures it.
 *
 * @param selector - the element whose box must settle.
 * @returns its last measured box, even if the wait ran out.
 */
async function waitForStill(cdp, sessionId, selector) {
  const expression = `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
  })()`
  let previous = null
  const deadline = Date.now() + 4000
  for (;;) {
    const box = await evaluate(cdp, sessionId, expression)
    if (box !== null && previous !== null
      && box.x === previous.x && box.y === previous.y && box.w === previous.w && box.h === previous.h) {
      return box
    }
    previous = box
    if (Date.now() > deadline) return box
    await sleep(150)
  }
}

/**
 * Open 设置 → 心流 and wait for its body.
 *
 * The close path is a fade-out, not an unmount: a settings button pressed while
 * the previous dialog is still going away closes the *new* one, and the body it
 * leaves behind for a few frames is enough for every wait below to pass while
 * the next press lands on a node React is about to remove. So a leftover dialog
 * is dismissed first, and the one that opens has to stop moving before this
 * returns.
 */
async function openFlowTab(cdp, sessionId) {
  if (await evaluate(cdp, sessionId, 'document.querySelector(\'[role="dialog"]\') !== null')) {
    await pressEscape(cdp, sessionId)
    await waitFor(cdp, sessionId, 'document.querySelector(\'[role="dialog"]\') === null', 'the previous settings dialog to close').catch(() => {})
  }
  await click(cdp, sessionId, '[data-slot="sidebar.settings"] button')
  await waitFor(cdp, sessionId, 'document.querySelector(\'[role="dialog"] nav button\') !== null', 'the settings dialog')
  const centre = await evaluate(cdp, sessionId, `(() => {
    const tab = [...document.querySelectorAll('[role="dialog"] nav button')].find((b) => b.textContent === '心流');
    if (tab === undefined) return null;
    const rect = tab.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`)
  if (centre === null) throw new Error('no 心流 tab in the settings navigation')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, button: 'none', buttons: 0 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
  await waitFor(cdp, sessionId, 'document.querySelector(\'[role="dialog"] .flow-row__title\') !== null', 'the 心流 page body')
  await waitForStill(cdp, sessionId, '[role="dialog"] .flow-row__title')
}

/** The call every plugin's browser half makes to register itself. */
const REGISTRATION = 'window.__ModuleLoader__.load('

/** The separator the bundle puts between two plugin segments. */
const SEPARATOR = '\n;\n'

/**
 * Swap one plugin's browser half inside a combined plugin bundle.
 *
 * A segment is bounded by its own registration call and by the separator that
 * closes it, never by a byte count: the instance wraps the modules it installed
 * from a registry but serves a locally linked package verbatim, so both shapes
 * have to be found the same way.
 *
 * @param body - the combined bundle the instance served.
 * @param id - the plugin row id whose segment to replace.
 * @param source - the replacement browser half.
 * @returns the bundle with exactly that segment replaced.
 */
function replaceSegment(body, id, source) {
  const marks = ["id: '" + id + "'", 'id: "' + id + '"', "id:'" + id + "'", 'id:"' + id + '"']
  const hit = marks.filter((mark) => body.includes(mark))
  if (hit.length !== 1) throw new Error('no single ' + id + ' registration in the bundle')
  const at = body.indexOf(hit[0])
  const loadAt = body.lastIndexOf(REGISTRATION, at)
  const nextAt = body.indexOf(REGISTRATION, at)
  if (loadAt === -1 || nextAt === -1) throw new Error('malformed ' + id + ' segment')
  const found = body.lastIndexOf(SEPARATOR, nextAt)
  const end = found === -1 || found < loadAt ? nextAt : found + SEPARATOR.length
  const fromLoad = source.slice(source.indexOf(REGISTRATION)).replace(/\s+$/u, '')
  if (fromLoad === '') throw new Error('the replacement for ' + id + ' has no registration call')
  return body.slice(0, loadAt) + fromLoad + SEPARATOR + body.slice(end)
}

async function shoot(cdp, sessionId, name) {
  if (config.shots === null) return
  mkdirSync(config.shots, { recursive: true })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(join(config.shots, name), Buffer.from(data, 'base64'))
}

/** Everything the assertions read, in one page-side round trip. */
const PROBE = `(() => {
  const search = document.querySelector('[class*="searchSlot"]');
  const host = document.querySelector('[data-flow-host="locate"]');
  const seatOf = () => {
    const row = document.querySelector('[data-row-key^="session:"]');
    let node = row;
    while (node && !(node.scrollHeight > node.clientHeight + 4)) node = node.parentElement;
    return node;
  };
  const boxOf = (key) => {
    const row = document.querySelector('[data-row-key="' + key + '"]');
    const seat = document.querySelector('[class*="listArea"]');
    if (!row || !seat) return null;
    const r = row.getBoundingClientRect();
    const s = seat.getBoundingClientRect();
    return { visible: r.bottom > s.top && r.top < s.bottom, top: Math.round(r.top), seatTop: Math.round(s.top), seatBottom: Math.round(s.bottom) };
  };
  const groups = {};
  for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
    groups[row.dataset.rowKey] = row.getAttribute('aria-expanded');
  }
  return {
    current: document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.dataset.rowKey ?? null,
    rowKeys: [...document.querySelectorAll('[class*="listArea"] [data-row-key]')].map((e) => e.dataset.rowKey),
    groups,
    hostExists: host !== null,
    hostAfterSearch: host !== null && search !== null && search.nextElementSibling === host,
    buttonLabel: host?.querySelector('button')?.getAttribute('aria-label') ?? null,
    buttonCount: document.querySelectorAll('.flow-locate').length,
    flowNav: [...document.querySelectorAll('[role="dialog"] nav button')].map((b) => b.textContent),
    dialog: document.querySelector('[role="dialog"]') !== null,
    sectionTitle: document.querySelector('[role="dialog"] .flow-row__title')?.textContent ?? null,
    switchChecked: document.querySelector('[role="dialog"] [role="switch"]')?.getAttribute('aria-checked') ?? null,
    status: document.querySelector('.flow-host [role="status"]')?.textContent ?? null,
  };
})()`

const box = (cdp, sessionId, key) => evaluate(cdp, sessionId, `(() => {
  const row = document.querySelector('[data-row-key=${JSON.stringify(key)}]');
  const seat = document.querySelector('[class*="listArea"]');
  if (!row || !seat) return null;
  const r = row.getBoundingClientRect();
  const s = seat.getBoundingClientRect();
  return { visible: r.bottom > s.top && r.top < s.bottom, top: Math.round(r.top), seatTop: Math.round(s.top), seatBottom: Math.round(s.bottom) };
})()`)

/** Restore every Workspace group to the fold state recorded before the run. */
async function restoreGroups(cdp, sessionId, groups) {
  await evaluate(cdp, sessionId, `(() => {
    const before = ${JSON.stringify(groups)};
    for (const [key, state] of Object.entries(before)) {
      const row = document.querySelector('[data-row-key="' + key + '"]');
      if (row && row.getAttribute('aria-expanded') !== state) row.click();
    }
    return true;
  })()`)
  await sleep(500)
}

/** Open every folded Workspace group, so the list becomes long enough to scroll. */
async function openEveryGroup(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
      if (row.getAttribute('aria-expanded') === 'false') row.click();
    }
    return true;
  })()`)
  await sleep(1200)
}

/**
 * Park one row strictly above the list seat, so it has to be scrolled back.
 *
 * The delta comes from the two boxes rather than a guessed offset, so it holds
 * at any list length.
 */
async function pushRowAboveSeat(cdp, sessionId, rowKey) {
  return evaluate(cdp, sessionId, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-row-key="${rowKey}"]`)});
    let seat = row;
    while (seat && !(seat.scrollHeight > seat.clientHeight + 4)) seat = seat.parentElement;
    if (!row || !seat) return false;
    const r = row.getBoundingClientRect();
    const s = seat.getBoundingClientRect();
    seat.scrollTop += (r.bottom - s.top) + 40;
    return true;
  })()`)
}

/** Press Escape the way the keyboard does; the shell's modals listen for it. */
async function pressEscape(cdp, sessionId) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId)
  await sleep(400)
}

/** Press one shortcut with its modifier bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8). */
async function pressShortcut(cdp, sessionId, { key, code, virtualKeyCode, modifiers }) {
  const base = { modifiers, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId)
  await sleep(300)
}

/** The Workspace group whose row precedes this Session row in the shipped row order. */
function ownerOf(rowKeys, current) {
  const at = rowKeys.indexOf(current)
  if (at === -1) return null
  for (let index = at - 1; index >= 0; index -= 1) {
    if (rowKeys[index].startsWith('workspace:')) return rowKeys[index]
  }
  return null
}

/**
 * Stop the throwaway Chrome and delete its profile.
 *
 * A bare kill plus one removal is not enough: the profile is still being written
 * while the process dies, so the removal can lose the race and throw ENOTEMPTY —
 * and a throw from the `finally` block replaces whatever the run was actually
 * reporting, turning a green run into a crash and hiding the verdict when the
 * output is piped. Waiting for the exit, retrying, and never throwing keeps the
 * report the report's own.
 *
 * @param chrome - the spawned Chrome child process.
 * @param profile - its throwaway user-data directory.
 */
async function shutdown(chrome, profile) {
  if (chrome.exitCode === null) chrome.kill('SIGKILL')
  const deadline = Date.now() + 10000
  while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < deadline) {
    await sleep(100)
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true })
      return
    } catch {
      await sleep(200)
    }
  }
  console.log('  NOTE  could not remove the throwaway Chrome profile: ' + profile)
}

async function main() {
  const credentialsPath = join(config.home, '.credentials.yaml')
  if (!existsSync(credentialsPath)) throw new Error('DSH home has no .credentials.yaml: ' + credentialsPath)
  if (!existsSync(config.chrome)) throw new Error('Chrome not found; pass --chrome <path>')
  const cookie = sessionCookie(config.url, readBrowserSessionSecret(readFileSync(credentialsPath, 'utf8')))

  const profile = mkdtempSync(join(tmpdir(), 'dsh-flow-verify-'))
  const port = 9222 + Math.floor(Math.random() * 500)
  const chrome = spawn(config.chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    '--lang=zh-CN',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' })

  let socket
  try {
    const connection = await connect(port)
    const { cdp } = connection
    socket = connection.socket
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    if (config.client !== null) {
      const source = readFileSync(config.client, 'utf8')
      // The instance serves every client half inside one combined bundle, so
      // the override is a rewrite of that response, never of the request: the
      // page keeps loading exactly the URLs it asked for.
      cdp.on('Fetch.requestPaused', async (params, session) => {
        const { requestId, request } = params
        try {
          if (!request.url.includes('dsh-flow/client.js') || !request.url.includes(',')) {
            await cdp.send('Fetch.continueRequest', { requestId }, session)
            return
          }
          const response = await fetch(request.url, { headers: { cookie: cookie.name + '=' + cookie.value } })
          const body = await response.text()
          await cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'text/javascript; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' },
            ],
            body: Buffer.from(replaceSegment(body, 'dsh-flow', source)).toString('base64'),
          }, session)
        } catch (error) {
          fail('the --client override could not be served: ' + error.message)
          await cdp.send('Fetch.continueRequest', { requestId }, session).catch(() => {})
        }
      })
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*client.js*' }] }, sessionId)
    }
    await cdp.send('Emulation.setLocaleOverride', { locale: 'zh-CN' }, sessionId)
    await cdp.send('Network.setCookie', {
      name: cookie.name, value: cookie.value, url: config.url, path: '/', httpOnly: true, sameSite: 'Strict',
    }, sessionId)
    await cdp.send('Page.navigate', { url: config.url + '/' }, sessionId)
    await waitFor(cdp, sessionId, 'document.readyState === "complete"', 'document load')
    await waitFor(cdp, sessionId, 'document.querySelector(\'[data-flow-host="locate"]\') !== null', 'the locate container')
    pass('signed browser session accepted at ' + config.url)

    // ---- the open route, over HTTP --------------------------------------
    // None of these probes reaches the platform opener: a GET is not the
    // method, an unauthenticated call is fenced, and a file:// URL is refused
    // before the opener is consulted. A valid URL is deliberately never posted
    // here — that would launch this machine's default browser.
    //
    // "Is the route even mounted" is asked with an authenticated GET. An
    // unmounted path is answered by the SPA fallback — 404 for a GET and a bare
    // 405 for anything else — so the mounted route's own 405 with
    // `allow: POST` is the only positive signal; a POST probe cannot tell the
    // two apart, because both answer 405 when unauthenticated.
    const probeRoute = async (init) => {
      const response = await fetch(config.url + '/flow/open-external', init)
      return { status: response.status, allow: response.headers.get('allow') }
    }
    const mounted = await probeRoute({ method: 'GET', headers: { cookie: cookie.name + '=' + cookie.value } })
    if (mounted.status === 404) {
      skip('the open route is not mounted here: the Host half this instance activated predates it')
    } else if (mounted.status === 405 && mounted.allow === 'POST') {
      pass('the open route answers POST only (405, allow: POST)')
      const unauthenticated = await probeRoute({ method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) })
      if (unauthenticated.status === 401) pass('the open route refuses an unauthenticated call (401)')
      else fail('the open route answered an unauthenticated POST with ' + unauthenticated.status)
      const badScheme = await probeRoute({
        method: 'POST',
        headers: { cookie: cookie.name + '=' + cookie.value, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'file:///etc/passwd' }),
      })
      if (badScheme.status === 400) pass('the open route refuses a scheme the opener must not receive (400)')
      else fail('the open route answered a file:// URL with ' + badScheme.status)
    } else {
      fail('unexpected answer from the open route: ' + JSON.stringify(mounted))
    }

    // The list, and the main column's own reference to one of its rows, arrive
    // after the region mounts: locating needs both.
    await waitFor(
      cdp,
      sessionId,
      'document.querySelector(\'[data-row-key^="session:"][aria-selected="true"]\') !== null',
      'the current Session row',
    )

    // ---- placement ------------------------------------------------------
    let state = await evaluate(cdp, sessionId, PROBE)
    if (state.hostAfterSearch && state.buttonCount === 1 && state.buttonLabel === '定位当前会话') {
      pass('button container sits immediately right of the search seat, labelled 定位当前会话')
    } else {
      fail('placement wrong: ' + JSON.stringify({
        hostAfterSearch: state.hostAfterSearch, buttons: state.buttonCount, label: state.buttonLabel,
      }))
    }
    await shoot(cdp, sessionId, 'header.png')

    const current = state.current
    const owner = current === null ? null : ownerOf(state.rowKeys, current)
    if (current === null || owner === null) {
      fail('no current Session row (or its owning group) to locate: ' + JSON.stringify({ current, owner }))
    } else {
      const baseline = state.groups

      // ---- A. a row scrolled out of the seat comes back ------------------
      await openEveryGroup(cdp, sessionId)
      await pushRowAboveSeat(cdp, sessionId, current)
      await sleep(400)
      const away = await box(cdp, sessionId, current)
      if (away !== null && away.visible === false) {
        await shoot(cdp, sessionId, 'scrolled-away.png')
        await click(cdp, sessionId, '.flow-locate')
        await sleep(300)
        const animating = await evaluate(cdp, sessionId, `(() => {
          const row = document.querySelector('[data-row-key=${JSON.stringify(current)}]');
          return row === null ? -1 : row.getAnimations().length;
        })()`)
        await sleep(900)
        const back = await box(cdp, sessionId, current)
        const after = await evaluate(cdp, sessionId, PROBE)
        if (back !== null && back.visible === true) pass('a row scrolled out of the seat is scrolled back into view')
        else fail('row still out of view after locate: ' + JSON.stringify({ away, back }))
        if (animating > 0) pass('the located row is flashed (' + animating + ' animation)')
        else fail('no flash animation on the located row')
        if (after.status === '已定位到当前会话') pass('the live region reports 已定位到当前会话')
        else fail('unexpected live-region text: ' + JSON.stringify(after.status))
        await shoot(cdp, sessionId, 'located.png')
      } else {
        fail('could not push the current row out of the seat to test the scroll leg: ' + JSON.stringify(away))
      }
      await restoreGroups(cdp, sessionId, baseline)

      // ---- B. a folded owning group is opened first ----------------------
      await evaluate(cdp, sessionId, `(() => { document.querySelector('[data-row-key=${JSON.stringify(owner)}]').click(); return true })()`)
      await sleep(500)
      const folded = await evaluate(cdp, sessionId, `(() => ({
        expanded: document.querySelector('[data-row-key=${JSON.stringify(owner)}]').getAttribute('aria-expanded'),
        rendered: document.querySelector('[data-row-key=${JSON.stringify(current)}]') !== null,
      }))()`)
      if (folded.expanded === 'false' && folded.rendered === false) {
        await click(cdp, sessionId, '.flow-locate')
        await sleep(1400)
        const opened = await evaluate(cdp, sessionId, `(() => ({
          expanded: document.querySelector('[data-row-key=${JSON.stringify(owner)}]')?.getAttribute('aria-expanded') ?? null,
        }))()`)
        const revealed = await box(cdp, sessionId, current)
        if (opened.expanded === 'true' && revealed !== null && revealed.visible === true) {
          pass('a folded owning Workspace group is opened, and its row is then shown')
        } else {
          fail('folded group was not opened: ' + JSON.stringify({ folded, opened, revealed }))
        }
        await shoot(cdp, sessionId, 'unfolded.png')
      } else {
        fail('could not fold the owning group: ' + JSON.stringify(folded))
      }
      await restoreGroups(cdp, sessionId, baseline)
      const restored = await evaluate(cdp, sessionId, PROBE)
      const drifted = Object.entries(baseline).filter(([key, value]) => restored.groups[key] !== value)
      if (drifted.length === 0) pass('every Workspace group is back in its original fold state')
      else fail('group fold state drifted: ' + JSON.stringify(drifted))

      // ---- B2. the same locate answers Mod+Shift+D ------------------------
      await openEveryGroup(cdp, sessionId)
      await pushRowAboveSeat(cdp, sessionId, current)
      await sleep(400)
      const awayByKey = await box(cdp, sessionId, current)
      if (awayByKey !== null && awayByKey.visible === false) {
        // Meta 4 | Shift 8 — the binding this plugin declares for every profile
        // it can declare one for.
        await pressShortcut(cdp, sessionId, { key: 'D', code: 'KeyD', virtualKeyCode: 68, modifiers: 12 })
        await sleep(1100)
        const backByKey = await box(cdp, sessionId, current)
        if (backByKey !== null && backByKey.visible === true) {
          pass('Mod+Shift+D runs the same locate as the button')
        } else {
          fail('Mod+Shift+D did not bring the row back: ' + JSON.stringify({ away: awayByKey, back: backByKey }))
        }
      } else {
        fail('could not push the row out of the seat for the shortcut leg: ' + JSON.stringify(awayByKey))
      }
      await restoreGroups(cdp, sessionId, baseline)
    }

    // ---- D. copying a Session id ----------------------------------------
    // Right-clicking a blank "new Session" row deliberately opens no menu, so
    // the row under test is whichever one the shell itself answers; the copier
    // is then asked for that row's id, not the open Session's.
    const openSessionId = current.slice('session:'.length)
    const candidateRows = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('[class*="listArea"] [data-row-key^="session:"]')].map((e) => e.dataset.rowKey))()`)
    // A run that died mid-way can leave this preference off, and an off
    // preference hides the very row under test: put it back rather than let one
    // interrupted run fail the next one.
    await ensureCopyOn(cdp, sessionId)
    await stubClipboard(cdp, sessionId)
    let copy = null
    let copyRow = null
    for (const rowKey of candidateRows) {
      await openRowMenu(cdp, sessionId, rowKey)
      const probe = await evaluate(cdp, sessionId, COPY_PROBE)
      if (probe.menuItems.length > 0) {
        copy = probe
        copyRow = rowKey
        break
      }
    }
    if (copy === null) {
      fail('no Session row opened a menu at all: ' + JSON.stringify(candidateRows.slice(0, 4)))
    } else if (copy.copyItem && copy.copyHint !== null && copy.copyHint.includes('C')) {
      pass('right-clicking a Session row offers 复制会话 ID, hinting ' + JSON.stringify(copy.copyHint))
    } else {
      fail('the row menu has no 复制会话 ID entry: ' + JSON.stringify({ row: copyRow, items: copy.menuItems, hint: copy.copyHint }))
    }
    await shoot(cdp, sessionId, 'row-menu.png')

    const copyRowId = copyRow === null ? null : copyRow.slice('session:'.length)
    await clickMenuEntry(cdp, sessionId, '复制会话 ID')
    try {
      await waitFor(cdp, sessionId, 'window.__copied !== null', 'the clipboard write')
    } catch { /* the assertion below is the report */ }
    await sleep(300)
    copy = await evaluate(cdp, sessionId, COPY_PROBE)
    if (copy.copied === copyRowId) pass('the menu row copies the row it was opened on: ' + copy.copied)
    else fail('the menu row copied the wrong value: ' + JSON.stringify({ copied: copy.copied, expected: copyRowId }))
    if (copy.alerts.some((text) => text.includes('已复制会话 ID'))) pass('the copy is announced, not silent')
    else fail('no notice after copying: ' + JSON.stringify(copy.alerts))
    await shoot(cdp, sessionId, 'copied.png')

    // The same copy answers the shortcut, over the same notice, and it takes
    // the Session the conversation column holds rather than a row under the
    // pointer.
    await waitFor(cdp, sessionId, '!(' + NOTICE_VISIBLE + ')', 'the first notice to retire', 8000)
    await evaluate(cdp, sessionId, 'window.__copied = null')
    // Meta 4 | Shift 8 — the combination this plugin declares for every profile
    // that admits one.
    await pressShortcut(cdp, sessionId, { key: 'C', code: 'KeyC', virtualKeyCode: 67, modifiers: 12 })
    try {
      await waitFor(cdp, sessionId, 'window.__copied !== null', "the shortcut's clipboard write")
    } catch { /* the assertion below is the report */ }
    await sleep(300)
    copy = await evaluate(cdp, sessionId, COPY_PROBE)
    if (copy.copied === openSessionId) pass('Mod+Shift+C copies the open Session id')
    else fail('Mod+Shift+C did not copy the open Session id: ' + JSON.stringify({ copied: copy.copied, expected: openSessionId }))
    if (copy.alerts.some((text) => text.includes('已复制会话 ID'))) pass('the shortcut announces the copy too')
    else fail('the shortcut copied silently: ' + JSON.stringify(copy.alerts))
    await waitFor(cdp, sessionId, '!(' + NOTICE_VISIBLE + ')', 'the notice to retire', 8000)
    await evaluate(cdp, sessionId, 'window.__copied = null')
    // ---- C. the 心流 page owns the button's visibility -------------------
    await click(cdp, sessionId, '[data-slot="sidebar.settings"] button')
    await waitFor(cdp, sessionId, 'document.querySelector(\'[role="dialog"] nav button\') !== null', 'the settings dialog')
    state = await evaluate(cdp, sessionId, PROBE)
    if (state.flowNav.includes('心流')) pass('the settings navigation carries the 心流 tab')
    else fail('no 心流 tab in the settings navigation: ' + JSON.stringify(state.flowNav))

    // The shortcut reference must list this plugin's command under the key the
    // registry actually accepted — the binding, not just the command.
    await click(cdp, sessionId, '[role="dialog"] nav button:nth-child(1)')
    await sleep(500)
    const editor = await evaluate(cdp, sessionId, `(() => {
      const trigger = [...document.querySelectorAll('[role="dialog"] button')]
        .find((b) => b.textContent.trim() === '编辑快捷键');
      if (!trigger) return null;
      const rect = trigger.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`)
    if (editor === null) {
      fail('the 快捷键 editor trigger was not found')
    } else {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editor.x, y: editor.y, button: 'none', buttons: 0 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editor.x, y: editor.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editor.x, y: editor.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
      await sleep(900)
      const listed = await evaluate(cdp, sessionId, `(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const text = dialogs.map((d) => d.innerText).join('\\n');
        const at = text.indexOf('定位当前会话');
        const copyAt = text.indexOf('复制会话 ID');
        return {
          present: at !== -1,
          around: at === -1 ? null : text.slice(Math.max(0, at - 40), at + 20),
          copyPresent: copyAt !== -1,
          copyAround: copyAt === -1 ? null : text.slice(Math.max(0, copyAt - 60), copyAt + 24),
        };
      })()`)
      if (listed.present) pass('the shortcut reference lists 定位当前会话 with ' + JSON.stringify(listed.around))
      else fail('the shortcut reference does not list the locate command')
      if (listed.copyPresent) pass('the same editor lists 复制会话 ID, so the copy key is rebindable: ' + JSON.stringify(listed.copyAround))
      else fail('the shortcut reference does not list the copy command')
      await pressEscape(cdp, sessionId)
      await sleep(400)
      await pressEscape(cdp, sessionId)
      await sleep(400)
      await click(cdp, sessionId, '[data-slot="sidebar.settings"] button')
      await waitFor(cdp, sessionId, 'document.querySelector(\'[role="dialog"] nav button\') !== null', 'the settings dialog again')
    }

    const flowTab = await evaluate(cdp, sessionId, `(() => {
      const tab = [...document.querySelectorAll('[role="dialog"] nav button')].find((b) => b.textContent === '心流');
      if (!tab) return null;
      const rect = tab.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`)
    if (flowTab === null) {
      fail('the 心流 tab could not be located for a click')
    } else {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: flowTab.x, y: flowTab.y, button: 'none', buttons: 0 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: flowTab.x, y: flowTab.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: flowTab.x, y: flowTab.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
      await waitFor(cdp, sessionId, 'document.querySelector(\'[role="dialog"] .flow-row__title\') !== null', 'the 心流 page body')
      state = await evaluate(cdp, sessionId, PROBE)
      if (state.sectionTitle === '定位当前会话按钮') pass('the 心流 page renders its one preference row')
      else fail('unexpected section row title: ' + JSON.stringify(state.sectionTitle))
      const startedOn = state.switchChecked
      await shoot(cdp, sessionId, 'settings.png')
      if (startedOn !== 'true') fail('the preference did not start on by default: ' + JSON.stringify(startedOn))

      await click(cdp, sessionId, '[role="dialog"] [role="switch"]')
      await sleep(1200)
      const off = await evaluate(cdp, sessionId, PROBE)
      if (off.switchChecked === 'false' && off.buttonCount === 0 && off.hostExists === false) {
        pass('switching the preference off removes the button from the header')
      } else {
        fail('button survived the preference being switched off: ' + JSON.stringify({
          checked: off.switchChecked, buttons: off.buttonCount, host: off.hostExists,
        }))
      }

      await click(cdp, sessionId, '[role="dialog"] [role="switch"]')
      await waitFor(cdp, sessionId, 'document.querySelector(\'[data-flow-host="locate"]\') !== null', 'the button to come back')
      await sleep(600)
      const on = await evaluate(cdp, sessionId, PROBE)
      if (on.switchChecked === 'true' && on.buttonCount === 1 && on.hostAfterSearch) {
        pass('switching it back on restores the button, still right of the search seat')
      } else {
        fail('button did not come back correctly: ' + JSON.stringify({
          checked: on.switchChecked, buttons: on.buttonCount, afterSearch: on.hostAfterSearch,
        }))
      }
    }

    // ---- E. the 心流 switch owns the copy feature -----------------------
    copy = await evaluate(cdp, sessionId, COPY_PROBE)
    if (JSON.stringify(copy.sectionTitles) === JSON.stringify(['定位当前会话按钮', '复制会话 ID', '在系统默认程序中打开链接', '行内代码右键菜单', '改动文件右键菜单', '⌘+Enter 发送'])) {
      pass('the 心流 page renders all six preference rows')
    } else {
      fail('unexpected settings rows: ' + JSON.stringify(copy.sectionTitles))
    }

    // A preference write round-trips through the Host, so the switch is read
    // back on a bounded wait rather than a guessed sleep: a slow answer must not
    // read as a refusal, and a real refusal still has to fail this run.
    await click(cdp, sessionId, '[role="dialog"] .flow-row:nth-child(2) [role="switch"]')
    await settled(cdp, sessionId, 'false')
    copy = await evaluate(cdp, sessionId, COPY_PROBE)

    if (copy.switches[1] === 'false') {
      pass('the copy preference can be switched off')

      // The sidebar is inert behind the dialog, so close it before probing the
      // row menu the preference is supposed to have emptied.
      await pressEscape(cdp, sessionId)
      await stubClipboard(cdp, sessionId)
      await openRowMenu(cdp, sessionId, copyRow)
      copy = await evaluate(cdp, sessionId, COPY_PROBE)
      if (copy.menuItems.length > 0 && !copy.copyItem) pass('switched off, the row menu no longer offers 复制会话 ID')
      else fail('the menu row survived the preference being switched off: ' + JSON.stringify(copy.menuItems))
      await pressEscape(cdp, sessionId)
      await pressShortcut(cdp, sessionId, { key: 'C', code: 'KeyC', virtualKeyCode: 67, modifiers: 12 })
      // The app refuses this gesture while the feature is off, so it reaches the
      // browser, where it asks for the element picker; Escape stands that down
      // before the next press, which the picker would otherwise swallow.
      await pressEscape(cdp, sessionId)
      copy = await evaluate(cdp, sessionId, COPY_PROBE)
      if (copy.copied === null) pass('switched off, Mod+Shift+C copies nothing')
      else fail('the shortcut still copied while switched off: ' + JSON.stringify(copy.copied))

      await openFlowTab(cdp, sessionId)
      // A control still busy with the previous write is disabled, and pressing a
      // disabled control does nothing — which looks exactly like a product bug
      // from the outside. Wait for it to become pressable instead.
      await waitFor(
        cdp,
        sessionId,
        '(() => { const n = document.querySelector(' + JSON.stringify('[role="dialog"] .flow-row:nth-child(2) [role="switch"]') + '); return n !== null && n.disabled === false })()',
        'the copy switch to become pressable',
      )
      await click(cdp, sessionId, '[role="dialog"] .flow-row:nth-child(2) [role="switch"]')
      await settled(cdp, sessionId, 'true')
      copy = await evaluate(cdp, sessionId, COPY_PROBE)
      if (copy.switches[1] === 'true') pass('switching it back on restores the copy preference')
      else fail('the copy preference did not come back: ' + JSON.stringify({ switches: copy.switches, errors: copy.rowErrors }))
      await pressEscape(cdp, sessionId)
      await openRowMenu(cdp, sessionId, copyRow)
      copy = await evaluate(cdp, sessionId, COPY_PROBE)
      if (copy.copyItem) pass('the row menu entry is back once the preference is on')
      else fail('the row menu entry stayed away: ' + JSON.stringify(copy.menuItems))
      await pressEscape(cdp, sessionId)
    } else if (copy.rowErrors[1] !== null && copy.rowErrors[0] === null) {
      // The switch is only drivable once the plugin's Host half — this
      // checkout's index.js — is the one the instance activated: a preference
      // the Host schema does not project cannot be saved, however the client
      // writes it. What the refusal still has to prove is that it lands on the
      // row that asked for it and not on its neighbour.
      pass('a refused preference write is reported on its own row, not on its neighbour')
      skip('the copy switch leg needs this checkout as the installed Host half; install it and restart the instance to run it here')
    } else {
      fail('the copy switch neither took nor reported a refusal: ' + JSON.stringify({ switches: copy.switches, errors: copy.rowErrors }))
    }
    // Leave the dialog closed; the toggle is already back where it started.
    await pressEscape(cdp, sessionId)

    // ---- G. the inline-code right-click menu ----------------------------
    // The conversation body only renders while a Session with content is open,
    // and the shell often opens on an empty draft: a code-element count of zero
    // there would make every assertion below a false failure. The legs
    // therefore open a row that has something in it first.
    await openFlowTab(cdp, sessionId)
    const codeMenuStarted = await codeMenuSwitchState(cdp, sessionId)
    // A run that died mid-way can leave this preference off; an off preference
    // has no listener at all, so it is put back rather than allowed to fail the
    // next run.
    let codeMenuOn = codeMenuStarted === 'true'
    if (!codeMenuOn) codeMenuOn = await setCodeMenu(cdp, sessionId, 'true')
    await pressEscape(cdp, sessionId)
    if (!codeMenuOn) {
      skip('the inline-code menu legs need this checkout as the installed Host half; install it and restart the instance to run them here')
    } else {
      const content = await openContentSession(cdp, sessionId)
      if (!content.ok) {
        fail('no Session renders a conversation body to right-click: ' + JSON.stringify(content.rows))
      } else {
        pass('a conversation with rendered inline code is open (' + content.codes + ' code elements)')
        await stubClipboard(cdp, sessionId)

        // ① the menu, with both entries
        const pressed = await pressElement(cdp, sessionId, codeFinder('mention'), { contextMenu: true })
        const menus = await settleMenus(cdp, sessionId, 1)
        let code = await evaluate(cdp, sessionId, CODE_PROBE)
        if (code.openItem && code.copyItem && menus === 1) {
          pass('right-clicking inline code offers 打开 and 复制')
        } else {
          fail('no inline-code menu after a right-click: ' + JSON.stringify({ items: code.items, menus: code.menus }))
        }
        await shoot(cdp, sessionId, 'code-menu.png')

        // ② 复制 writes the code's own text
        const choseCopy = await clickExactMenuEntry(cdp, sessionId, '复制')
        if (!choseCopy) fail('the inline-code menu never offered 复制')
        try {
          await waitFor(cdp, sessionId, 'window.__copied !== null', 'the inline-code clipboard write')
        } catch { /* the assertion below is the report */ }
        await sleep(300)
        code = await evaluate(cdp, sessionId, CODE_PROBE)
        // The expected value is the text of the element that was really pressed,
        // captured in that same page-side measurement — re-finding "the first
        // mention" here could pick a different one and make a correct copy look
        // wrong.
        const expectedText = pressed === null ? null : pressed.text
        if (expectedText !== null && code.copied === expectedText) {
          pass('复制 puts the inline code’s own text on the clipboard: ' + JSON.stringify(code.copied))
        } else {
          fail('the menu copied the wrong text: ' + JSON.stringify({ copied: code.copied, expected: expectedText }))
        }
        if (code.alerts.some((text) => text.includes('已复制行内代码'))) pass('the inline-code copy is announced, not silent')
        else fail('no notice after copying inline code: ' + JSON.stringify(code.alerts))
        if (await settleMenus(cdp, sessionId, 0) === 0) pass('choosing an entry closes the menu')
        else fail('the menu stayed open after an entry was chosen')
        await shoot(cdp, sessionId, 'code-copied.png')

        // ③ 打开 runs the shell's own click, and nothing of this plugin's
        await evaluate(cdp, sessionId, `(() => {
          window.__codeClicks = [];
          if (window.__codeClickRecorder === true) return true;
          document.addEventListener('click', (event) => {
            const code = event.target?.closest?.('code');
            if (code === null || code === undefined) return;
            window.__codeClicks.push({ tag: event.target.tagName, trusted: event.isTrusted === true });
          }, true);
          window.__codeClickRecorder = true;
          return true;
        })()`)
        await pressElement(cdp, sessionId, codeFinder('mention'), { contextMenu: true })
        await settleMenus(cdp, sessionId, 1)
        await clickExactMenuEntry(cdp, sessionId, '打开')
        await sleep(800)
        code = await evaluate(cdp, sessionId, CODE_PROBE)
        const syntheticClicks = code.clicks.filter((click) => click.trusted === false)
        if (syntheticClicks.length === 1 && syntheticClicks[0].tag === 'BUTTON') {
          pass('打开 dispatches one synthetic left click at the shell’s own control')
        } else {
          fail('打开 did not run the shell’s own click path: ' + JSON.stringify(code.clicks))
        }

        // ④ the invariant this feature exists to keep: a left click is untouched
        await evaluate(cdp, sessionId, 'window.__codeClicks = []')
        // A plain code first: its left click has no other effect to trip over.
        // When the turns on screen hold only file mentions, the same assertion runs
        // on one of those — a mention's left click opens the file, which is exactly
        // the behaviour that must not turn into a menu.
        let leftClicked = await pressElement(cdp, sessionId, codeFinder('plain'), { timeoutMs: 1500 })
        let leftKind = 'plain'
        if (leftClicked === null) {
          leftClicked = await pressElement(cdp, sessionId, codeFinder('mention'))
          leftKind = 'mention'
        }
        await sleep(400)
        code = await evaluate(cdp, sessionId, CODE_PROBE)
        if (leftClicked === null) {
          fail('nothing pressable to left-click: ' + JSON.stringify(await evaluate(cdp, sessionId, CODE_DIAGNOSTICS)))
        } else if (code.menus === 0 && code.items.length === 0) {
          pass('a plain left click on inline code opens no menu (' + leftKind + ')')
        } else {
          fail('a left click opened the inline-code menu: ' + JSON.stringify(code.items))
        }
        // The recorder only keeps clicks whose target is inside a code, so a real
        // one here is the press itself: the shell received an untouched left
        // click, not this plugin reacting to it. Its exact tag is the code for a
        // plain snippet and the mention button inside it for a file reference.
        if (code.clicks.some((click) => click.trusted === true)) {
          pass('the left click reached the shell as itself, inside the code element')
        } else {
          fail('the left click never reached the code element: ' + JSON.stringify(code.clicks))
        }
        await shoot(cdp, sessionId, 'code-left-click.png')

        // ⑤ Escape and a press outside close it — the shipped menu's own keys
        await pressElement(cdp, sessionId, codeFinder('mention'), { contextMenu: true })
        const beforeEscape = await settleMenus(cdp, sessionId, 1)
        await pressEscape(cdp, sessionId)
        const afterEscape = await settleMenus(cdp, sessionId, 0)
        if (beforeEscape === 1 && afterEscape === 0) pass('Escape closes the inline-code menu')
        else fail('Escape did not close the menu: ' + JSON.stringify({ before: beforeEscape, after: afterEscape }))

        await pressElement(cdp, sessionId, codeFinder('mention'), { contextMenu: true })
        const beforeOutside = await settleMenus(cdp, sessionId, 1)
        // Dispatched rather than pressed: any point inside the conversation
        // column can land on another inline code, and a second menu would make
        // "did the first one close" unanswerable. The event is the one the
        // shipped dismissal listens for, on a real element of the panel.
        await evaluate(cdp, sessionId, `(() => {
          const panel = document.querySelector('[slot="conversation.view"]') ?? document.body;
          panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 }));
          return true;
        })()`)
        const afterOutside = await settleMenus(cdp, sessionId, 0)
        if (beforeOutside === 1 && afterOutside === 0) pass('a pointer press outside the menu closes it')
        else fail('the menu survived a press outside it: ' + JSON.stringify({ before: beforeOutside, after: afterOutside }))

        // ⑥ the switch owns the listener, not just the menu
        await openFlowTab(cdp, sessionId)
        const switchedOff = await setCodeMenu(cdp, sessionId, 'false')
        await pressEscape(cdp, sessionId)
        if (!switchedOff) {
          skip('switching the inline-code preference off needs this checkout as the installed Host half; install it and restart the instance to run that leg here')
        } else {
          await pressElement(cdp, sessionId, codeFinder('mention'), { contextMenu: true })
          // A negative assertion cannot be waited for: what bounds it is a fixed
          // pause long enough for a menu that was going to open to have opened.
          await sleep(800)
          code = await evaluate(cdp, sessionId, CODE_PROBE)
          if (code.menus === 0 && code.items.length === 0) pass('switched off, a right-click on inline code opens no menu')
          else fail('the menu opened while the preference was off: ' + JSON.stringify(code.items))

          await openFlowTab(cdp, sessionId)
          const switchedBack = await setCodeMenu(cdp, sessionId, 'true')
          await pressEscape(cdp, sessionId)
          if (!switchedBack) {
            fail('the inline-code preference did not come back')
          } else {
            await pressElement(cdp, sessionId, codeFinder('mention'), { contextMenu: true })
            const restored = await settleMenus(cdp, sessionId, 1)
            code = await evaluate(cdp, sessionId, CODE_PROBE)
            if (restored === 1 && code.openItem && code.copyItem) pass('switching it back on restores the menu')
            else fail('the menu did not come back: ' + JSON.stringify(code.items))
            await pressEscape(cdp, sessionId)
          }
        }
      }
      // The legs above opened another Session; put the one the run started on
      // back, so a verification pass leaves the interface where it found it.
      if (current !== null) {
        await click(cdp, sessionId, '[data-row-key=' + JSON.stringify(current) + ']').catch(() => {
          // Best effort: the row may have been filtered out since.
        })
        await sleep(600)
      }
    }



    // ---- H. the changed-file right-click menu --------------------------
    // The card is rendered from the Host's own per-turn change summary, so it
    // exists only for a turn that really changed files and only while the Host
    // process that recorded it is alive. No such turn on screen is a skip, not a
    // failure.
    const changed = await openChangedFilesSession(cdp, sessionId)
    if (!changed.ok) {
      skip('no Session on screen ends with a 已编辑 N 个文件 card; run a turn that edits files and re-run to exercise the changed-file menu')
    } else {
      pass('a changed-files card is on screen (' + changed.rows + ' file rows)')
      const pressed = await pressElement(cdp, sessionId, CHANGED_FILE_FINDER, { contextMenu: true })
      const menus = await settleMenus(cdp, sessionId, 1)
      const probe = await evaluate(cdp, sessionId, CHANGED_FILES_PROBE)
      if (pressed === null) {
        fail('nothing pressable on the changed-files card: ' + JSON.stringify(probe))
      } else if (menus !== 1 || probe.items.length !== 2) {
        fail('no changed-file menu after a right-click: ' + JSON.stringify({ items: probe.items, menus: probe.menus }))
      } else if (probe.items[0] !== '用默认应用打开' || probe.items[1] !== '在文件管理器中显示') {
        fail('the changed-file menu offered the wrong entries: ' + JSON.stringify(probe.items))
      } else {
        pass('right-clicking a changed file offers 用默认应用打开 and 在文件管理器中显示')
      }
      // The path the live card handed over is the contract unit tests cannot
      // reach: it comes from the shipped `aria-describedby` element, and a
      // rename there would leave the menu openable but empty of a target.
      if (typeof probe.path === 'string' && probe.path.startsWith('/') && probe.path === probe.described) {
        pass('the menu carries the absolute Host path the card recorded: ' + probe.path)
      } else {
        fail('the menu did not resolve the row’s Host path: ' + JSON.stringify({ path: probe.path, described: probe.described }))
      }
      await shoot(cdp, sessionId, 'changes-file-menu.png')
      // Escape is the shipped Menu's own key.
      await pressEscape(cdp, sessionId)
      const closed = await settleMenus(cdp, sessionId, 0)
      if (closed === 0) pass('Escape closes the changed-file menu')
      else fail('Escape did not close the changed-file menu')
      // Neither entry is chosen on purpose: both launch a real application on the
      // human's desktop. The request each one sends is pinned by unit tests.
    }

    // The lookup above opened another Session — or tried several and found none
    // with a card; put the one the run started on back either way.
    if (current !== null) {
      await click(cdp, sessionId, '[data-row-key=' + JSON.stringify(current) + ']').catch(() => {
        // Best effort: the row may have been filtered out since.
      })
      await sleep(600)
    }

    // ---- F. the 心流 switch owns the link hand-off ----------------------
    await stubOpenRoutes(cdp, sessionId)
    await openFlowTab(cdp, sessionId)
    copy = await evaluate(cdp, sessionId, COPY_PROBE)
    const linkStarted = copy.switches[2] ?? null
    // The default itself is asserted by the unit tests; what this leg needs is the
    // preference ON. A run killed mid-way leaves it off, so finding it off is
    // reported as a skip rather than read as a product defect — and the section
    // normalizes it on below, exactly as the copy section does.
    if (linkStarted === 'true') pass('the link preference starts on by default')
    else skip('the link preference was off at the start (an interrupted run leaves it off); it is switched back on for these legs')

    // The link preference is persisted exactly like the copy one, so the same
    // two rules apply: this run normalizes the start state itself, and the write
    // is read back on a bounded wait rather than a guessed sleep.
    const linkRow = '[role="dialog"] .flow-row:nth-child(3) [role="switch"]'
    const linkChecked = () => evaluate(cdp, sessionId, `(() => {
      const node = document.querySelector(${JSON.stringify(linkRow)});
      return node === null ? null : node.getAttribute('aria-checked');
    })()`)
    const setLink = async (want) => await pressFlowSwitch(cdp, sessionId, linkRow, want)
    const ourCalls = (opened) => opened.calls.filter((call) => call.route.endsWith('/flow/open-external'))

    const onDuty = await setLink('true')
    if (!onDuty) skip('the link switch legs need this checkout as the installed Host half; install it and restart the instance to run them here')
    await pressEscape(cdp, sessionId)
    await installProbeAnchors(cdp, sessionId)

    await evaluate(cdp, sessionId, 'window.__openCalls = []')
    await click(cdp, sessionId, '[data-flow-probe="off-origin"]')
    await sleep(400)
    let opened = await evaluate(cdp, sessionId, OPEN_PROBE)
    if (onDuty && ourCalls(opened).length === 1 && String(ourCalls(opened)[0].body).includes('http://127.0.0.1:9/flow-probe')) {
      pass('an off-origin link is handed to the Host open route: ' + ourCalls(opened)[0].route)
    } else if (onDuty) {
      fail('the off-origin link did not reach the open route: ' + JSON.stringify(opened.calls))
    }

    // The application's own navigation is the one gesture this feature must
    // never take: a capture listener that answers it would break every in-app
    // link.
    await evaluate(cdp, sessionId, 'window.__openCalls = []')
    await click(cdp, sessionId, '[data-flow-probe="same-origin"]')
    await sleep(400)
    opened = await evaluate(cdp, sessionId, OPEN_PROBE)
    if (ourCalls(opened).length === 0) pass('a same-origin link is left to the application')
    else fail('a same-origin link was handed to the open route: ' + JSON.stringify(ourCalls(opened)))

    await openFlowTab(cdp, sessionId)
    const offDuty = await setLink('false')
    await pressEscape(cdp, sessionId)
    await evaluate(cdp, sessionId, 'window.__openCalls = []')
    await click(cdp, sessionId, '[data-flow-probe="off-origin"]')
    await sleep(400)
    opened = await evaluate(cdp, sessionId, OPEN_PROBE)
    if (offDuty && ourCalls(opened).length === 0) {
      pass('switched off, an off-origin link keeps the shell’s own behaviour')
    } else if (offDuty) {
      fail('the open route was still called while switched off: ' + JSON.stringify(ourCalls(opened)))
    } else {
      skip('switching the link preference off could not be saved by the installed Host half')
    }

    await openFlowTab(cdp, sessionId)
    // Left on, the way the copy section leaves its switch: the default is what a
    // verification run has to leave behind, and `linkStarted` may itself be the
    // residue of a run that was killed mid-way.
    const restoredLink = await setLink('true')
    if (restoredLink) pass('the link preference is left on')
    else fail('the link preference was not restored: ' + JSON.stringify(await evaluate(cdp, sessionId, COPY_PROBE)))
    await pressEscape(cdp, sessionId)
    await removeProbeAnchors(cdp, sessionId)

    // ---- H. the 心流 switch owns the swapped send key -------------------
    // The composer adjudicates Enter inside its own keymap, and the whole point
    // of this leg is that a press really changes what the shipped code does —
    // so it is read off the draft: with the switch on, a plain Enter has to
    // grow the draft by one newline instead of submitting it.
    //
    // Every press below is made on an empty or whitespace-only draft, which the
    // shell itself refuses to send. A rewrite that stopped working therefore
    // shows up as "the draft did not grow", never as a message posted into the
    // Session this run happens to be using.
    await openFlowTab(cdp, sessionId)
    const sendKeyStarted = await modEnterSwitchState(cdp, sessionId)
    if (sendKeyStarted === null) {
      skip('the 心流 page has no send-key row here: the Host half this instance activated predates it')
    } else {
      const switchedOff = await setModEnter(cdp, sessionId, 'false')
      await pressEscape(cdp, sessionId)
      if (!switchedOff) {
        skip('the send-key preference would not move: install this checkout as the installed Host half and restart the instance to run these legs')
      } else if (!await ensureEditableComposer(cdp, sessionId)) {
        fail('no Session answers with an editable composer to type into')
      } else {
        await focusComposer(cdp, sessionId)
        const offState = await composerState(cdp, sessionId)
        if (offState === null || offState.editable !== 'true' || !offState.focused) {
          fail('the composer never became the focused editable: ' + JSON.stringify(offState))
        } else {
          const beforeOff = offState.text
          await pressShortcut(cdp, sessionId, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, modifiers: 0 })
          const afterOffEnter = await composerState(cdp, sessionId)
          if (afterOffEnter.text === beforeOff) {
            pass('with the switch off a plain Enter leaves the shipped submit gesture alone')
          } else {
            fail('a plain Enter changed the draft while the switch was off: ' + JSON.stringify({ beforeOff, after: afterOffEnter.text }))
          }
          await pressShortcut(cdp, sessionId, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, modifiers: 8 })
          const afterOffShift = await composerState(cdp, sessionId)
          if (afterOffShift.text === beforeOff + '\n') {
            pass('with the switch off Shift+Enter is still the newline')
          } else {
            fail('Shift+Enter did not insert one newline: ' + JSON.stringify({ beforeOff, after: afterOffShift.text }))
          }

          await openFlowTab(cdp, sessionId)
          const switchedOn = await setModEnter(cdp, sessionId, 'true')
          await pressEscape(cdp, sessionId)
          if (!switchedOn) {
            skip('turning the send key on needs this checkout as the installed Host half; install it and restart the instance to run the remaining legs here')
          } else {
            await focusComposer(cdp, sessionId)
            const beforeOn = (await composerState(cdp, sessionId)).text
            await pressShortcut(cdp, sessionId, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, modifiers: 0 })
            const afterOnEnter = await composerState(cdp, sessionId)
            if (afterOnEnter.text === beforeOn + '\n') {
              pass('with the switch on a plain Enter inserts a newline instead of sending')
            } else {
              fail('a plain Enter did not insert a newline while the switch was on: ' + JSON.stringify({ beforeOn, after: afterOnEnter.text }))
            }
            // Cmd/Ctrl+Enter must take the *submit* gesture: on an empty or
            // whitespace-only draft that means no newline and no message.
            await pressShortcut(cdp, sessionId, { key: 'Enter', code: 'Enter', virtualKeyCode: 13, modifiers: 4 })
            const afterOnMeta = await composerState(cdp, sessionId)
            if (afterOnMeta.text === afterOnEnter.text) {
              pass('Cmd+Enter takes the submit gesture, not the newline one')
            } else {
              fail('Cmd+Enter inserted a newline instead of submitting: ' + JSON.stringify({ before: afterOnEnter.text, after: afterOnMeta.text }))
            }
            await shoot(cdp, sessionId, 'send-key.png')

            // Put the preference back where the run found it, then take the
            // draft back to empty. Clearing is best effort: the draft lives in
            // this throwaway browser profile either way.
            await openFlowTab(cdp, sessionId)
            const restoredSendKey = await setModEnter(cdp, sessionId, sendKeyStarted)
            await pressEscape(cdp, sessionId)
            if (restoredSendKey) pass('the send-key preference is left as the run found it (' + sendKeyStarted + ')')
            else fail('the send-key preference was not restored to ' + sendKeyStarted)
            await click(cdp, sessionId, '[data-composer-input]')
            await evaluate(cdp, sessionId, `(() => {
              const node = document.querySelector('[data-composer-input]');
              if (node === null) return false;
              node.focus();
              const range = document.createRange();
              range.selectNodeContents(node);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              return true;
            })()`)
            await pressShortcut(cdp, sessionId, { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8, modifiers: 0 })
            const cleaned = await composerState(cdp, sessionId)
            if (cleaned !== null && cleaned.text === '') pass('the composer is left empty')
            else console.log('  NOTE  the throwaway browser left a draft behind: ' + JSON.stringify(cleaned === null ? null : cleaned.text))
          }
        }
      }
    }
  } finally {
    socket?.close()
    await shutdown(chrome, profile)
  }

  console.log('')
  console.log(passes.length + ' passed, ' + failures.length + ' failed' + (skips.length === 0 ? '' : ', ' + skips.length + ' skipped'))
  if (failures.length > 0) process.exitCode = 1
}

await main()
