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
        return { Tooltip: (props) => props.children ?? null, Switch: () => null }
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

test('apply registers the footer button and the 心流 section', async () => {
  const module = await load()
  const registrations = []
  const effects = []
  const ctx = fakeContext(registrations, effects)
  module.apply(ctx)

  const footer = registrations.find((entry) => entry.name === 'sidebar.footer.action')
  assert.equal(footer.id, 'flow')
  assert.equal(typeof footer.order, 'number')

  const section = registrations.find((entry) => entry.name === 'settings.section')
  assert.equal(section.id, 'flow')
  assert.equal(section.label(), '心流')
  assert.ok(section.order < 40, 'must land ahead of the shipped third-party sections')

  // Every registration the module makes is released with its fiber.
  assert.ok(effects.length >= 2)
  assert.ok(registrations.length >= 2)
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

/** A client-root stub with exactly the services the module injects. */
function fakeContext(registrations, effects, { served = true } = {}) {
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
        return () => {}
      },
      bind: (ns) => (key, params) => translate(ns, key, params),
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0, active: 'zh' }),
    },
    sessions: { list: { getSnapshot: () => list(), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
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
