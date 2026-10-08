/**
 * Unit tests for the dsh-flow host half.
 *
 * The half owns three facts: the preference surface the settings provider
 * projects into the `flow` namespace, the presentation policy that stops it from
 * also auto-generating a page for that namespace, and the one route that hands
 * an off-origin link to the platform opener. The route is exercised through
 * `openRequestHandler`, so every branch — authentication, method, size,
 * protocol, opener failure — is asserted without spawning a real opener.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import {
  APPS_PATH,
  Config,
  OPEN_PATH,
  OPEN_WITH_PATH,
  acceptedUrl,
  applicationRoots,
  apply,
  appsRequestHandler,
  installedApps,
  launchPath,
  mayOpen,
  name,
  openRequestHandler,
  openWithRequestHandler,
  openerCommand,
  resolveCandidate,
} from '../index.js'

test('the host row is named after its bundle id', () => {
  assert.equal(name, 'flow')
})

test('the preference defaults to a shown button', () => {
  // A volatile field resolves to a live reference, which is exactly what lets
  // both the Host and a settings write follow the same value.
  assert.equal(z.resolve({}, Config)[0].locateButton.get(), true)
  assert.equal(z.resolve({ locateButton: false }, Config)[0].locateButton.get(), false)
})

test('the copy switch defaults to on, and is volatile for the same reason', () => {
  assert.equal(z.resolve({}, Config)[0].copySessionId.get(), true)
  assert.equal(z.resolve({ copySessionId: false }, Config)[0].copySessionId.get(), false)
  const field = Config.dict.copySessionId
  assert.equal(field.meta.volatile, true)
  assert.equal(field.type, 'boolean')
})

test('the external-link switch defaults to on, and is volatile too', () => {
  assert.equal(z.resolve({}, Config)[0].externalLink.get(), true)
  assert.equal(z.resolve({ externalLink: false }, Config)[0].externalLink.get(), false)
  const field = Config.dict.externalLink
  assert.equal(field.meta.volatile, true)
  assert.equal(field.type, 'boolean')
})

test('the inline-code menu switch defaults to on, and is volatile too', () => {
  assert.equal(z.resolve({}, Config)[0].codeMenu.get(), true)
  assert.equal(z.resolve({ codeMenu: false }, Config)[0].codeMenu.get(), false)
  const field = Config.dict.codeMenu
  assert.equal(field.meta.volatile, true)
  assert.equal(field.type, 'boolean')
})

test('the changed-file menu switch defaults to on, and is volatile too', () => {
  assert.equal(z.resolve({}, Config)[0].changesFileOpen.get(), true)
  assert.equal(z.resolve({ changesFileOpen: false }, Config)[0].changesFileOpen.get(), false)
  const field = Config.dict.changesFileOpen
  assert.equal(field.meta.volatile, true)
  assert.equal(field.type, 'boolean')
})

test('the send-key switch starts on the shell behaviour, and is volatile too', () => {
  // Off is the shipped Enter: a fresh install must not silently swap the keys
  // under someone who never asked for it.
  assert.equal(z.resolve({}, Config)[0].modEnterSend.get(), false)
  assert.equal(z.resolve({ modEnterSend: true }, Config)[0].modEnterSend.get(), true)
  assert.equal(z.resolve({ modEnterSend: false }, Config)[0].modEnterSend.get(), false)
  const field = Config.dict.modEnterSend
  assert.equal(field.meta.volatile, true)
  assert.equal(field.type, 'boolean')
})

test('the toggles are volatile, which is what the settings form projects', () => {
  for (const name of ['locateButton', 'copySessionId', 'externalLink', 'codeMenu', 'changesFileOpen', 'modEnterSend']) {
    const field = Config.dict[name]
    assert.equal(field.meta.volatile, true, name)
    assert.equal(field.type, 'boolean', name)
  }
})

test('the route path is namespaced by the bundle row that serves it', () => {
  assert.equal(OPEN_PATH, '/flow/open-external')
})

test('acceptedUrl admits the four opener schemes and normalizes them', () => {
  assert.equal(acceptedUrl('http://127.0.0.1:5173/a'), 'http://127.0.0.1:5173/a')
  assert.equal(acceptedUrl('https://example.com/x?y=1#z'), 'https://example.com/x?y=1#z')
  assert.equal(acceptedUrl('mailto:someone@example.com'), 'mailto:someone@example.com')
  assert.equal(acceptedUrl('tel:+8613800138000'), 'tel:+8613800138000')
  // Normalization is what keeps the opener arguments to what the URL parser
  // accepted, never to the raw string a click supplied.
  assert.equal(acceptedUrl('  https://example.com/a b  '), 'https://example.com/a%20b')
})

test('acceptedUrl refuses every scheme the opener must not be handed', () => {
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:msgbox',
    '/relative/path',
    'not a url',
    '',
  ]) {
    assert.equal(acceptedUrl(value), null, value)
  }
  assert.equal(acceptedUrl(undefined), null)
  assert.equal(acceptedUrl(42), null)
  assert.equal(acceptedUrl({ url: 'https://example.com' }), null)
  // One URL per request; a longer string is not a link.
  assert.equal(acceptedUrl('https://example.com/' + 'a'.repeat(8192)), null)
})

test('openerCommand speaks each platform the plugin runs on', () => {
  assert.deepEqual(openerCommand('https://example.com', 'darwin'), { command: 'open', args: ['https://example.com'] })
  assert.deepEqual(openerCommand('https://example.com', 'win32'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'https://example.com'],
  })
  assert.deepEqual(openerCommand('https://example.com', 'linux'), { command: 'xdg-open', args: ['https://example.com'] })
})

/** A request stub that delivers its body once the handler has subscribed. */
function request({ method = 'POST', body = '', fail = false } = {}) {
  const listeners = new Map()
  const req = {
    method,
    on(event, handler) {
      listeners.set(event, handler)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (fail) {
      listeners.get('error')?.(new Error('socket hang up'))
      return
    }
    if (body !== '') listeners.get('data')?.(Buffer.from(body))
    listeners.get('end')?.()
  })
  return req
}

