/**
 * Unit tests for the dsh-flow browser half.
 *
 * The module under test is a browser bundle, so it is loaded through a fake
 * `window.__ModuleLoader__`. Every DOM node is a hand-built stub whose
 * `querySelector` is driven by an explicit selector table, which keeps each
 * assertion about *which* node the code reached for — not about a real DOM
 * implementation we would then be testing instead.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Build one element stub. `find` maps a selector to the node it must return. */
function node({ className = '', attrs = {}, find, tag = 'div' } = {}) {
  const element = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className,
    parentElement: null,
    dataset: {},
    inserted: [],
    clicks: 0,
    scrollOptions: undefined,
    animations: [],
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (selector) => (find === undefined ? null : (find(selector) ?? null)),
    insertAdjacentElement(position, child) {
      element.inserted.push({ position, child })
      return child
    },
    click() {
      element.clicks += 1
    },
    scrollIntoView(options) {
      element.scrollOptions = options
    },
    animate(keyframes, options) {
      element.animations.push({ keyframes, options })
      return { cancel() {} }
    },
  }
  return element
}

/** Attach `child` under `parent` and return the child. */
function child(parent, element) {
  element.parentElement = parent
  return element
}

/** Load the browser half once and hand back its internals. */
let loaded
async function load() {
  loaded ??= (async () => {
    let definition
    globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
    await import('../client.js')
    assert.equal(definition.id, 'dsh-flow')
    const module = definition.factory((name) => {
      if (name === 'react') return fakeReact()
      if (name === 'react-dom') return { createPortal: (element) => element }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') {
        return {
          Tooltip: (props) => props.children ?? null,
          Switch: () => null,
          Menu: (props) => props.children ?? null,
          MenuItemButton: (props) => props.children ?? null,
          Toast: (props) => props.text ?? null,
          IconCopyOutlineRegular: () => null,
          IconWarningOutlineRegular: () => null,
          writeClipboard: (text) => typeof text === 'string' && text.length > 0,
        }
      }
      throw new Error(`unexpected require: ${name}`)
    })
    assert.equal(typeof module.apply, 'function')
    assert.equal(module.default, undefined, 'inject metadata must not be folded by a default export')
    return module
  })()
  return loaded
}

/** The slice of React the browser half uses. */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (_subscribe, get) => get(),
  }
}

const session = (id, mainView = 0) => ({ id, retainedBy: { mainView } })
const list = (...rows) => ({ ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])) })

test('currentSessionId reads the row the main column retains', async () => {
  const { currentSessionId } = (await load()).internals
  assert.equal(currentSessionId(list(session('a', 0), session('b', 1), session('c', 2))), 'b')
  assert.equal(currentSessionId(list(session('a'), session('b'))), null)
  assert.equal(currentSessionId({ ids: [], byId: {} }), null)
})

test('findSessionRow addresses the shipped row key only', async () => {
  const { findSessionRow } = (await load()).internals
  const row = node({ attrs: { 'data-row-key': 'session:s1' } })
  const listArea = node({ find: (selector) => (selector === '[data-row-key="session:s1"]' ? row : null) })
  assert.equal(findSessionRow(listArea, 's1'), row)
  assert.equal(findSessionRow(listArea, 's2'), undefined)
  assert.equal(findSessionRow(null, 's1'), undefined)
})

test('owningGroupKey finds the registry workspace, and the ungrouped bucket otherwise', async () => {
  const { owningGroupKey } = (await load()).internals
  const items = [{ workspaceId: 'w1', sessionIds: ['s1'] }, { workspaceId: 'w2', sessionIds: ['s2'] }]
  assert.equal(owningGroupKey(items, 's2'), 'w2')
  assert.equal(owningGroupKey(items, 'stray'), '')
  assert.equal(owningGroupKey(undefined, 'stray'), '')
})

test('revealSessionRow scrolls and flashes a rendered row', async () => {
  const { revealSessionRow } = (await load()).internals
  const row = node({ attrs: { 'data-row-key': 'session:s1' } })
  const listArea = node({ find: (selector) => (selector === '[data-row-key="session:s1"]' ? row : null) })
  assert.deepEqual(revealSessionRow(listArea, 'w1', 's1'), { status: 'revealed' })
  assert.deepEqual(row.scrollOptions, { block: 'nearest' })
  assert.equal(row.animations.length, 1)
})

test('revealSessionRow expands a collapsed group before scrolling', async () => {
  const { revealSessionRow } = (await load()).internals
  const group = node({ attrs: { 'data-row-key': 'workspace:w1', 'aria-expanded': 'false' } })
  const listArea = node({ find: (selector) => (selector === '[data-row-key="workspace:w1"]' ? group : null) })
  assert.deepEqual(revealSessionRow(listArea, 'w1', 's1'), { status: 'expanding-group' })
  assert.equal(group.clicks, 1)
})

test('revealSessionRow raises the group overflow when the row hides behind it', async () => {
  const { revealSessionRow } = (await load()).internals
  // The group is already open, so the missing row can only be a collapsed tail.
  const group = node({ attrs: { 'data-row-key': 'workspace:w1', 'aria-expanded': 'true' } })
  const overflow = node({ attrs: { 'data-row-key': 'overflow:w1' } })
  const listArea = node({
    find: (selector) => {
      if (selector === '[data-row-key="workspace:w1"]') return group
      if (selector === '[data-row-key="overflow:w1"]') return overflow
      return null
    },
  })
  assert.deepEqual(revealSessionRow(listArea, 'w1', 's1'), { status: 'expanding-overflow' })
  assert.equal(overflow.clicks, 1)
  assert.equal(group.clicks, 0)
})

test('revealSessionRow reports a missing seat and an unrendered row', async () => {
  const { revealSessionRow } = (await load()).internals
  assert.deepEqual(revealSessionRow(null, 'w1', 's1'), { status: 'no-list' })
  const listArea = node({ find: () => null })
  assert.deepEqual(revealSessionRow(listArea, 'w1', 's1'), { status: 'missing' })
})

test('resolveListArea walks up from the anchor and never leaves the sidebar', async () => {
  const { resolveListArea } = (await load()).internals
  const listArea = node({ className: 'hash_listArea' })
  const region = node({ find: (selector) => (selector.includes('listArea') ? listArea : null) })
  const footer = node({ find: () => null })
  const root = node({ find: (selector) => (selector.includes('listArea') ? listArea : null) })
  child(root, region)
  child(region, footer)
  const button = child(footer, node({}))
  assert.equal(resolveListArea(button), listArea)
  assert.equal(resolveListArea(node({})), null)
  assert.equal(resolveListArea(null), null)
})

test('resolveHeaderAnchors recognises the header by the search seat it holds', async () => {
  const { resolveHeaderAnchors } = (await load()).internals
  const searchSlot = node({ className: 'hash_searchSlot', find: (selector) => (selector === 'button' ? node({}) : null) })
  const header = node({ className: 'hash_sectionHeader', find: (selector) => (/searchSlot/.test(selector) ? searchSlot : null) })
  const doc = { querySelectorAll: (selector) => (/sectionHeader/.test(selector) ? [header] : []) }
  assert.deepEqual(resolveHeaderAnchors(doc), { header, searchSlot })

  // A rail header carries no search seat at all.
  assert.equal(resolveHeaderAnchors({ querySelectorAll: () => [node({ find: () => null })] }), null)
  // An empty seat is not the seat: the control must actually be inside it.
  const emptySeatHeader = node({ find: (selector) => (/searchSlot/.test(selector) ? node({ find: () => null }) : null) })
  assert.equal(resolveHeaderAnchors({ querySelectorAll: () => [emptySeatHeader] }), null)
  assert.equal(resolveHeaderAnchors(undefined), null)
})

test('attachLocateHost inserts its own container right after the search seat', async () => {
  const { attachLocateHost } = (await load()).internals
  const searchSlot = node({})
  searchSlot.ownerDocument = { createElement: (tag) => node({ tag }) }
  const host = attachLocateHost(searchSlot)
  assert.equal(searchSlot.inserted.length, 1)
  assert.equal(searchSlot.inserted[0].position, 'afterend')
  assert.equal(searchSlot.inserted[0].child, host)
  assert.equal(host.className, 'flow-host')
  assert.equal(host.dataset.flowHost, 'locate')
})

test('locateCurrentSession reports every outcome it can reach', async () => {
  const { locateCurrentSession } = (await load()).internals

  const row = node({ attrs: { 'data-row-key': 'session:s1' } })
  const listArea = node({ find: (selector) => (selector === '[data-row-key="session:s1"]' ? row : null) })
  const anchor = node({})
  const workspaceList = { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] }

  assert.deepEqual(
    locateCurrentSession({ anchor, listArea, sessionList: list(), workspaceList }),
    { status: 'no-session' },
  )
  assert.deepEqual(
    locateCurrentSession({ anchor, listArea, sessionList: list(session('s1', 1)), workspaceList }),
    { status: 'revealed' },
  )
  // No seat: the browsing region may simply not have mounted yet, so the
  // caller gets one more frame before this counts as a miss.
  assert.deepEqual(
    locateCurrentSession({ anchor, listArea: null, sessionList: list(session('s1', 1)), workspaceList }),
    { status: 'retry' },
  )
  // Seat present, row nowhere: a real miss, never a silent success.
  assert.deepEqual(
    locateCurrentSession({
      anchor,
      listArea: node({ find: () => null }),
      sessionList: list(session('s1', 1)),
      workspaceList,
    }),
    { status: 'missing' },
  )
})

test('reads the toggle from the config form, defaulting to shown', async () => {
  const { readLocateEnabled } = (await load()).internals
  assert.equal(readLocateEnabled({ getSnapshot: () => ({ value: {} }) }), true)
  assert.equal(readLocateEnabled({ getSnapshot: () => ({ value: { locateButton: false } }) }), false)
  assert.equal(readLocateEnabled({ getSnapshot: () => ({ value: { locateButton: true } }) }), true)
  assert.equal(readLocateEnabled({ getSnapshot: () => { throw new Error('no host') } }), true)
})

test('apply registers the footer button, the 心流 section and the copy seats', async () => {
  const module = await load()
  const { MENU_ORDER } = module.internals
  const registrations = []
  const effects = []
  const commands = []
  const ctx = fakeContext(registrations, effects, { commands })
  module.apply(ctx)

  const footer = registrations.find((entry) => entry.name === 'sidebar.footer.action')
  assert.equal(footer.id, 'flow')
  assert.equal(typeof footer.order, 'number')

  const section = registrations.find((entry) => entry.name === 'settings.section')
  assert.equal(section.id, 'flow')
  assert.equal(section.label(), '心流')
  assert.ok(section.order < 40, 'must land ahead of the shipped third-party sections')

  // Both application commands, registered for the plugin's whole lifetime.
  assert.deepEqual(commands.map((command) => command.id), ['flow.locateCurrent', 'flow.copySessionId'])
  assert.equal(commands[0].label(), '定位当前会话')
  assert.equal(commands[1].label(), '复制会话 ID')

  // The copy feature adds two seats of its own: the Session row menu row a
  // right-click opens, and the overlay a finished copy reports through.
  const menu = registrations.find((entry) => entry.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.id, 'flow')
  assert.equal(menu.locale, 'flow')
  assert.equal(menu.order, MENU_ORDER)
  const overlays = registrations.filter((entry) => entry.name === 'shell.overlay')
  assert.deepEqual(overlays.map((entry) => entry.id), ['flow', 'flow.code-menu', 'flow.changes-menu'])
  assert.equal(overlays[0].locale, 'flow')
  // Each floating surface is its own cell of the same list slot rather than a
  // second surface sharing the notice's cell.
  for (const overlay of overlays.slice(1)) {
    assert.equal(overlay.locale, 'flow')
    assert.notEqual(overlay.id, overlays[0].id)
  }

  // Every registration the module makes is released with its fiber.
  assert.ok(effects.length >= 5)
  assert.ok(registrations.length >= 4)
})

test('the section is withheld until the Host serves the flow namespace', async () => {
  const module = await load()
  const registrations = []
  const gated = fakeContext(registrations, [], { served: false })
  module.apply(gated)
  assert.equal(registrations.some((entry) => entry.name === 'settings.section'), false)
  // The button is never gated on the settings transport.
  assert.equal(registrations.some((entry) => entry.name === 'sidebar.footer.action'), true)
})

test('the seat hands the mounted button to the command, and nothing else', async () => {
  const { createLocateSeat } = (await load()).internals
  const seat = createLocateSeat()
  assert.equal(seat.current(), null)
  const handler = { available: () => true, run: () => {} }
  const clear = seat.publish(handler)
  assert.equal(seat.current(), handler)
  // A later mount replaces the first, and the first disposer must not clear it.
  const second = { available: () => false, run: () => {} }
  const clearSecond = seat.publish(second)
  clear()
  assert.equal(seat.current(), second)
  clearSecond()
  assert.equal(seat.current(), null)
})

