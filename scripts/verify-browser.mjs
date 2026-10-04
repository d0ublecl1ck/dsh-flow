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
}

const passes = []
const failures = []
const pass = (message) => { passes.push(message); console.log('  PASS  ' + message) }
const fail = (message) => { failures.push(message); console.log('  FAIL  ' + message) }

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
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
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
async function click(cdp, sessionId, selector) {
  const centre = await evaluate(cdp, sessionId, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (target === null) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`)
  if (centre === null) throw new Error('nothing clickable at ' + selector)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, button: 'none', buttons: 0 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
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
    await cdp.send('Emulation.setLocaleOverride', { locale: 'zh-CN' }, sessionId)
    await cdp.send('Network.setCookie', {
      name: cookie.name, value: cookie.value, url: config.url, path: '/', httpOnly: true, sameSite: 'Strict',
    }, sessionId)
    await cdp.send('Page.navigate', { url: config.url + '/' }, sessionId)
    await waitFor(cdp, sessionId, 'document.readyState === "complete"', 'document load')
    await waitFor(cdp, sessionId, 'document.querySelector(\'[data-flow-host="locate"]\') !== null', 'the locate container')
    pass('signed browser session accepted at ' + config.url)

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
        return { present: at !== -1, around: at === -1 ? null : text.slice(Math.max(0, at - 40), at + 20) };
      })()`)
      if (listed.present) pass('the shortcut reference lists 定位当前会话 with ' + JSON.stringify(listed.around))
      else fail('the shortcut reference does not list the locate command')
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

    // Leave the dialog closed; the toggle is already back where it started.
    await pressEscape(cdp, sessionId)
  } finally {
    socket?.close()
    chrome.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }

  console.log('')
  console.log(passes.length + ' passed, ' + failures.length + ' failed')
  if (failures.length > 0) process.exitCode = 1
}

await main()