/** A response stub recording exactly what the handler wrote. */
function response() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    setHeader(key, value) { res.headers[key.toLowerCase()] = value },
    end(text) { res.body = text ?? ''; res.ended = true },
  }
  return res
}

test('the route refuses a request the trust fence rejects, before reading it', async () => {
  const opened = []
  const handler = openRequestHandler({
    rejected: (_req, res) => { res.statusCode = 401; res.end(); return true },
    open: (url) => { opened.push(url); return true },
  })
  const res = response()
  await handler(request({ body: JSON.stringify({ url: 'https://example.com' }) }), res)
  assert.equal(res.statusCode, 401)
  assert.deepEqual(opened, [], 'an unauthenticated call must never reach the opener')
})

test('the route answers POST only', async () => {
  const handler = openRequestHandler({ open: () => true })
  const res = response()
  await handler(request({ method: 'GET' }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('the route hands one normalized URL to the opener', async () => {
  const opened = []
  const handler = openRequestHandler({ open: (url) => { opened.push(url); return true } })
  const res = response()
  await handler(request({ body: JSON.stringify({ url: 'http://127.0.0.1:5173/app' }) }), res)
  assert.deepEqual(opened, ['http://127.0.0.1:5173/app'])
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('the route reports an opener that could not start', async () => {
  const handler = openRequestHandler({ open: () => false })
  const res = response()
  await handler(request({ body: JSON.stringify({ url: 'https://example.com' }) }), res)
  assert.equal(res.statusCode, 502)
  assert.equal(JSON.parse(res.body).code, 'open-failed')
})

test('the route refuses a body it cannot use', async () => {
  const cases = [
    ['not json', 'bad-request'],
    [JSON.stringify({}), 'bad-request'],
    [JSON.stringify({ url: 'file:///etc/passwd' }), 'bad-request'],
    [JSON.stringify({ url: 'javascript:alert(1)' }), 'bad-request'],
  ]
  for (const [body, code] of cases) {
    const opened = []
    const handler = openRequestHandler({ open: (url) => { opened.push(url); return true } })
    const res = response()
    await handler(request({ body }), res)
    assert.equal(res.statusCode, 400, body)
    assert.equal(JSON.parse(res.body).code, code, body)
    assert.deepEqual(opened, [], body)
  }
})

test('the route refuses a body larger than any link could be', async () => {
  const opened = []
  const handler = openRequestHandler({ open: (url) => { opened.push(url); return true } })
  const res = response()
  await handler(request({ body: 'x'.repeat(32 * 1024) }), res)
  assert.equal(res.statusCode, 413)
  assert.equal(JSON.parse(res.body).code, 'payload-too-large')
  assert.deepEqual(opened, [])
})

test('the route reports an unreadable request body instead of throwing', async () => {
  const handler = openRequestHandler({ open: () => true })
  const res = response()
  await handler(request({ fail: true }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).code, 'bad-request')
})

test('apply claims the flow namespace as a hand-written page', () => {
  const configured = []
  const effects = []
  const ctx = {
    fiber: { id: 'flow-fiber' },
    inject: (names, callback) => {
      if (!names.includes('settings')) return
      assert.deepEqual(names, ['settings'])
      callback({
        effect: (callback) => { effects.push(callback); callback(); return () => {} },
        settings: {
          configure: (presentation, owner) => { configured.push({ presentation, owner }); return () => {} },
        },
      })
    },
  }
  apply(ctx)
  assert.deepEqual(configured, [{ presentation: { auto: false }, owner: ctx.fiber }])
  assert.equal(effects.length, 1)
})

test('apply mounts the open route on the web transport it injects', () => {
  const routes = []
  const descriptions = []
  const ctx = {
    fiber: {},
    inject: (names, callback) => {
      if (names.includes('settings')) return
      assert.deepEqual(names, ['webServer', 'connection'])
      callback({
        effect: (callback, description) => { descriptions.push(description); callback(); return () => {} },
        webServer: {
          register: (route) => { routes.push(route); return () => {} },
        },
        connection: { requestRejection: () => undefined },
      })
    },
  }
  apply(ctx)
  // Three exact routes: the link hand-off, the installed-application list, and
  // the opener that takes a path plus one of those applications.
  assert.deepEqual(routes.map((route) => route.path), [OPEN_PATH, APPS_PATH, OPEN_WITH_PATH])
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
  assert.deepEqual(descriptions, [
    'flow: POST ' + OPEN_PATH,
    'flow: GET ' + APPS_PATH,
    'flow: POST ' + OPEN_WITH_PATH,
  ])
})

test('apply survives a deployment without the settings service', () => {
  let ran = false
  apply({ fiber: {}, inject: (_names, _callback) => { ran = true } })
  assert.equal(ran, true)
})

test('apply injects the web transport separately, so a shell without it still loads', () => {
  const injected = []
  apply({ fiber: {}, inject: (names, _callback) => { injected.push(names) } })
  assert.deepEqual(injected, [['settings'], ['webServer', 'connection']])
})
// --- the plugin's own app catalog and opener -------------------------------

test('the catalog only offers applications the host really has', () => {
  const have = new Set(['/Applications/Visual Studio Code.app', '/Users/x/Applications/Zed.app'])
  const apps = installedApps({
    platform: 'darwin',
    roots: ['/Applications', '/Users/x/Applications'],
    env: { HOME: '/Users/x' },
    exists: (path) => have.has(path),
  })
  assert.deepEqual(apps.map(({ id, kind, path }) => [id, kind, path]), [
    ['vscode', 'ide', '/Applications/Visual Studio Code.app'],
    ['zed', 'ide', '/Users/x/Applications/Zed.app'],
  ])
})

test('a candidate resolves under the application roots, or on PATH elsewhere', () => {
  const darwin = { roots: ['/Applications'], exists: (path) => path === '/Applications/Zed.app', env: {} }
  assert.equal(resolveCandidate('Zed.app', 'darwin', darwin), '/Applications/Zed.app')
  assert.equal(resolveCandidate('Ghostty.app', 'darwin', darwin), null)
  assert.equal(resolveCandidate('/System/Applications/Utilities/Terminal.app', 'darwin', { roots: [], exists: () => false, env: {} }), null)
  const linux = { roots: [], exists: (path) => path === '/usr/bin/code', env: { PATH: '/usr/bin:/bin' } }
  assert.equal(resolveCandidate('code', 'linux', linux), '/usr/bin/code')
  assert.equal(resolveCandidate('code', 'linux', { ...linux, env: { PATH: '/bin' } }), null)
})

test('only an IDE may be handed a file; a directory takes any kind', () => {
  assert.equal(mayOpen({ kind: 'ide' }, false), true)
  assert.equal(mayOpen({ kind: 'ide' }, true), true)
  assert.equal(mayOpen({ kind: 'terminal' }, true), true)
  assert.equal(mayOpen({ kind: 'terminal' }, false), false)
  assert.equal(mayOpen({ kind: 'files' }, false), false)
  assert.equal(mayOpen(undefined, true), false)
})

test('the app list route answers GET, and never hands out host paths', async () => {
  const handler = appsRequestHandler({
    apps: () => [
      { id: 'vscode', name: 'VS Code', kind: 'ide', path: '/Applications/Visual Studio Code.app' },
      { id: 'terminal', name: '终端', kind: 'terminal', path: '/System/Applications/Utilities/Terminal.app' },
    ],
  })
  const res = response()
  await handler(request({ method: 'GET' }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), {
    apps: [
      { id: 'vscode', name: 'VS Code', kind: 'ide' },
      { id: 'terminal', name: '终端', kind: 'terminal' },
    ],
  })

  const refused = response()
  await handler(request({ method: 'POST', body: '{}' }), refused)
  assert.equal(refused.statusCode, 405)
  assert.equal(refused.headers.allow, 'GET')
})

test('the opener refuses anything but a checked path and a catalog application', async () => {
  const apps = () => [{ id: 'vscode', name: 'VS Code', kind: 'ide', path: '/Applications/Visual Studio Code.app' }]
  const directory = { isDirectory: () => true }
  const file = { isDirectory: () => false }
  const handler = openWithRequestHandler({
    apps,
    stat: (path) => {
      if (path === '/work/file.ts') return file
      if (path === '/work/src') return directory
      throw new Error('ENOENT')
    },
    launch: () => true,
  })

  const get = response()
  await handler(request({ method: 'GET' }), get)
  assert.equal(get.statusCode, 405)

  const unknown = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'rm', path: '/work/file.ts' }) }), unknown)
  assert.equal(unknown.statusCode, 400)

  const relative = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'vscode', path: 'file.ts' }) }), relative)
  assert.equal(relative.statusCode, 400)

  const missing = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'vscode', path: '/work/gone.ts' }) }), missing)
  assert.equal(missing.statusCode, 404)

  const unreadable = response()
  await handler(request({ method: 'POST', body: 'not json' }), unreadable)
  assert.equal(unreadable.statusCode, 400)
})

