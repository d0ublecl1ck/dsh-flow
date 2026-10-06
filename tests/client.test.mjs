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
  const overlay = registrations.find((entry) => entry.name === 'shell.overlay')
  assert.equal(overlay.id, 'flow')
  assert.equal(overlay.locale, 'flow')

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
  ]) {
    assert.equal(typeof flow.zh[key], 'string', key)
    assert.notEqual(flow.zh[key].length, 0, key)
    assert.equal(typeof flow.en[key], 'string', key)
  }
  assert.equal(flow.zh['copy.menu'], '复制会话 ID')
  assert.equal(flow.zh['copy.done'], '已复制会话 ID')
  assert.equal(flow.zh['copy.failed'], '复制失败，剪贴板不可用')
})

/** A client-root stub with exactly the services the module injects. */
function fakeContext(registrations, effects, { served = true, commands = [], recorded = null } = {}) {
  const form = {
    getSnapshot: () => ({ value: {}, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }
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
      return typeof dispose === 'function' ? dispose : () => {}
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