test('the command refuses a press it cannot honour, and never silently', async () => {
  const { createLocateSeat, locateCommand, LOCATE_COMMAND, LOCATE_DEFAULTS } = (await load()).internals
  const seat = createLocateSeat()
  const command = locateCommand(seat, () => '定位当前会话', {
    unmounted: () => '侧边栏已折叠，定位按钮当前不在界面上',
    noSession: () => '当前没有打开的会话',
  })

  assert.equal(command.id, LOCATE_COMMAND)
  assert.deepEqual(command.defaults, LOCATE_DEFAULTS)
  assert.equal(command.label(), '定位当前会话')
  assert.deepEqual([...command.regions], ['page', 'editable'])

  // Folded sidebar: the button has no rail form, so there is no handler at all.
  assert.deepEqual(command.resolve(), { status: 'blocked', reason: '侧边栏已折叠，定位按钮当前不在界面上' })

  let ran = 0
  const mounted = { available: () => false, run: () => { ran += 1 } }
  seat.publish(mounted)
  assert.deepEqual(command.resolve(), { status: 'blocked', reason: '当前没有打开的会话' })
  assert.equal(ran, 0)

  mounted.available = () => true
  const resolution = command.resolve()
  assert.equal(resolution.status, 'handled')
  // The action captures the handler it resolved against.
  seat.publish({ available: () => false, run: () => { ran += 100 } })
  resolution.run()
  assert.equal(ran, 1)
})

test('the shortcut defaults stay inside what every declared profile admits', async () => {
  const { LOCATE_DEFAULTS, LOCATE_COMMAND } = (await load()).internals
  const profiles = Object.keys(LOCATE_DEFAULTS)
  assert.deepEqual(profiles.sort(), [
    'desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows',
  ])
  // Linux Web admits none of these shapes, so declaring it would throw at
  // registration and take the whole client half down.
  assert.equal(profiles.includes('web:linux'), false)
  for (const [profile, binding] of Object.entries(LOCATE_DEFAULTS)) {
    assert.equal(binding.code, 'KeyD', profile)
    assert.deepEqual(binding.modifiers, ['primary', 'shift'], profile)
  }
  assert.equal(LOCATE_COMMAND.startsWith('flow.'), true)
})

/** The copy surfaces' dictionary slice, so assertions read the shipped sentences. */
const copyCopy = {
  'copy.noSession': '当前没有打开的会话',
  'copy.done': '已复制会话 ID',
  'copy.failed': '复制失败，剪贴板不可用',
}

test('readCopyEnabled defaults to on and only an explicit false turns it off', async () => {
  const { readCopyEnabled } = (await load()).internals
  assert.equal(readCopyEnabled({ getSnapshot: () => ({ value: {} }) }), true)
  assert.equal(readCopyEnabled({ getSnapshot: () => ({ value: { copySessionId: false } }) }), false)
  assert.equal(readCopyEnabled({ getSnapshot: () => ({ value: { copySessionId: true } }) }), true)
  assert.equal(readCopyEnabled({ getSnapshot: () => { throw new Error('no host') } }), true)
})

test('the notice store hands out one fresh snapshot per notice', async () => {
  const { createNoticeStore } = (await load()).internals
  const store = createNoticeStore()
  assert.equal(store.getSnapshot(), null)

  let wakes = 0
  const off = store.subscribe(() => { wakes += 1 })
  store.show('已复制会话 ID', 'success')
  // A new object each time is the contract: React compares by identity.
  assert.deepEqual(store.getSnapshot(), { seq: 1, text: '已复制会话 ID', tone: 'success' })
  assert.equal(wakes, 1)

  // A second notice carries a new sequence, which remounts the Toast.
  store.show('复制失败，剪贴板不可用', 'warning')
  assert.equal(store.getSnapshot().seq, 2)
  assert.equal(store.getSnapshot().tone, 'warning')
  assert.equal(wakes, 2)

  off()
  store.clear()
  assert.equal(store.getSnapshot(), null)
  assert.equal(wakes, 2, 'an unsubscribed listener stays silent')
  store.clear()
  assert.equal(wakes, 2, 'clearing an empty store is not a second wake-up')
})

test('the code-menu seat mints one fresh snapshot per open', async () => {
  const { createCodeMenuStore } = (await load()).internals
  const store = createCodeMenuStore()
  assert.equal(store.getSnapshot(), null)

  let wakes = 0
  const off = store.subscribe(() => { wakes += 1 })
  const element = { nodeType: 1 }
  store.open({ x: 120, y: 240, text: 'npm test', element })
  const first = store.getSnapshot()
  assert.deepEqual(first, { seq: 1, x: 120, y: 240, text: 'npm test', element })
  assert.equal(wakes, 1)

  // The very same press point again is still a new object: React compares
  // snapshots by identity, so a re-open has to re-render.
  store.open({ x: 120, y: 240, text: 'npm test', element })
  assert.equal(store.getSnapshot() === first, false)
  assert.equal(store.getSnapshot().seq, 2)
  assert.equal(wakes, 2)

  off()
  store.close()
  assert.equal(store.getSnapshot(), null)
  assert.equal(wakes, 2, 'an unsubscribed listener stays silent')
  store.close()
  assert.equal(wakes, 2, 'closing an empty seat is not a second wake-up')
})

test("a path-looking code resolves to its probe path and its absolute path", async () => {
  const { pathTarget } = (await load()).internals
  assert.deepEqual(pathTarget("~/x", "/Users/a", "/work"), { probe: "/Users/a/x", absolute: "/Users/a/x" })
  assert.deepEqual(pathTarget("src/a.ts", null, "/work/"), { probe: "src/a.ts", absolute: "/work/src/a.ts" })
  assert.deepEqual(pathTarget("/tmp/x", null, "/work"), { probe: "/tmp/x", absolute: "/tmp/x" })
  // No home, no workspace root, empty text: nothing to hang a menu on.
  assert.equal(pathTarget("~/x", null, "/work"), null)
  assert.equal(pathTarget("src/a.ts", null, null), null)
  assert.equal(pathTarget("", "/Users/a", "/work"), null)
  // Whitespace means a sentence, a command line or prose — never a path, and
  // never worth a probe: the menu stays copy-only.
  assert.equal(pathTarget("PhysMem: 23G used, 120M unused", "/Users/a", "/work"), null)
  assert.equal(pathTarget("npm test", "/Users/a", "/work"), null)
})

test("a file is offered only the IDEs, while a directory lists every installed application", async () => {
  const { applicationsForKind } = (await load()).internals
  const rows = [
    { key: "vscode", id: "vscode", label: "VS Code", kind: "ide", icon: "/open-in-app/icon/vscode" },
    { key: "finder", id: "finder", label: "访达", kind: "files", icon: "/open-in-app/icon/finder" },
    { key: "terminal", id: "terminal", label: "终端", kind: "terminal", icon: "/open-in-app/icon/terminal" },
  ]
  assert.deepEqual(applicationsForKind(rows, "file").map((row) => row.id), ["vscode"])
  assert.deepEqual(applicationsForKind(rows, "directory").map((row) => row.id), ["vscode", "finder", "terminal"])
  // An unknown kind reads as a file: the Host's own route enforces the same rule.
  assert.deepEqual(applicationsForKind(rows, undefined).map((row) => row.id), ["vscode"])
  assert.deepEqual(applicationsForKind(null, "file"), [])
})

test("the code menu is copy-first once the code names a path", async () => {
  const { codeMenuRows } = (await load()).internals
  assert.deepEqual(codeMenuRows(null), [])
  // A code that names no path keeps the shipped pair.
  assert.deepEqual(codeMenuRows({ text: "npm test" }), [
    { key: "open", kind: "open", labelKey: "codeMenu.open" },
    { key: "copy", kind: "copy", labelKey: "codeMenu.copy" },
  ])
  // Nothing can open it: copy alone, no probe, no dead 「打开」.
  assert.deepEqual(codeMenuRows({ text: "npm test", copyOnly: true }), [
    { key: "copy", kind: "copy", labelKey: "codeMenu.copy" },
  ])
  // A path whose probe is still out: copy alone, so no row shifts under the pointer.
  assert.deepEqual(codeMenuRows({ text: "src/a.ts", path: "/w/a.ts", apps: [] }), [
    { key: "copy", kind: "copy", labelKey: "codeMenu.copy" },
  ])
  const apps = [{ key: "vscode", id: "vscode", label: "VS Code", kind: "ide", icon: null }]
  assert.deepEqual(codeMenuRows({ text: "src/a.ts", path: "/w/a.ts", kind: "file", apps }), [
    { key: "copy", kind: "copy", labelKey: "codeMenu.copy" },
    { key: "vscode", kind: "app", app: apps[0] },
  ])
})

test("the catalog rows carry the shipped label, the kind and the host icon route", async () => {
  const { catalogApplications } = (await load()).internals
  const t = (key) => ({ "app.finder": "访达", "app.vscode": "VS Code" }[key] ?? key)
  assert.deepEqual(catalogApplications([
    { id: "finder", name: "Finder", kind: "files" },
    { id: "vscode", name: "VS Code", kind: "ide" },
    { id: "brand-new", name: "Brand New", kind: "terminal" },
  ], t), [
    { key: "finder", id: "finder", label: "访达", kind: "files", icon: "/open-in-app/icon/finder" },
    { key: "vscode", id: "vscode", label: "VS Code", kind: "ide", icon: "/open-in-app/icon/vscode" },
    // An id this plugin predates keeps the Host's own name rather than the id.
    { key: "brand-new", id: "brand-new", label: "Brand New", kind: "terminal", icon: "/open-in-app/icon/brand-new" },
  ])
  assert.deepEqual(catalogApplications([null, 7, { name: "no id" }, { id: "" }], t), [])
  assert.deepEqual(catalogApplications(null, t), [])
})

test('the application catalog is asked once per page, and a failed answer is retried', async () => {
  const { createAppsLookup, APPS_ROUTE } = (await load()).internals
  const calls = []
  const fetch = (route, init) => {
    calls.push({ route, init })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ apps: [{ id: "vscode", name: "VS Code", kind: "ide" }] }) })
  }
  const lookup = createAppsLookup({ fetch })
  const first = await lookup()
  const second = await lookup()
  assert.equal(calls.length, 1, "one page asks once")
  assert.equal(second, first, "the remembered answer is handed back")
  assert.deepEqual(first, [{ id: "vscode", name: "VS Code", kind: "ide" }])
  assert.equal(calls[0].route, APPS_ROUTE)
  assert.equal(calls[0].init.credentials, "same-origin")

  // A failure is not remembered: the Host may be restarting, and a menu that
  // stayed empty for the rest of the page's life would be worse than a retry.
  const retried = []
  const failing = createAppsLookup({ fetch: (route, init) => { retried.push({ route, init }); return Promise.resolve({ ok: false }) } })
  assert.deepEqual(await failing(), [])
  assert.deepEqual(await failing(), [])
  assert.equal(retried.length, 2, "a failed answer is asked again")
})

test("the workspace root comes off the session snapshot", async () => {
  const { sessionCwd } = (await load()).internals
  assert.equal(sessionCwd({ byId: { s1: { cwd: "/work" } } }, "s1"), "/work")
  assert.equal(sessionCwd({ byId: { s1: {} } }, "s1"), null)
  assert.equal(sessionCwd({ byId: {} }, "s1"), null)
  assert.equal(sessionCwd(null, "s1"), null)
})

test("a menu patch only lands on the menu the probe was measured for", async () => {
  const { createCodeMenuStore } = (await load()).internals
  const store = createCodeMenuStore()
  const first = store.open({ x: 1, y: 2, text: "~/x", element: {} })
  const second = store.open({ x: 3, y: 4, text: "~/y", element: {} })
  store.mark(first, { directory: true })
  assert.equal(store.getSnapshot().directory, undefined, "the first menu is already gone")
  assert.equal(store.getSnapshot().text, "~/y")
  store.mark(second, { directory: true, absolute: "/Users/a/y" })
  assert.equal(store.getSnapshot().directory, true)
  assert.equal(store.getSnapshot().absolute, "/Users/a/y")
  store.close()
  store.mark(second, { directory: false })
  assert.equal(store.getSnapshot(), null, "a closed menu takes no patch")
})