test('a file reaches only the IDEs; a directory reaches every catalog entry', async () => {
  const launched = []
  const apps = () => [
    { id: 'vscode', name: 'VS Code', kind: 'ide', path: '/Applications/Visual Studio Code.app' },
    { id: 'terminal', name: '终端', kind: 'terminal', path: '/System/Applications/Utilities/Terminal.app' },
  ]
  const handler = openWithRequestHandler({
    apps,
    stat: (path) => ({ isDirectory: () => path === '/work/src' }),
    launch: (entry, path, action) => { launched.push([entry && entry.id, path, action]); return true },
  })

  const ide = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'vscode', path: '/work/file.ts' }) }), ide)
  assert.equal(ide.statusCode, 200)
  assert.deepEqual(launched, [['vscode', '/work/file.ts', 'open']])

  const terminal = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'terminal', path: '/work/file.ts' }) }), terminal)
  assert.equal(terminal.statusCode, 403)
  assert.equal(launched.length, 1, 'a terminal must never receive a file')

  const folder = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'terminal', path: '/work/src' }) }), folder)
  assert.equal(folder.statusCode, 200)
  assert.deepEqual(launched[1], ['terminal', '/work/src', 'open'])

  const dflt = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'default', path: '/work/file.ts' }) }), dflt)
  assert.equal(dflt.statusCode, 200)
  assert.deepEqual(launched[2], [null, '/work/file.ts', 'open'])

  const reveal = response()
  await handler(request({ method: 'POST', body: JSON.stringify({ app: 'reveal', path: '/work/file.ts' }) }), reveal)
  assert.equal(reveal.statusCode, 200)
  assert.deepEqual(launched[3], [null, '/work/file.ts', 'reveal'])

  const failed = openWithRequestHandler({
    apps,
    stat: () => ({ isDirectory: () => false }),
    launch: () => false,
  })
  const res = response()
  await failed(request({ method: 'POST', body: JSON.stringify({ app: 'vscode', path: '/work/file.ts' }) }), res)
  assert.equal(res.statusCode, 502)
  assert.equal(JSON.parse(res.body).code, 'open-failed')
})