/** The `<code>` of a markdown body, plus the event that right-clicked it. */
function inlineCode({ text = 'npm test', pre = false, editable = false, anchor = false, markdown = true, node = true } = {}) {
  const element = { nodeType: 1, textContent: text }
  element.closest = (selector) => {
    if (selector === 'code') return element
    if (selector === 'pre') return pre ? { nodeType: 1 } : null
    if (selector === '[contenteditable]') return editable ? { nodeType: 1 } : null
    if (selector === 'a[href]') return anchor ? { nodeType: 1 } : null
    if (selector === '[class*="_markdown_"]') return markdown ? { nodeType: 1 } : null
    return null
  }
  const target = node ? { nodeType: 1, closest: (selector) => (selector === 'code' ? element : null) } : {}
  return { element, event: { target } }
}

test('codeMenuTarget claims one inline code in a markdown body, and nothing else', async () => {
  const { codeMenuTarget } = (await load()).internals

  const hit = inlineCode({ text: '  npm test\n' })
  assert.deepEqual(codeMenuTarget(hit.event), { element: hit.element, text: 'npm test' })

  // A fenced block (`pre > code`) is multi-line and out of scope.
  assert.equal(codeMenuTarget(inlineCode({ pre: true }).event), null)
  // The composer and the shortcut editor render code into a contenteditable.
  assert.equal(codeMenuTarget(inlineCode({ editable: true }).event), null)
  // An anchor already belongs to the off-origin link hand-off.
  assert.equal(codeMenuTarget(inlineCode({ anchor: true }).event), null)
  // Whitespace is not a snippet.
  assert.equal(codeMenuTarget(inlineCode({ text: '   \n ' }).event), null)
  // Outside markdown — a tool card, a settings page, another plugin's panel.
  assert.equal(codeMenuTarget(inlineCode({ markdown: false }).event), null)
  // A press that never reached a `code` at all.
  assert.equal(codeMenuTarget(inlineCode({ node: false }).event), null)
  assert.equal(codeMenuTarget({ target: { closest: () => null } }), null)
  assert.equal(codeMenuTarget({ target: null }), null)
  assert.equal(codeMenuTarget({}), null)
  assert.equal(codeMenuTarget(undefined), null)
})

test('opening inline code activates the control the shell made clickable', async () => {
  const { clickTargetOf, activateInlineCode } = (await load()).internals

  // The shipped renderer puts the open handler on `code > button`, never on the
  // `code` itself, so the click has to be dispatched at the button.
  const mention = { nodeType: 1 }
  const code = { nodeType: 1, querySelector: (selector) => (selector === 'button' ? mention : null) }
  assert.equal(clickTargetOf(code), mention)
  const plain = { nodeType: 1, querySelector: () => null }
  assert.equal(clickTargetOf(plain), plain)
  assert.equal(clickTargetOf(null), null)

  const seen = []
  const view = { MouseEvent: class MouseEvent { constructor(type, init) { this.type = type; this.init = init } } }
  // A shell handler that calls preventDefault makes dispatchEvent answer false;
  // the click was still dispatched, which is all this reports.
  mention.dispatchEvent = (event) => { seen.push(event); return false }
  assert.equal(activateInlineCode(code, view), true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].type, 'click')
  assert.deepEqual(seen[0].init, { bubbles: true, cancelable: true, view })
  // No MouseEvent constructor is a refusal, never a throw.
  assert.equal(activateInlineCode(code, {}), false)
  assert.equal(activateInlineCode(null, view), false)
})

test('a context-menu press on inline code is claimed, and any other press is left alone', async () => {
  const { handleCodeContextMenu } = (await load()).internals
  const hit = inlineCode({ text: 'npm test' })
  const claimed = {
    ...hit.event,
    clientX: 120,
    clientY: 240,
    prevented: 0,
    stopped: 0,
    preventDefault() { claimed.prevented += 1 },
    stopPropagation() { claimed.stopped += 1 },
  }
  const opened = []
  assert.equal(handleCodeContextMenu(claimed, { open: (menu) => opened.push(menu) }), true)
  assert.deepEqual(opened, [{ x: 120, y: 240, text: 'npm test', element: hit.element }])
  assert.equal(claimed.prevented, 1, 'the shell must not also open a menu')
  assert.equal(claimed.stopped, 1)

  const passed = {
    target: { closest: () => null },
    clientX: 0,
    clientY: 0,
    prevented: 0,
    stopped: 0,
    preventDefault() { passed.prevented += 1 },
    stopPropagation() { passed.stopped += 1 },
  }
  assert.equal(handleCodeContextMenu(passed, { open: () => { throw new Error('nothing to open') } }), false)
  assert.equal(passed.prevented, 0, 'a press that is not ours keeps the shell behaviour')
  assert.equal(passed.stopped, 0)
})

test('readCodeMenuEnabled defaults to on and only an explicit false turns it off', async () => {
  const { readCodeMenuEnabled } = (await load()).internals
  assert.equal(readCodeMenuEnabled({ getSnapshot: () => ({ value: {} }) }), true)
  assert.equal(readCodeMenuEnabled({ getSnapshot: () => ({ value: { codeMenu: false } }) }), false)
  assert.equal(readCodeMenuEnabled({ getSnapshot: () => ({ value: { codeMenu: true } }) }), true)
  assert.equal(readCodeMenuEnabled({ getSnapshot: () => { throw new Error('no host') } }), true)
})

test('the inline-code listeners exist only while the preference is on', async () => {
  const module = await load()
  const added = []
  const removed = []
  const cursor = new Set()
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    documentElement: {
      setAttribute: (name, value) => cursor.add(name + '=' + value),
      removeAttribute: (name) => cursor.delete(name + '=true'),
    },
    addEventListener: (type, listener, capture) => added.push({ type, listener, capture }),
    removeEventListener: (type, listener, capture) => removed.push({ type, listener, capture }),
  }
  try {
    // The changed-file menu is another feature's listener; it is held off here
    // so this assertion stays about the inline-code pair alone.
    const form = fakeForm({ codeMenu: true, changesFileOpen: false, composerHistory: false })
    module.apply(fakeContext([], [], { form }))
    // `click` first is the off-origin link hand-off, which is a separate
    // feature; the menu press and the path press are the two below it.
    assert.deepEqual(added.map((entry) => [entry.type, entry.capture]), [['click', true], ['contextmenu', true], ['click', true]])
    // The pointer cursor rides the same switch: code is only clickable while the
    // menu owns the press.
    assert.deepEqual([...cursor], ['data-flow-code-cursor=true'])

    // A Host echo that turns the feature off detaches both listeners instead of
    // leaving ones behind that decide to do nothing.
    form.publish({ codeMenu: false, changesFileOpen: false, composerHistory: false })
    assert.deepEqual(removed, [
      { type: 'contextmenu', listener: added[1].listener, capture: true },
      { type: 'click', listener: added[2].listener, capture: true },
    ])
    assert.deepEqual([...cursor], [], 'turning the feature off takes the cursor with it')
    form.publish({ codeMenu: false, changesFileOpen: false, composerHistory: false })
    assert.equal(removed.length, 2, 'already detached listeners are not removed twice')

    // Turning it back on binds both again, and nothing else. The changed-file
    // menu keeps its own preference off throughout, so it never joins in.
    form.publish({ codeMenu: true, changesFileOpen: false, composerHistory: false })
    assert.deepEqual(added.map((entry) => entry.type), ['click', 'contextmenu', 'click', 'contextmenu', 'click'])
    assert.equal(added[3].capture, true)
    assert.equal(added[4].capture, true)
    assert.deepEqual([...cursor], ['data-flow-code-cursor=true'])
  } finally {
    delete globalThis.document
  }
})

test('copyInlineCode reports both outcomes instead of failing quietly', async () => {
  const { copyInlineCode } = (await load()).internals
  const seen = []
  const notify = (text, tone) => seen.push([text, tone])
  const t = (key) => ({ 'codeMenu.done': '已复制行内代码', 'codeMenu.failed': '复制失败，剪贴板不可用' }[key])

  assert.equal(await copyInlineCode({ text: 'npm test', write: (text) => text === 'npm test', notify, t }), true)
  assert.deepEqual(seen, [['已复制行内代码', 'success']])
  assert.equal(await copyInlineCode({ text: 'npm test', write: () => false, notify, t }), false)
  assert.deepEqual(seen[1], ['复制失败，剪贴板不可用', 'warning'])
  // A clipboard that throws is still a reported failure, never a rejection.
  assert.equal(await copyInlineCode({ text: 'npm test', write: () => { throw new Error('denied') }, notify, t }), false)
  assert.deepEqual(seen[2], ['复制失败，剪贴板不可用', 'warning'])
})

test('copySessionId reports both outcomes instead of failing quietly', async () => {
  const { copySessionId } = (await load()).internals
  const seen = []
  const notify = (text, tone) => seen.push([text, tone])
  const t = (key) => copyCopy[key]

  assert.equal(await copySessionId({ sessionId: 's1', write: (text) => text === 's1', notify, t }), true)
  assert.deepEqual(seen, [['已复制会话 ID', 'success']])

  assert.equal(await copySessionId({ sessionId: 's1', write: () => false, notify, t }), false)
  assert.deepEqual(seen[1], ['复制失败，剪贴板不可用', 'warning'])

  // A clipboard that throws is still a reported failure, never a rejection.
  const thrown = await copySessionId({ sessionId: 's1', write: () => { throw new Error('denied') }, notify, t })
  assert.equal(thrown, false)
  assert.deepEqual(seen[2], ['复制失败，剪贴板不可用', 'warning'])
})

test('the copy command hands the key back while the preference is off', async () => {
  const { copyCommand, COPY_COMMAND, COPY_DEFAULTS } = (await load()).internals
  let copied = 0
  const command = copyCommand({
    label: () => '复制会话 ID',
    enabled: () => false,
    currentSessionId: () => 's1',
    copy: () => { copied += 1 },
    notify: () => { throw new Error('a feature that is off must not speak') },
    t: (key) => copyCopy[key],
  })

  assert.equal(command.id, COPY_COMMAND)
  assert.deepEqual(command.defaults, COPY_DEFAULTS)
  assert.equal(command.label(), '复制会话 ID')
  assert.deepEqual([...command.regions], ['page', 'editable'])
  assert.deepEqual([...command.modals], [])
  // Passing the gesture on is the point: an off feature must not swallow it.
  assert.deepEqual(command.resolve(), { status: 'pass' })
  assert.equal(copied, 0)
})

test('the copy command copies the Session the conversation column holds', async () => {
  const { copyCommand } = (await load()).internals
  const copied = []
  const command = copyCommand({
    label: () => '复制会话 ID',
    enabled: () => true,
    currentSessionId: () => 's7',
    copy: (sessionId) => copied.push(sessionId),
    notify: () => { throw new Error('a successful copy reports through copy()') },
    t: (key) => copyCopy[key],
  })

  const resolution = command.resolve()
  assert.equal(resolution.status, 'handled')
  // The action captures the Session it resolved against.
  resolution.run()
  assert.deepEqual(copied, ['s7'])
})

test('the copy command says so, in words, when no Session is open', async () => {
  const { copyCommand } = (await load()).internals
  const notices = []
  const command = copyCommand({
    label: () => '复制会话 ID',
    enabled: () => true,
    currentSessionId: () => null,
    copy: () => { throw new Error('there is nothing to copy') },
    notify: (text, tone) => notices.push([text, tone]),
    t: (key) => copyCopy[key],
  })

  const resolution = command.resolve()
  // Never blocked: the shell drops a blocked reason on the floor, and a press
  // that does nothing visible is the one outcome this feature must not have.
  assert.equal(resolution.status, 'handled')
  resolution.run()
  assert.deepEqual(notices, [['当前没有打开的会话', 'warning']])
})

test('the copy defaults claim the copy combination on every admitting profile', async () => {
  const { COPY_COMMAND, COPY_DEFAULTS, LOCATE_COMMAND } = (await load()).internals
  const profiles = Object.keys(COPY_DEFAULTS)
  // Web Linux admits only Mod+Slash, Mod+Shift+Comma and Mod+Shift+Period, and
  // every shell that is not macOS or Windows reserves a primary modifier with
  // KeyC for the browser's own copy. Declaring either throws at registration,
  // and a throw takes the whole client half down with it — which is exactly how
  // this combination failed when it was first declared for all five profiles.
  assert.equal(profiles.includes('web:linux'), false)
  assert.equal(profiles.includes('desktop:linux'), false)
  assert.equal(profiles.length, 4)
  for (const [profile, binding] of Object.entries(COPY_DEFAULTS)) {
    assert.equal(binding.code, 'KeyC', profile)
    assert.deepEqual(binding.modifiers, ['primary', 'shift'], profile)
  }
  assert.equal(COPY_COMMAND.startsWith('flow.'), true)
  assert.notEqual(COPY_COMMAND, LOCATE_COMMAND)
})

test('both dictionaries stay complete, copy included', async () => {
  const module = await load()
  const recorded = []
  module.apply(fakeContext([], [], { recorded }))
  const flow = recorded.find((entry) => entry.ns === 'flow')
  assert.ok(flow, 'the plugin registers its dictionary under its own namespace')
  assert.deepEqual(Object.keys(flow.en).sort(), Object.keys(flow.zh).sort())
  for (const key of [
    'copy.label',
    'copy.menu',
    'copy.done',
    'copy.failed',
    'copy.noSession',
    'section.copy.title',
    'section.copy.description',
    'section.external.title',
    'section.external.description',
  ]) {
    assert.equal(typeof flow.zh[key], 'string', key)
    assert.notEqual(flow.zh[key].length, 0, key)
    assert.equal(typeof flow.en[key], 'string', key)
  }
  for (const key of [
    'codeMenu.open',
    'codeMenu.copy',
    'codeMenu.done',
    'codeMenu.failed',
    'section.codeMenu.title',
    'section.codeMenu.description',
    'section.sendKey.title',
    'section.sendKey.description',
    'changesFile.open',
    'changesFile.reveal',
    'changesFile.failed',
    'changesFile.revealFailed',
    'section.changesFile.title',
    'section.changesFile.description',
  ]) {
    assert.equal(typeof flow.zh[key], 'string', key)
    assert.notEqual(flow.zh[key].length, 0, key)
    assert.equal(typeof flow.en[key], 'string', key)
  }
  assert.equal(flow.zh['copy.menu'], '复制会话 ID')
  assert.equal(flow.zh['copy.done'], '已复制会话 ID')
  assert.equal(flow.zh['copy.failed'], '复制失败，剪贴板不可用')
  assert.equal(flow.zh['codeMenu.open'], '打开')
  assert.equal(flow.zh['codeMenu.copy'], '复制')
  assert.equal(flow.zh['codeMenu.done'], '已复制行内代码')
  assert.equal(flow.zh['changesFile.open'], '用默认应用打开')
  assert.equal(flow.zh['changesFile.reveal'], '在文件管理器中显示')
  assert.equal(flow.zh['changesFile.failed'], '无法用默认应用打开这个文件')
  assert.equal(flow.zh['changesFile.revealFailed'], '无法在文件管理器中显示这个文件')
})

test('readExternalLinkEnabled defaults to on and only an explicit false turns it off', async () => {
  const { readExternalLinkEnabled } = (await load()).internals
  assert.equal(readExternalLinkEnabled({ getSnapshot: () => ({ value: {} }) }), true)
  assert.equal(readExternalLinkEnabled({ getSnapshot: () => ({ value: { externalLink: false } }) }), false)
  assert.equal(readExternalLinkEnabled({ getSnapshot: () => ({ value: { externalLink: true } }) }), true)
  assert.equal(readExternalLinkEnabled({ getSnapshot: () => { throw new Error('no host') } }), true)
})

/** An event whose target sits inside one anchor. */
function clickOn(href) {
  const event = {
    target: { closest: (selector) => (selector === 'a[href]' ? { href } : null) },
    prevented: 0,
    stopped: 0,
    preventDefault() { event.prevented += 1 },
    stopPropagation() { event.stopped += 1 },
  }
  return event
}

const BASE = 'http://127.0.0.1:43129/'
const ORIGIN = 'http://127.0.0.1:43129'

test('linkOf claims an off-origin anchor on an opener scheme, and nothing else', async () => {
  const { linkOf } = (await load()).internals
  assert.equal(linkOf(clickOn('http://127.0.0.1:5173/app'), BASE, ORIGIN), 'http://127.0.0.1:5173/app')
  assert.equal(linkOf(clickOn('https://example.com/a?b=1'), BASE, ORIGIN), 'https://example.com/a?b=1')
  // mailto and tel have no origin at all, so they are off-origin by definition.
  assert.equal(linkOf(clickOn('mailto:someone@example.com'), BASE, ORIGIN), 'mailto:someone@example.com')
  assert.equal(linkOf(clickOn('tel:+8613800138000'), BASE, ORIGIN), 'tel:+8613800138000')

  // The application's own navigation must never be captured.
  assert.equal(linkOf(clickOn('/sessions/1'), BASE, ORIGIN), null)
  assert.equal(linkOf(clickOn('http://127.0.0.1:43129/sessions/1'), BASE, ORIGIN), null)
  // Schemes the platform opener must not be handed.
  assert.equal(linkOf(clickOn('file:///etc/passwd'), BASE, ORIGIN), null)
  assert.equal(linkOf(clickOn('javascript:alert(1)'), BASE, ORIGIN), null)
  assert.equal(linkOf(clickOn('data:text/html,x'), BASE, ORIGIN), null)
  // A value the URL parser refuses is not a link either.
  assert.equal(linkOf(clickOn('http://['), BASE, ORIGIN), null)

  // Clicks that are not inside an anchor never reach the capture path.
  assert.equal(linkOf({ target: { closest: () => null } }, BASE, ORIGIN), null)
  assert.equal(linkOf({ target: null }, BASE, ORIGIN), null)
  assert.equal(linkOf({}, BASE, ORIGIN), null)
})

/** The fetch stub the click tests record through. */
function recordingFetch(calls, answer = () => Promise.resolve({ ok: true })) {
  return (route, init) => { calls.push({ route, init }); return answer() }
}

test('handleAnchorClick takes an off-origin click and hands it to the host', async () => {
  const { handleAnchorClick, OPEN_ROUTE } = (await load()).internals
  const event = clickOn('https://example.com/x')
  const calls = []
  const handled = handleAnchorClick(event, {
    enabled: () => true,
    base: BASE,
    origin: ORIGIN,
    fetch: recordingFetch(calls),
    fallback: () => { throw new Error('a served click needs no fallback') },
  })
  assert.equal(handled, true)
  assert.equal(event.prevented, 1)
  assert.equal(event.stopped, 1)
  // The post rides a promise turn, so that a transport that throws is still a
  // refusal to report rather than an exception out of a click listener.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].route, OPEN_ROUTE)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { url: 'https://example.com/x' })
})

test('handleAnchorClick leaves the click to the application while the preference is off', async () => {
  const { handleAnchorClick } = (await load()).internals
  const event = clickOn('https://example.com/x')
  const calls = []
  const handled = handleAnchorClick(event, {
    enabled: () => false,
    base: BASE,
    origin: ORIGIN,
    fetch: recordingFetch(calls),
    fallback: () => { throw new Error('a feature that is off must not open anything') },
  })
  assert.equal(handled, false)
  // Handing the gesture back is the point: the shell's own behaviour is intact.
  assert.equal(event.prevented, 0)
  assert.equal(event.stopped, 0)
  assert.deepEqual(calls, [])
})

test('handleAnchorClick leaves a link it does not own alone', async () => {
  const { handleAnchorClick } = (await load()).internals
  const calls = []
  const event = clickOn('/sessions/1')
  assert.equal(handleAnchorClick(event, {
    enabled: () => true,
    base: BASE,
    origin: ORIGIN,
    fetch: recordingFetch(calls),
    fallback: () => {},
  }), false)
  assert.equal(event.prevented, 0)
  assert.deepEqual(calls, [])
})

test('handleAnchorClick falls back to the page when the host cannot be reached', async () => {
  const { handleAnchorClick } = (await load()).internals
  const fellBack = []
  const event = clickOn('https://example.com/x')
  assert.equal(handleAnchorClick(event, {
    enabled: () => true,
    base: BASE,
    origin: ORIGIN,
    fetch: () => Promise.reject(new Error('host unreachable')),
    fallback: (url) => fellBack.push(url),
  }), true)
  // The fallback rides the rejection, so it is a later turn by construction.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fellBack, ['https://example.com/x'])
})

test('apply listens for anchor clicks, inline-code context menus and path presses in the capture phase, and stops on dispose', async () => {
  const module = await load()
  const listeners = []
  const removed = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
    removeEventListener: (type, listener) => removed.push({ type, listener }),
  }
  try {
    const disposers = []
    module.apply(fakeContext([], [], { disposers }))
    // Five separate capture-phase listeners: the link hand-off, the inline-code
    // menu press, the inline-code path press, the changed-file menu press, and
    // the recalled-messages arrow press. None can be reached through another's
    // registration.
    assert.deepEqual(listeners.map((entry) => [entry.type, entry.capture]), [['click', true], ['contextmenu', true], ['click', true], ['contextmenu', true], ['keydown', true]])
    assert.deepEqual(removed, [])
    // Every listener is registered by an effect, so the fiber owns their lifetimes.
    for (const dispose of disposers) dispose()
    assert.deepEqual(removed, [
      { type: 'click', listener: listeners[0].listener },
      { type: 'contextmenu', listener: listeners[1].listener },
      { type: 'click', listener: listeners[2].listener },
      { type: 'contextmenu', listener: listeners[3].listener },
      { type: 'keydown', listener: listeners[4].listener },
    ])
  } finally {
    delete globalThis.document
  }
})

/** A client-root stub with exactly the services the module injects. */
/**
 * A config form stub whose value the Host can republish, the way the settings
 * projection does when a preference write lands.
 */
function fakeForm(value = {}) {
  const listeners = new Set()
  const form = {
    value,
    getSnapshot: () => ({ value: form.value, writable: true }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async () => true,
    /** Publish a new value: what the Host's own settings document echoes back. */
    publish(next) {
      form.value = next
      for (const listener of [...listeners]) listener()
    },
  }
  return form
}

function fakeContext(registrations, effects, { served = true, commands = [], recorded = null, disposers = null, form = fakeForm() } = {}) {
  const slots = {
    inject: (key, callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (options) => {
      registrations.push({ name: options.name, ...options })
      return () => {}
    },
  }
  // A real dictionary lookup, so the assertions below are about the shipped
  // copy rather than about which keys the component happened to ask for.
  const dicts = new Map()
  const translate = (ns, key, params) => {
    const template = dicts.get(ns)?.zh?.[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  const ctx = {
    effect: (callback) => {
      effects.push(callback)
      const dispose = callback()
      const settled = typeof dispose === 'function' ? dispose : () => {}
      disposers?.push(settled)
      return settled
    },
    inject: (names, callback) => {
      const child = { ...ctx, slots }
      callback(child)
    },
    slots,
    locale: {
      register: (ns, all) => {
        dicts.set(ns, all)
        if (recorded !== null) recorded.push({ ns, ...all })
        return () => {}
      },
      bind: (ns) => (key, params) => translate(ns, key, params),
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0, active: 'zh' }),
    },
    sessions: { list: { getSnapshot: () => list(), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    shortcuts: {
      register: (command) => {
        commands.push(command)
        return () => {}
      },
    },
    configForms: {
      get: () => form,
      whileServed: (namespaces, register) => {
        const dispose = served ? register(new Set(namespaces)) : undefined
        return () => { if (typeof dispose === 'function') dispose() }
      },
    },
  }
  return ctx
}

// --- 单击一个不存在的路径：接管这一下，改成非阻塞提示 ---------------------

/** One inline `code` the shell wired a button into, plus its press. */
function clickableCode({ text = "src/app.ts", ...options } = {}) {
  const hit = inlineCode({ text, ...options })
  const button = { nodeType: 1, tagName: "BUTTON" }
  hit.element.querySelector = (selector) => (selector === "button" ? button : null)
  hit.button = button
  return hit
}

/** A plain left press that landed on one inline `code`. */
function leftPress(hit, overrides = {}) {
  const press = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    prevented: 0,
    stopped: 0,
    preventDefault() { press.prevented += 1 },
    stopPropagation() { press.stopped += 1 },
    ...hit.event,
    ...overrides,
  }
  return press
}

/** Collect the calls one handled press made. */
function pressSpy(stat) {
  const opened = []
  const notices = []
  const copied = []
  return {
    opened,
    notices,
    copied,
    input: {
      stat,
      open: (element) => { opened.push(element) },
      copy: (text) => { copied.push(text); return true },
      notify: (text, tone) => { notices.push({ text, tone }) },
      t: (key) => key,
    },
  }
}

test("every inline code in scope is claimed by a plain left press", async () => {
  const { codeOpenTarget } = (await load()).internals
  const hit = clickableCode({ text: "  src/app.ts\n" })
  assert.deepEqual(codeOpenTarget(leftPress(hit)), { element: hit.element, text: "src/app.ts" })

  // A fenced block, the composer, an anchor and a whitespace-only code are out of scope.
  assert.equal(codeOpenTarget(leftPress(clickableCode({ pre: true }))), null)
  assert.equal(codeOpenTarget(leftPress(clickableCode({ editable: true }))), null)
  assert.equal(codeOpenTarget(leftPress(clickableCode({ anchor: true }))), null)
  assert.equal(codeOpenTarget(leftPress(clickableCode({ text: "   " }))), null)
  assert.equal(codeOpenTarget(leftPress(clickableCode({ markdown: false }))), null)
  assert.equal(codeOpenTarget(leftPress(clickableCode({ node: false }))), null)
  // A code the shell did not make clickable has nothing to open, but the press
  // is still ours: it copies instead. Claiming it here is what keeps the menu
  // and the press from promising an open that cannot happen.
  const inert = inlineCode({ text: "npm test" })
  inert.element.querySelector = () => null
  assert.deepEqual(codeOpenTarget(leftPress(inert)), { element: inert.element, text: "npm test" })
  // Modified presses belong to the browser and to other gestures.
  assert.equal(codeOpenTarget(leftPress(hit, { metaKey: true })), null)
  assert.equal(codeOpenTarget(leftPress(hit, { ctrlKey: true })), null)
  assert.equal(codeOpenTarget(leftPress(hit, { shiftKey: true })), null)
  assert.equal(codeOpenTarget(leftPress(hit, { altKey: true })), null)
  assert.equal(codeOpenTarget(leftPress(hit, { button: 1 })), null)
  // A press the page dispatched itself — this plugin's own re-dispatch, or the
  // menu's 「打开」 — is already an explicit instruction; claiming it again would
  // claim the re-dispatch as well and never stop.
  assert.equal(codeOpenTarget(leftPress(hit, { isTrusted: false })), null)
})

test("a press on a path that does not exist becomes a notice instead of the shell open", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const hit = clickableCode({ text: "data/plugins/missing.yml" })
  const press = leftPress(hit)
  const spy = pressSpy(() => Promise.resolve({ ok: false, error: { code: "workspace-files/not-found", message: "no such file" } }))

  assert.equal(await handleInlineCodeClick(press, spy.input), "missing")
  assert.equal(press.prevented, 1, "the shell must not be allowed to open a path that is not there")
  assert.equal(press.stopped, 1)
  assert.deepEqual(spy.opened, [], "nothing may be re-dispatched for a missing path")
  assert.equal(spy.notices.length, 1)
  assert.equal(spy.notices[0].tone, "warning")
  assert.match(spy.notices[0].text, /data\/plugins\/missing\.yml/)
})

test("a press on a path that exists is handed straight back to the shell", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const hit = clickableCode({ text: "client.js" })
  const press = leftPress(hit)
  const spy = pressSpy(() => Promise.resolve({ ok: true, value: { absolutePath: "/w/client.js" } }))

  assert.equal(await handleInlineCodeClick(press, spy.input), "open")
  assert.equal(press.prevented, 1, "the press is taken first, because the probe is a round trip")
  assert.deepEqual(spy.opened, [hit.element], "the shell activation is re-dispatched unchanged")
  assert.deepEqual(spy.notices, [])
})

test("anything the probe cannot answer opens the shell path (never a false notice)", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const failures = [
    () => Promise.resolve({ ok: false, error: { code: "gateway/internal", message: "host is away" } }),
    () => Promise.resolve(undefined),
    () => Promise.reject(new Error("the probe blew up")),
  ]
  for (const stat of failures) {
    const hit = clickableCode({ text: "client.js" })
    const press = leftPress(hit)
    const spy = pressSpy(stat)
    assert.equal(await handleInlineCodeClick(press, spy.input), "open")
    assert.deepEqual(spy.notices, [], "an unknown verdict must never claim the path is missing")
    assert.deepEqual(spy.opened, [hit.element])
  }
})

test("a press on code with nothing to open copies it instead", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const inert = inlineCode({ text: "npm test" })
  inert.element.querySelector = () => null
  const press = leftPress(inert)
  const spy = pressSpy(() => { throw new Error("the probe must not run") })

  assert.equal(await handleInlineCodeClick(press, spy.input), "copy")
  assert.equal(press.prevented, 1, "the press is claimed so the browser does nothing else with it")
  assert.equal(press.stopped, 1)
  assert.deepEqual(spy.copied, ["npm test"])
  assert.deepEqual(spy.opened, [], "nothing may be probed or opened for a code with no owner")
})

test("a press outside this plugin's scope costs nothing", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const press = leftPress(clickableCode({ anchor: true }))
  const spy = pressSpy(() => { throw new Error("the probe must not run") })

  assert.equal(await handleInlineCodeClick(press, spy.input), "pass")
  assert.equal(press.prevented, 0)
  assert.equal(press.stopped, 0)
  assert.deepEqual(spy.copied, [])
})

// --- Tilde-path inline code: expand the Host home, then open it here --------

/** One inline code naming a tilde path, with no shell-wired control inside. */
function homeCode(text = "~/notes/todo.md") {
  const hit = inlineCode({ text })
  hit.element.querySelector = () => null
  return hit
}

test("a tilde path is the one shape this plugin expands", async () => {
  const { isTildePath, expandHomePath } = (await load()).internals
  assert.equal(isTildePath("~/a/b.md"), true)
  assert.equal(isTildePath("~\\a\\b.md"), true)
  assert.equal(isTildePath("~"), false)
  assert.equal(isTildePath("~alice/a.md"), false)
  assert.equal(isTildePath("/home/x/a.md"), false)
  assert.equal(isTildePath(""), false)

  assert.equal(expandHomePath("~/a.md", "/Users/x"), "/Users/x/a.md")
  assert.equal(expandHomePath("~\\a.md", "/Users/x"), "/Users/x/a.md")
  // A home that already ends in a separator must not double it.
  assert.equal(expandHomePath("~/a.md", "/Users/x/"), "/Users/x/a.md")
  // Named-user forms and every other path stay the shell's own business.
  assert.equal(expandHomePath("~alice/a.md", "/Users/x"), null)
  assert.equal(expandHomePath("/home/fixture/a.md", "/Users/x"), null)
  assert.equal(expandHomePath("~/a.md", null), null)
  assert.equal(expandHomePath("~/a.md", ""), null)
})

test("the home path is spelled with the shell's own file-address grammar", async () => {
  const { fileAddress } = (await load()).internals
  assert.equal(fileAddress("s1", "/Users/x/a b.md"), "dsh-resource://file/session/s1//Users/x/a%20b.md")
  // Backslashes normalize; a colon stays literal, as the grammar requires for drives.
  assert.equal(fileAddress("s1", "C:\\tmp\\a.md"), "dsh-resource://file/session/s1/C:/tmp/a.md")
  assert.equal(fileAddress("", "/a.md"), null)
  assert.equal(fileAddress("s1", ""), null)
})

test("a tilde code is openable even though the shell wired no control into it", async () => {
  const { codeOpenTarget } = (await load()).internals
  const hit = homeCode()
  assert.deepEqual(codeOpenTarget(leftPress(hit)), { element: hit.element, text: "~/notes/todo.md" })
  // Every other control-less code is claimed too — to be copied, not opened.
  const inert = inlineCode({ text: "npm test" })
  inert.element.querySelector = () => null
  assert.deepEqual(codeOpenTarget(leftPress(inert)), { element: inert.element, text: "npm test" })
})

test("a tilde press is probed as the Host home path and opened there", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const hit = homeCode()
  const press = leftPress(hit)
  const probed = []
  const homed = []
  const shell = []
  const notices = []
  const input = {
    home: () => "/Users/x",
    stat: (path) => { probed.push(path); return Promise.resolve({ ok: true, value: { absolutePath: path } }) },
    open: (element) => { shell.push(element) },
    openHome: (absolute) => { homed.push(absolute); return true },
    notify: (text, tone) => { notices.push({ text, tone }) },
    t: (key) => key,
  }

  assert.equal(await handleInlineCodeClick(press, input), "open")
  assert.deepEqual(probed, ["/Users/x/notes/todo.md"], "the probe must ask about the expanded path")
  assert.deepEqual(shell, [], "the shell has no control to re-dispatch here")
  assert.deepEqual(homed, ["/Users/x/notes/todo.md"])
  assert.deepEqual(notices, [])
  assert.equal(press.prevented, 1)
  assert.equal(press.stopped, 1)
})

test("a tilde path the probe calls missing still becomes the notice", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const press = leftPress(homeCode())
  const homed = []
  const notices = []
  const input = {
    home: () => "/Users/x",
    stat: () => Promise.resolve({ ok: false, error: { code: "workspace-files/not-found", message: "no such file" } }),
    open: () => { throw new Error("the shell must not be re-dispatched") },
    openHome: (absolute) => { homed.push(absolute); return true },
    notify: (text, tone) => { notices.push({ text, tone }) },
    t: (key) => key,
  }

  assert.equal(await handleInlineCodeClick(press, input), "missing")
  assert.deepEqual(homed, [], "a missing path is never opened")
  assert.equal(notices.length, 1)
  assert.equal(notices[0].tone, "warning")
  assert.match(notices[0].text, /~\/notes\/todo\.md/)
})

test("an unanswered tilde probe opens nothing instead of guessing", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const homed = []
  const notices = []
  const input = {
    home: () => "/Users/x",
    stat: () => Promise.resolve({ ok: false, error: { code: "gateway/internal", message: "host is away" } }),
    open: () => { throw new Error("the shell must not be re-dispatched") },
    openHome: (absolute) => { homed.push(absolute); return true },
    notify: (text, tone) => { notices.push({ text, tone }) },
    t: (key) => key,
  }

  assert.equal(await handleInlineCodeClick(leftPress(homeCode()), input), "unknown")
  assert.deepEqual(homed, [])
  assert.deepEqual(notices, [], "an unknown verdict must never claim the path is missing")
})

test("without a Host home a tilde press copies, because nothing can open it", async () => {
  const { handleInlineCodeClick } = (await load()).internals
  const press = leftPress(homeCode())
  const copied = []
  const input = {
    home: () => null,
    stat: () => { throw new Error("the probe must not run") },
    open: () => { throw new Error("the shell must not be re-dispatched") },
    openHome: () => { throw new Error("nothing may be opened") },
    copy: (text) => { copied.push(text); return true },
    notify: () => { throw new Error("nothing may be noticed") },
    t: (key) => key,
  }

  assert.equal(await handleInlineCodeClick(press, input), "copy")
  assert.deepEqual(copied, ["~/notes/todo.md"])
  assert.equal(press.prevented, 1)
})

test("the menu opens a tilde code the shell never wired, and only that one", async () => {
  const { inlineCodePlan, openInlineCodeHit } = (await load()).internals
  const input = {
    stat: () => Promise.resolve({ ok: true, value: { absolutePath: "/Users/x/notes/todo.md" } }),
    openHome: () => true,
    notify: () => { throw new Error("a present path is never noticed") },
    t: (key) => key,
  }
  // A control the shell wired keeps the shipped activation, so its plan is that one.
  const wired = clickableCode({ text: "client.js" })
  const wiredHit = { element: wired.element, text: "client.js" }
  assert.deepEqual(inlineCodePlan(wiredHit, () => "/Users/x"), { kind: "shell", probe: "client.js" })
  // A control-less tilde code plans the Host home path.
  const home = homeCode()
  const homeHit = { element: home.element, text: "~/notes/todo.md" }
  const plan = inlineCodePlan(homeHit, () => "/Users/x")
  assert.deepEqual(plan, { kind: "home", probe: "/Users/x/notes/todo.md", shell: false })
  assert.equal(await openInlineCodeHit(homeHit, plan, input), "open")
  // Anything else keeps today's no-op activation.
  const inert = inlineCode({ text: "npm test" })
  inert.element.querySelector = () => null
  assert.equal(inlineCodePlan(inert, () => "/Users/x"), null)
})

test("a tilde code the shell did wire still goes home, and falls back to the shell unproven", async () => {
  const { codeOpenTarget, inlineCodePlan, openInlineCodeHit } = (await load()).internals
  // The live renderer wires a control into a path-looking code, `~/…` included
  // (measured: title = the code's own text, aria-label 在侧边栏打开 / 在文件管理器中打开).
  const wired = clickableCode({ text: "~/.codex/AGENTS.md" })
  const hit = { element: wired.element, text: "~/.codex/AGENTS.md" }
  assert.deepEqual(codeOpenTarget(leftPress(wired)), { element: wired.element, text: "~/.codex/AGENTS.md" })
  const plan = inlineCodePlan(hit, () => "/Users/x")
  assert.deepEqual(plan, { kind: "home", probe: "/Users/x/.codex/AGENTS.md", shell: true })

  // A proven non-empty file opens at home even though the shell wired a control.
  const healthy = {
    stat: () => Promise.resolve({ ok: true, value: { absolutePath: "/Users/x/.codex/AGENTS.md" } }),
    open: () => { throw new Error("a proven path is never re-dispatched") },
    openHome: () => true,
    notify: () => { throw new Error("a present path is never noticed") },
    t: (key) => key,
  }
  assert.equal(await openInlineCodeHit(hit, plan, healthy), "open")

  // An answer the probe cannot prove (a directory, a Host that is away) keeps the
  // shell's own control, so its directory handling is untouched.
  const opened = []
  const unproven = {
    stat: () => Promise.resolve({ ok: false, error: { code: "workspace-file/not-regular-file", message: "not a regular file" } }),
    open: (element) => { opened.push(element) },
    openHome: () => { throw new Error("an unproven path is never opened") },
    notify: () => { throw new Error("an unknown verdict is never a notice") },
    t: (key) => key,
  }
  assert.equal(await openInlineCodeHit(hit, plan, unproven), "open")
  assert.deepEqual(opened, [hit.element])

  // Without a shell control the same unproven answer opens nothing at all.
  const bare = homeCode()
  const bareHit = { element: bare.element, text: "~/notes/todo.md" }
  const barePlan = inlineCodePlan(bareHit, () => "/Users/x")
  assert.equal(await openInlineCodeHit(bareHit, barePlan, {
    stat: unproven.stat,
    open: () => { throw new Error("there is no shell control to fall back to") },
    openHome: unproven.openHome,
    notify: unproven.notify,
    t: (key) => key,
  }), "unknown")
})

test("the probe tells a directory apart from an unanswered host", async () => {
  const { statVerdict } = (await load()).internals
  assert.equal(statVerdict({ ok: true, value: {} }), "present")
  assert.equal(statVerdict({ ok: false, error: { code: "workspace-file/not-found", message: "no entry" } }), "missing")
  assert.equal(statVerdict({ ok: false, error: { code: "workspace-file/not-regular-file", message: "x is a directory", details: { kind: "directory" } } }), "directory")
  // The kind can ride only in the message on some transports.
  assert.equal(statVerdict({ ok: false, error: { code: "workspace-file/not-regular-file", message: "\"/Users/x\" is a directory" } }), "directory")
  // A symlink, or a Host that is away, is not a directory this plugin may open.
  assert.equal(statVerdict({ ok: false, error: { code: "workspace-file/not-regular-file", message: "x is a symlink", details: { kind: "symlink" } } }), "unknown")
  assert.equal(statVerdict({ ok: false, error: { code: "gateway/internal", message: "away" } }), "unknown")
})

test("a home directory opens in the file manager, not in the Sidebar preview", async () => {
  const { inlineCodePlan, openInlineCodeHit } = (await load()).internals
  const bare = homeCode("~/dsh-flow-worktrees/tilde-home")
  const hit = { element: bare.element, text: "~/dsh-flow-worktrees/tilde-home" }
  const plan = inlineCodePlan(hit, () => "/Users/x")
  assert.deepEqual(plan, { kind: "home", probe: "/Users/x/dsh-flow-worktrees/tilde-home", shell: false })

  const directories = []
  const input = {
    stat: () => Promise.resolve({ ok: false, error: { code: "workspace-file/not-regular-file", message: "\"/Users/x/dsh-flow-worktrees/tilde-home\" is a directory", details: { kind: "directory" } } }),
    open: () => { throw new Error("a directory is not re-dispatched to the shell") },
    openHome: () => { throw new Error("a directory has no Sidebar preview") },
    openDirectory: (absolute) => { directories.push(absolute); return true },
    notify: () => { throw new Error("a directory is not a missing path") },
    t: (key) => key,
  }
  assert.equal(await openInlineCodeHit(hit, plan, input), "open")
  assert.deepEqual(directories, ["/Users/x/dsh-flow-worktrees/tilde-home"])

  // A file-manager open that could not happen leaves the press alone.
  assert.equal(await openInlineCodeHit(hit, plan, { ...input, openDirectory: () => false }), "unknown")
})

test("the file manager is the installed catalog row whose kind says files", async () => {
  const { fileManagerAppOf } = (await load()).internals
  assert.equal(fileManagerAppOf([
    { id: "vscode", name: "VS Code", kind: "ide" },
    { id: "finder", name: "访达", kind: "files" },
    { id: "terminal", name: "终端", kind: "terminal" },
  ]), "finder")
  assert.equal(fileManagerAppOf([{ id: "explorer", name: "Explorer", kind: "files" }]), "explorer")
  assert.equal(fileManagerAppOf([{ id: "vscode", name: "VS Code", kind: "ide" }, { id: "terminal", name: "终端", kind: "terminal" }]), null)
  assert.equal(fileManagerAppOf([null, 7, { kind: "files" }]), null)
  assert.equal(fileManagerAppOf(null), null)
})

test("the plugin injects the Remote carrier and both namespaces it uses", async () => {
  // Measured: without these the cordis context has no ctx.remote.workspaceFiles,
  // every existence probe answers "unknown", and each press silently falls back to
  // the shell — which is exactly the "path open failed" report this feature exists
  // to replace. Opening a changed file or an application row no longer goes through
  // ctx.remote.session: it posts to this plugin's own /flow/open-with route, so the
  // Session Remote is deliberately not injected. The inject list is part of the
  // feature, not boilerplate.
  const module = await load()
  assert.ok(module.inject.includes("remote"), "ctx.remote carries the host facts and $host")
  assert.ok(module.inject.includes("remote.workspaceFiles"), "ctx.remote.workspaceFiles carries stat")
  assert.equal(module.inject.includes("remote.session"), false, "the open-with route replaced the Session Remote")
  assert.ok(module.inject.includes("sidebarRight"), "ctx.sidebarRight carries openResource")
})

test("the inline-code menu is handed a home opener beside its store", async () => {
  const module = await load()
  const registrations = []
  module.apply(fakeContext(registrations, []))
  const menu = registrations.find((entry) => entry.name === "shell.overlay" && entry.id === "flow.code-menu")
  assert.equal(typeof menu.inject().openCode, "function")
})

/** One keydown stub carrying the two cancels the seat is required to make. */
function press(key, { altKey = false, metaKey = false, ctrlKey = false, shiftKey = false, isComposing = false, keyCode = 0 } = {}) {
  return {
    key,
    altKey,
    metaKey,
    ctrlKey,
    shiftKey,
    isComposing,
    keyCode,
    prevented: 0,
    stopped: 0,
    preventDefault() { this.prevented += 1 },
    stopImmediatePropagation() { this.stopped += 1 },
  }
}

test('readModEnterSend is off unless the Host explicitly turns it on', async () => {
  const { readModEnterSend } = (await load()).internals
  assert.equal(readModEnterSend({ getSnapshot: () => ({ value: {} }) }), false)
  assert.equal(readModEnterSend({ getSnapshot: () => ({ value: { modEnterSend: true } }) }), true)
  assert.equal(readModEnterSend({ getSnapshot: () => ({ value: { modEnterSend: false } }) }), false)
  // An unreadable form keeps the shell's own Enter: a Host that does not
  // project the field yet must not silently take the composer over.
  assert.equal(readModEnterSend({ getSnapshot: () => { throw new Error('no host') } }), false)
})

test('isComposerTarget claims the shipped composer and nothing else', async () => {
  const { isComposerTarget } = (await load()).internals
  const inside = node({ tag: 'div' })
  inside.closest = (selector) => (selector === '[data-composer-input]' ? inside : null)
  assert.equal(isComposerTarget(inside), true)
  const outside = node({ tag: 'input' })
  outside.closest = () => null
  assert.equal(isComposerTarget(outside), false)
  assert.equal(isComposerTarget(null), false)
  assert.equal(isComposerTarget({}), false)
})

test('composerEnterRewrite swaps Enter and the primary-modifier chord', async () => {
  const { composerEnterRewrite } = (await load()).internals
  const base = { enabled: true, key: 'Enter', inComposer: true }
  // Plain Enter becomes the newline gesture, and so does Shift+Enter.
  assert.deepEqual(composerEnterRewrite(base), { shiftKey: true, primary: false })
  assert.deepEqual(composerEnterRewrite({ ...base, shiftKey: true }), { shiftKey: true, primary: false })
  // Cmd/Ctrl+Enter becomes the plain submit gesture, so it delivers exactly
  // what Enter delivers today.
  assert.deepEqual(composerEnterRewrite({ ...base, metaKey: true }), { shiftKey: false, primary: false })
  assert.deepEqual(composerEnterRewrite({ ...base, ctrlKey: true }), { shiftKey: false, primary: false })
  // The complementary chord survives the swap: dropping Shift keeps the
  // primary modifier, which is the gesture the shell calls "accelerated".
  assert.deepEqual(composerEnterRewrite({ ...base, metaKey: true, shiftKey: true }), { shiftKey: false, primary: true })
  assert.deepEqual(composerEnterRewrite({ ...base, ctrlKey: true, shiftKey: true }), { shiftKey: false, primary: true })
})

test('composerEnterRewrite leaves every other key, chord and context alone', async () => {
  const { composerEnterRewrite } = (await load()).internals
  const base = { enabled: true, key: 'Enter', inComposer: true }
  assert.equal(composerEnterRewrite({ ...base, enabled: false }), null, 'the preference is off')
  assert.equal(composerEnterRewrite({ ...base, key: 'a' }), null, 'not Enter')
  assert.equal(composerEnterRewrite({ ...base, composing: true }), null, 'inside an IME composition')
  assert.equal(composerEnterRewrite({ ...base, altKey: true }), null, 'an Alt chord belongs to the shell')
  assert.equal(composerEnterRewrite({ ...base, inComposer: false }), null, 'not the composer')
  assert.equal(composerEnterRewrite({ ...base, menuOwnsEnter: true }), null, 'the trigger menu picks with Enter')
  assert.equal(composerEnterRewrite({}), null)
})

test('the send-key seat consumes what it rewrites, once', async () => {
  const { createComposerSendKey } = (await load()).internals
  const seen = []
  const seat = createComposerSendKey({
    enabled: () => true,
    inComposer: () => true,
    menuOwnsEnter: () => false,
    replay: (_event, plan) => seen.push(plan),
  })
  const claimed = press('Enter')
  assert.equal(seat.handle(claimed), true)
  assert.equal(claimed.prevented, 1, 'the shell must not also submit')
  assert.equal(claimed.stopped, 1, 'no other listener gets to act on it')
  assert.deepEqual(seen, [{ shiftKey: true, primary: false }])

  const passed = press('a')
  assert.equal(seat.handle(passed), false)
  assert.equal(passed.prevented, 0)
  assert.equal(passed.stopped, 0)
})

test('the gesture the seat dispatches is never rewritten again', async () => {
  const { createComposerSendKey } = (await load()).internals
  const reentered = []
  const seat = createComposerSendKey({
    enabled: () => true,
    inComposer: () => true,
    menuOwnsEnter: () => false,
    replay: () => { reentered.push(seat.handle(press('Enter'))) },
  })
  assert.equal(seat.handle(press('Enter')), true)
  assert.deepEqual(reentered, [false], 'the replayed keydown must pass straight through')
})

test('the default replay dispatches one synthetic Enter at the composer', async () => {
  const { createComposerSendKey } = (await load()).internals
  const sent = []
  const target = { nodeType: 1, dispatchEvent: (event) => { sent.push(event); return true } }
  function FakeKeyboardEvent(type, init) { this.type = type; Object.assign(this, init) }
  const seat = createComposerSendKey({
    enabled: () => true,
    inComposer: () => true,
    menuOwnsEnter: () => false,
    KeyboardEvent: FakeKeyboardEvent,
  })

  const swapped = Object.assign(press('Enter'), { target })
  seat.handle(swapped)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'keydown')
  assert.equal(sent[0].key, 'Enter')
  assert.equal(sent[0].shiftKey, true, 'plain Enter replays as the newline gesture')
  assert.equal(sent[0].metaKey, false)
  assert.equal(sent[0].ctrlKey, false)
  assert.equal(sent[0].bubbles, true, 'the shell listens on the editor, not on document')
  assert.equal(sent[0].cancelable, true)

  // Cmd+Enter replays as plain Enter; Shift+Cmd+Enter keeps the modifier.
  seat.handle(Object.assign(press('Enter', { metaKey: true }), { target }))
  seat.handle(Object.assign(press('Enter', { metaKey: true, shiftKey: true }), { target }))
  assert.deepEqual(
    sent.slice(1).map((event) => [event.shiftKey, event.metaKey, event.ctrlKey]),
    [[false, false, false], [false, true, false]],
  )
})

test('the composer listener exists only while the preference is on', async () => {
  const module = await load()
  const added = []
  const removed = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    addEventListener: (type, listener, capture) => added.push({ type, listener, capture }),
    removeEventListener: (type, listener, capture) => removed.push({ type, listener, capture }),
  }
  try {
    const form = fakeForm({ modEnterSend: false, composerHistory: false })
    module.apply(fakeContext([], [], { form }))
    // Only this feature's own listener is asserted: the other capture listeners
    // belong to the link hand-off and the inline-code press, and each of those
    // has its own assertion elsewhere.
    const keydowns = () => added.filter((entry) => entry.type === 'keydown')
    assert.deepEqual(keydowns(), [], 'an off feature adds no keydown listener')

    form.publish({ modEnterSend: true, composerHistory: false })
    assert.deepEqual(keydowns().map((entry) => entry.capture), [true])
    // A press in the composer is claimed; the same press outside it is not.
    const composer = { nodeType: 1, closest: (selector) => (selector === '[data-composer-input]' ? composer : null), dispatchEvent: () => true }
    const inside = Object.assign(press('Enter'), { target: composer })
    assert.equal(keydowns()[0].listener(inside), undefined)
    assert.equal(inside.prevented, 1)
    const outside = Object.assign(press('Enter'), { target: { nodeType: 1, closest: () => null } })
    assert.equal(outside.prevented, 0)

    form.publish({ modEnterSend: false, composerHistory: false })
    assert.deepEqual(removed, [{ type: 'keydown', listener: keydowns()[0].listener, capture: true }])
    form.publish({ modEnterSend: false, composerHistory: false })
    assert.equal(removed.length, 1, 'an already detached listener is not removed twice')

    // The recalled-messages switch rides the same capture-phase slot: turning it
    // on alone registers exactly one listener, and turning it off removes it.
    form.publish({ modEnterSend: false, composerHistory: true })
    assert.deepEqual(keydowns().map((entry) => entry.capture), [true, true])
    form.publish({ modEnterSend: false, composerHistory: false })
    assert.equal(removed.length, 2, 'the recalled-messages listener is detached with its switch')
  } finally {
    delete globalThis.document
  }
})


// --- 「已编辑 N 个文件」卡片：右键把文件交给默认应用 -----------------------

/** One changed-file row: a button whose `aria-describedby` names its Host path. */
function changedFileRow({ path = '/Users/me/project/src/app.ts', describedBy = 'dsh-changes-0', card = true, described = true } = {}) {
  const description = node({ tag: 'span' })
  description.textContent = path
  const row = node({ tag: 'button', attrs: { 'aria-describedby': describedBy } })
  row.closest = (selector) => (selector === '[data-changed-files]' && card ? node({}) : null)
  row.ownerDocument = { getElementById: (value) => (described && value === describedBy ? description : null) }
  const target = { nodeType: 1, closest: (selector) => (selector === 'button[aria-describedby]' ? row : null) }
  return { row, description, event: { target } }
}

test('changedFileTarget claims one changed-file row, and nothing else', async () => {
  const { changedFileTarget } = (await load()).internals

  const hit = changedFileRow()
  assert.deepEqual(changedFileTarget(hit.event), { element: hit.row, path: '/Users/me/project/src/app.ts' })

  // A press that never reached a row button.
  assert.equal(changedFileTarget({ target: { closest: () => null } }), null)
  assert.equal(changedFileTarget({ target: null }), null)
  assert.equal(changedFileTarget({}), null)
  assert.equal(changedFileTarget(undefined), null)
  // A row button outside the changed-files card belongs to some other surface.
  assert.equal(changedFileTarget(changedFileRow({ card: false }).event), null)
  // No description, a description that is not in the document, and an empty one
  // all leave the press without a Host path to hand over.
  const bare = changedFileRow()
  bare.row.getAttribute = () => null
  assert.equal(changedFileTarget(bare.event), null)
  assert.equal(changedFileTarget(changedFileRow({ described: false }).event), null)
  assert.equal(changedFileTarget(changedFileRow({ path: '   ' }).event), null)
})

test('describedFilePath reads the path the card hid, and nothing else', async () => {
  // The same read serves the press and the warm-up that runs before it, so it is
  // pinned on its own.
  const { describedFilePath } = (await load()).internals
  const hit = changedFileRow()
  assert.equal(describedFilePath(hit.row), '/Users/me/project/src/app.ts')
  assert.equal(describedFilePath(null), null)
  assert.equal(describedFilePath({ nodeType: 1, getAttribute: () => null }), null)
  assert.equal(describedFilePath({ nodeType: 1, getAttribute: () => '   ' }), null)
  const missing = changedFileRow()
  missing.row.ownerDocument = undefined
  assert.equal(describedFilePath(missing.row), null)
})

test('a context-menu press on a changed-file row is claimed, and any other press is left alone', async () => {
  const { handleChangesContextMenu } = (await load()).internals
  const hit = changedFileRow()
  const claimed = {
    ...hit.event,
    clientX: 12,
    clientY: 34,
    prevented: 0,
    stopped: 0,
    preventDefault() { claimed.prevented += 1 },
    stopPropagation() { claimed.stopped += 1 },
  }
  const opened = []
  assert.equal(handleChangesContextMenu(claimed, { open: (menu) => opened.push(menu) }), true)
  assert.deepEqual(opened, [{ x: 12, y: 34, path: '/Users/me/project/src/app.ts', element: hit.row }])
  assert.equal(claimed.prevented, 1, 'the browser must not also open its own menu')
  assert.equal(claimed.stopped, 1)

  const passed = {
    target: { closest: () => null },
    clientX: 0,
    clientY: 0,
    prevented: 0,
    stopped: 0,
    preventDefault() { passed.prevented += 1 },
    stopPropagation() { passed.stopped += 1 },
  }
  assert.equal(handleChangesContextMenu(passed, { open: () => { throw new Error('nothing to open') } }), false)
  assert.equal(passed.prevented, 0, 'a press that is not ours keeps the shipped behaviour')
  assert.equal(passed.stopped, 0)
})

test('the changed-file seat mints one fresh snapshot per open, and patches only its own', async () => {
  const { createChangesMenuStore } = (await load()).internals
  const store = createChangesMenuStore()
  assert.equal(store.getSnapshot(), null)

  let wakes = 0
  const off = store.subscribe(() => { wakes += 1 })
  const element = { nodeType: 1 }
  const firstSeq = store.open({ x: 5, y: 6, path: '/a/b.ts', element })
  const first = store.getSnapshot()
  assert.deepEqual(first, { seq: firstSeq, x: 5, y: 6, path: '/a/b.ts', element, apps: [] })
  assert.equal(wakes, 1)

  // The very same press point again is still a new object: React compares
  // snapshots by identity, so a re-open has to re-render.
  const secondSeq = store.open({ x: 5, y: 6, path: '/a/b.ts', element })
  assert.equal(store.getSnapshot() === first, false)
  assert.equal(store.getSnapshot().seq, secondSeq)
  assert.equal(wakes, 2)

  // The association query is a round trip: its answer may land after another
  // menu opened or after this one closed, so it only patches the menu it was
  // measured for.
  const editors = [{ key: 'vscode', label: 'VS Code', id: '/Applications/Visual Studio Code.app', default: true, icon: null }]
  assert.equal(store.mark(firstSeq, { apps: editors }), false)
  assert.deepEqual(store.getSnapshot().apps, [])
  assert.equal(store.mark(secondSeq, { apps: editors }), true)
  assert.deepEqual(store.getSnapshot().apps, editors)
  assert.equal(wakes, 3)

  off()
  store.close()
  assert.equal(store.getSnapshot(), null)
  assert.equal(wakes, 3, 'an unsubscribed listener stays silent')
  store.close()
  assert.equal(wakes, 3, 'closing an empty seat is not a second wake-up')
  assert.equal(store.mark(secondSeq, { apps: [] }), false, 'a closed seat swallows a late answer')
})

test('readChangesFileOpen defaults to on and only an explicit false turns it off', async () => {
  const { readChangesFileOpen } = (await load()).internals
  assert.equal(readChangesFileOpen({ getSnapshot: () => ({ value: {} }) }), true)
  assert.equal(readChangesFileOpen({ getSnapshot: () => ({ value: { changesFileOpen: false } }) }), false)
  assert.equal(readChangesFileOpen({ getSnapshot: () => ({ value: { changesFileOpen: true } }) }), true)
  assert.equal(readChangesFileOpen({ getSnapshot: () => { throw new Error('no host') } }), true)
})

test('openWithPath posts the catalog id or the two OS gestures, with the page\'s own credentials', async () => {
  const { openWithPath, OPEN_WITH_ROUTE } = (await load()).internals
  const calls = []
  const fetch = (route, init) => { calls.push({ route, init }); return Promise.resolve({ ok: true }) }
  assert.equal(await openWithPath({ app: 'vscode', path: '/a/b.ts', fetch }), true)
  assert.equal(await openWithPath({ app: 'reveal', path: '/a/b.ts', fetch }), true)
  assert.equal(await openWithPath({ app: 'default', path: '/a/b.ts', fetch }), true)
  assert.deepEqual(calls.map((call) => JSON.parse(call.init.body)), [
    { app: 'vscode', path: '/a/b.ts' },
    { app: 'reveal', path: '/a/b.ts' },
    { app: 'default', path: '/a/b.ts' },
  ])
  for (const call of calls) {
    assert.equal(call.route, OPEN_WITH_ROUTE)
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(call.init.headers['content-type'], 'application/json')
  }
  // Without a target, a path or a transport there is nothing to hand over, and
  // nothing is even sent.
  assert.equal(await openWithPath({ app: '', path: '/a/b.ts', fetch }), false)
  assert.equal(await openWithPath({ app: 'vscode', path: '', fetch }), false)
  assert.equal(await openWithPath({ app: 'vscode', path: '/a/b.ts' }), false)
  assert.equal(await openWithPath({ app: 'vscode', path: '/a/b.ts', fetch: () => Promise.reject(new Error('away')) }), false)
  assert.equal(calls.length, 3, 'a malformed or unreachable hand-off sends nothing')
})

test('openChangedFile reports a refusal of either gesture in words', async () => {
  const { openChangedFile } = (await load()).internals
  const seen = []
  const notify = (text, tone) => seen.push([text, tone])
  const t = (key) => ({
    'changesFile.failed': '无法用默认应用打开这个文件',
    'changesFile.revealFailed': '无法在文件管理器中显示这个文件',
  }[key])
  const accept = () => Promise.resolve({ ok: true })
  assert.equal(await openChangedFile({ path: '/a/b.ts', app: 'default', fetch: accept, notify, t }), true)
  assert.equal(await openChangedFile({ path: '/a/b.ts', app: 'vscode', fetch: accept, notify, t }), true)
  assert.deepEqual(seen, [], 'a hand-off that worked says nothing')

  // A refusal envelope, a rejection, and a missing transport all read as the
  // same spoken refusal — never as silence, and never as the raw error the Host
  // happened to answer with.
  const refused = () => Promise.resolve({ ok: false, status: 403 })
  assert.equal(await openChangedFile({ path: '/a/b.ts', app: 'default', fetch: refused, notify, t }), false)
  assert.deepEqual(seen[0], ['无法用默认应用打开这个文件', 'warning'])
  assert.equal(await openChangedFile({ path: '/a/b.ts', app: 'vscode', fetch: () => Promise.reject(new Error('boom')), notify, t }), false)
  assert.deepEqual(seen[1], ['无法用默认应用打开这个文件', 'warning'])
  assert.equal(await openChangedFile({ path: '/a/b.ts', app: 'default', notify, t }), false)
  assert.deepEqual(seen[2], ['无法用默认应用打开这个文件', 'warning'])
  assert.equal(await openChangedFile({ path: '/a/b.ts', app: 'reveal', fetch: refused, notify, t }), false)
  assert.deepEqual(seen[3], ['无法在文件管理器中显示这个文件', 'warning'])
})

test('the changed-file listener exists only while the preference is on', async () => {
  const module = await load()
  const added = []
  const removed = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    addEventListener: (type, listener, capture) => added.push({ type, listener, capture }),
    removeEventListener: (type, listener, capture) => removed.push({ type, listener, capture }),
  }
  try {
    // The inline-code menu is held off, so the only `contextmenu` listener here
    // is this feature's own.
    const form = fakeForm({ changesFileOpen: false, codeMenu: false })
    module.apply(fakeContext([], [], { form }))
    const menus = () => added.filter((entry) => entry.type === 'contextmenu')
    assert.deepEqual(menus(), [], 'an off feature adds no contextmenu listener')

    form.publish({ changesFileOpen: true, codeMenu: false })
    assert.deepEqual(menus().map((entry) => entry.capture), [true])

    form.publish({ changesFileOpen: false, codeMenu: false })
    assert.deepEqual(removed, [
      { type: 'contextmenu', listener: menus()[0].listener, capture: true },
    ])
    form.publish({ changesFileOpen: false, codeMenu: false })
    assert.equal(removed.length, 1, 'an already detached listener is not removed twice')

    form.publish({ changesFileOpen: true, codeMenu: false })
    assert.deepEqual(menus().map((entry) => entry.capture), [true, true])
  } finally {
    delete globalThis.document
  }
})

test('the changed-file menu is handed an opener beside its store', async () => {
  const module = await load()
  const registrations = []
  module.apply(fakeContext(registrations, []))
  const menu = registrations.find((entry) => entry.name === 'shell.overlay' && entry.id === 'flow.changes-menu')
  assert.ok(menu, 'the changed-file menu owns its own overlay cell')
  assert.equal(typeof menu.inject().openFile, 'function')
})


test('changesFileRows lead with the default action, then the catalog IDEs, and end on reveal', async () => {
  const { changesFileRows } = (await load()).internals
  const element = { nodeType: 1 }
  const vscode = { key: 'vscode', id: 'vscode', label: 'VS Code', kind: 'ide', icon: '/open-in-app/icon/vscode' }
  const zed = { key: 'zed', id: 'zed', label: 'Zed', kind: 'ide', icon: '/open-in-app/icon/zed' }

  // The catalog has not landed yet: the shipped pair, so the menu is never empty.
  assert.deepEqual(changesFileRows({ path: '/a.ts', element, apps: [] }).map((row) => row.kind), ['open', 'reveal'])
  // The default action stays first and generic — it no longer marks one IDE, so
  // every installed IDE gets its own row behind it.
  assert.deepEqual(changesFileRows({ path: '/a.ts', element, apps: [vscode, zed] }).map((row) => row.kind), ['open', 'app', 'app', 'reveal'])
  assert.deepEqual(changesFileRows({ path: '/a.ts', element, apps: [vscode, zed] }).map((row) => row.key), ['open', 'app:vscode', 'app:zed', 'reveal'])
  assert.deepEqual(changesFileRows(null).map((row) => row.kind), [])
})


// --- ↑↓ 切换当前会话发过的消息 ---------------------------------------------

/** One durable user/message entry exactly as the Session event window carries it. */
function userEntry(seq, content, source = { kind: 'user' }) {
  return {
    type: 'event',
    event: { type: 'user/message', seq, time: seq, data: { id: 'm' + seq, role: 'user', content, source } },
  }
}

/** One text content block. */
const textBlock = (text) => ({ type: 'text', text })
/** One durable image content block. */
const imageBlock = (attachmentId) => ({ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 3 } })
/** One durable file content block. */
const fileBlock = (attachmentId, name) => ({ type: 'file', attachment: { attachmentId, name, bytes: 3 } })

test('sentUserMessages keeps only what the user produced, with its attachments', async () => {
  const { sentUserMessages } = (await load()).internals
  const entries = [
    { type: 'event', event: { type: 'permission/preset', seq: 1, data: {} } },
    // A plugin-injected user-role message (workspace instructions, reminders) is
    // not something the user typed, so it never enters the recall list.
    userEntry(2, [textBlock('<system-reminder>rules</system-reminder>')], { kind: 'plugin', plugin: 'dsh-agent-instructions', form: 'instructions' }),
    userEntry(3, [textBlock('第一条')]),
    userEntry(4, [imageBlock('img-1')]),
    userEntry(5, [textBlock('带附件'), fileBlock('file-1', 'report.pdf')]),
    userEntry(6, []),
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 7 } },
    null,
    'garbage',
  ]
  const messages = sentUserMessages(entries)
  assert.deepEqual(messages.map((m) => [m.seq, m.text]), [[3, '第一条'], [4, ''], [5, '带附件']])
  assert.deepEqual(messages[1].images.map((a) => a.attachmentId), ['img-1'])
  assert.deepEqual(messages[2].files.map((a) => a.name), ['report.pdf'])
  assert.deepEqual(messages[0].images, [])
  // A missing or malformed window degrades to nothing rather than throwing.
  assert.deepEqual(sentUserMessages(undefined), [])
  assert.deepEqual(sentUserMessages([{ type: 'event' }]), [])
})

test('composerHistoryStep walks the list by seq and only asks for older pages at its head', async () => {
  const { composerHistoryStep } = (await load()).internals
  const messages = [{ seq: 3, text: 'a' }, { seq: 5, text: 'b' }, { seq: 9, text: 'c' }]
  const draft = { anchorSeq: null, hasMore: false }

  // From the draft, Up lands on the newest message; Down stays out of recall.
  assert.deepEqual(composerHistoryStep(draft, 'ArrowUp', messages), { kind: 'show', message: messages[2] })
  assert.deepEqual(composerHistoryStep(draft, 'ArrowDown', messages), { kind: 'idle' })
  // Walking back stops at the oldest loaded message instead of wrapping.
  assert.deepEqual(composerHistoryStep({ anchorSeq: 9, hasMore: false }, 'ArrowUp', messages), { kind: 'show', message: messages[1] })
  assert.deepEqual(composerHistoryStep({ anchorSeq: 3, hasMore: false }, 'ArrowUp', messages), { kind: 'idle' })
  // Down walks forward and, past the newest, restores the draft.
  assert.deepEqual(composerHistoryStep({ anchorSeq: 3, hasMore: false }, 'ArrowDown', messages), { kind: 'show', message: messages[1] })
  assert.deepEqual(composerHistoryStep({ anchorSeq: 9, hasMore: false }, 'ArrowDown', messages), { kind: 'restore' })
  // At the head with earlier history still unloaded, ask for one more page.
  assert.deepEqual(composerHistoryStep({ anchorSeq: 3, hasMore: true }, 'ArrowUp', messages), { kind: 'load-older' })
  assert.deepEqual(composerHistoryStep({ anchorSeq: null, hasMore: true }, 'ArrowUp', []), { kind: 'load-older' })
  assert.deepEqual(composerHistoryStep({ anchorSeq: null, hasMore: false }, 'ArrowUp', []), { kind: 'idle' })
  // Anything that is not an arrow is not this feature's business.
  assert.deepEqual(composerHistoryStep({ anchorSeq: 9, hasMore: false }, 'Enter', messages), { kind: 'idle' })
})

test('historyDraftText keeps the text and names the files it cannot bring back', async () => {
  const { historyDraftText } = (await load()).internals
  const label = (file) => '[附件：' + file.name + ']'
  assert.equal(historyDraftText({ text: '正文', files: [] }, label), '正文')
  assert.equal(historyDraftText({ text: '', files: [] }, label), '')
  assert.equal(
    historyDraftText({ text: '正文', files: [{ name: 'a.pdf' }, { name: 'b.png' }] }, label),
    '正文\n[附件：a.pdf]\n[附件：b.png]',
  )
  assert.equal(historyDraftText({ text: '', files: [{ name: 'a.pdf' }] }, label), '[附件：a.pdf]')
})

/** One arrow press in the composer. */
function arrowPress(key, overrides = {}) {
  const event = {
    key,
    isComposing: false,
    keyCode: 0,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { event.defaultPrevented = true },
    stopImmediatePropagation() { event.stopped = true },
    ...overrides,
  }
  return event
}

/** A recording seat over a mutable message list. */
async function historySeat(overrides = {}) {
  const { createComposerHistory } = (await load()).internals
  const state = {
    draft: '',
    session: 's1',
    messages: [
      { seq: 3, text: '第一条', images: [], files: [] },
      { seq: 5, text: '第二条', images: [], files: [] },
    ],
    hasMore: false,
    writes: [],
    pasted: [],
    loaded: 0,
  }
  const seat = createComposerHistory({
    enabled: () => true,
    inComposer: () => true,
    menuOwnsKey: () => false,
    sessionId: () => state.session,
    draft: () => state.draft,
    setDraft: (text) => { state.draft = text; state.writes.push(text) },
    messages: () => state.messages,
    hasMore: () => state.hasMore,
    loadOlder: async () => { state.loaded += 1 },
    pasteImages: (images) => { state.pasted.push(...images.map((image) => image.attachmentId)) },
    fileLabel: (file) => '[附件：' + file.name + ']',
    ...overrides,
  })
  return { seat, state }
}

test('the composer history seat takes over an empty draft and puts it back on the way down', async () => {
  const { seat, state } = await historySeat()
  const up = arrowPress('ArrowUp')
  assert.equal(seat.handle(up), true)
  assert.equal(up.defaultPrevented, true)
  assert.equal(up.stopped, true)
  assert.equal(state.draft, '第二条')
  assert.deepEqual(state.writes, ['第二条'])

  seat.handle(arrowPress('ArrowUp'))
  assert.equal(state.draft, '第一条')
  // The oldest loaded message is the end of the line while no older page exists.
  const stuck = arrowPress('ArrowUp')
  assert.equal(seat.handle(stuck), false)
  assert.equal(stuck.defaultPrevented, false)
  assert.equal(state.draft, '第一条')

  seat.handle(arrowPress('ArrowDown'))
  assert.equal(state.draft, '第二条')
  seat.handle(arrowPress('ArrowDown'))
  assert.equal(state.draft, '')
})

test('the composer history seat leaves every press it does not own alone', async () => {
  const { seat, state } = await historySeat()
  // Option A: a non-empty draft keeps Up with the editor, so the cursor moves.
  state.draft = '用户在打字'
  assert.equal(seat.handle(arrowPress('ArrowUp')), false)
  assert.deepEqual(state.writes, [])
  assert.equal(state.draft, '用户在打字')

  // Guards: IME, alt, other modifiers, a press outside the composer, the
  // trigger menu owning the arrow, a non-arrow key, and the switch itself.
  assert.equal(seat.handle(arrowPress('ArrowUp', { isComposing: true })), false)
  assert.equal(seat.handle(arrowPress('ArrowUp', { keyCode: 229 })), false)
  assert.equal(seat.handle(arrowPress('ArrowUp', { altKey: true })), false)
  assert.equal(seat.handle(arrowPress('ArrowUp', { metaKey: true })), false)
  assert.equal(seat.handle(arrowPress('ArrowUp', { ctrlKey: true })), false)
  assert.equal(seat.handle(arrowPress('ArrowUp', { shiftKey: true })), false)
  assert.equal(seat.handle(arrowPress('Enter')), false)
  state.draft = ''
  const elsewhere = await historySeat({ inComposer: () => false })
  assert.equal(elsewhere.seat.handle(arrowPress('ArrowUp')), false)
  const menu = await historySeat({ menuOwnsKey: () => true })
  assert.equal(menu.seat.handle(arrowPress('ArrowUp')), false)
  const off = await historySeat({ enabled: () => false })
  assert.equal(off.seat.handle(arrowPress('ArrowUp')), false)
  assert.deepEqual(state.writes, [])
})

test('the composer history seat stops taking over once the browsing draft is edited', async () => {
  const { seat, state } = await historySeat()
  seat.handle(arrowPress('ArrowUp'))
  assert.equal(state.draft, '第二条')
  // The user edited the recalled text: walking on would throw that edit away.
  state.draft = '第二条（改过）'
  assert.equal(seat.handle(arrowPress('ArrowUp')), false)
  assert.equal(state.draft, '第二条（改过）')
})

test('the composer history seat pulls one older page when it runs off the head', async () => {
  const { seat, state } = await historySeat()
  state.messages = [{ seq: 3, text: '第一条', images: [], files: [] }]
  state.hasMore = true
  assert.equal(seat.handle(arrowPress('ArrowUp')), true)
  assert.equal(state.draft, '第一条')
  assert.equal(seat.handle(arrowPress('ArrowUp')), true)
  assert.equal(state.loaded, 1)
  // The prepended page lands after the load resolves; the seat re-reads the
  // window instead of remembering an index that the prepend would shift.
  state.messages = [{ seq: 1, text: '更早', images: [], files: [] }, ...state.messages]
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(state.draft, '更早')
})

test('the composer history seat resets its recall position when the session changes', async () => {
  const { seat, state } = await historySeat()
  seat.handle(arrowPress('ArrowUp'))
  assert.equal(state.draft, '第二条')
  state.session = 's2'
  assert.equal(seat.handle(arrowPress('ArrowDown')), false)
  assert.equal(state.draft, '第二条')
})

test('a recalled message brings its picture back and names the files it cannot', async () => {
  const { seat, state } = await historySeat()
  state.messages = [{ seq: 3, text: '看图', images: [{ attachmentId: 'img-1' }], files: [] }]
  seat.handle(arrowPress('ArrowUp'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(state.pasted, ['img-1'])
  assert.equal(state.draft, '看图')

  // A file attachment has no readable bytes, so the draft keeps its name as a
  // placeholder line the user can delete before sending.
  const files = await historySeat()
  files.state.messages = [{ seq: 4, text: '看文件', images: [], files: [{ name: 'a.pdf' }] }]
  files.seat.handle(arrowPress('ArrowUp'))
  assert.equal(files.state.draft, '看文件\n[附件：a.pdf]')
})


