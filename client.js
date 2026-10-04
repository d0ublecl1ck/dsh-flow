/**
 * dsh-flow — browser half.
 *
 * Two surfaces, one entry:
 *
 *  - `sidebar.footer.action` — the 「定位当前会话」 button, placed beside the
 *    Settings row the way JetBrains puts *Scroll from Source* in a tool
 *    window's footer. One click brings the Session the conversation column is
 *    showing back into view: it expands the sidebar when it is a rail, opens
 *    the owning Workspace group when it is folded, raises that group's
 *    overflow when the row hides behind it, then scrolls the row into view and
 *    flashes it. The sidebar reveals rows with `scrollIntoView({block:
 *    'nearest'})` on `[data-row-key="session:<id>"]`; every step here speaks
 *    that same shipped contract (see the anchor notes in `internals`).
 *  - `settings.section` — the 心流 page, holding the one preference that turns
 *    the button off. The preference lives in this plugin's Host Config
 *    namespace (`flow.locateButton`), reached through `ctx.configForms`, so it
 *    is a durable part of the settings document rather than page-local state.
 *
 * The preference is read by both surfaces through the one form, and only the
 * page is withheld while the Host serves no `flow` namespace; the button keeps
 * rendering so a deployment can never lose the entry point silently.
 *
 * @module dsh-flow/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-flow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useRef, useState, useSyncExternalStore } = React
    const { Switch, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Row id of the bundle — also the settings namespace and the locale namespace. */
    const ENTRY_ID = 'flow'

    /**
     * Footer order. The plugin's own seats never collide: session-radar owns
     * 890/900, hide-empty-workspace 1000, so the locate button sits after the
     * shipped readouts and before the workspace hider.
     */
    const FOOTER_ORDER = 950

    /** Settings-nav order: after the shipped sections (0/10/15), before the market (40). */
    const SECTION_ORDER = 20

    /** How long the flash on a revealed row lasts. */
    const FLASH_MS = 900

    /** Retry pacing while the shell re-renders an expansion: 40ms, then +40ms each pass. */
    const RETRY_BASE_MS = 40
    const RETRY_ATTEMPTS = 8

    // #region pure DOM/model logic

    /** Structural element check; the page's HTMLElement is not a global this module can assume. */
    function isElement(value) {
      return typeof value === 'object' && value !== null && value.nodeType === 1
    }

    /**
     * Find the Session the conversation column currently shows.
     *
     * `retainedBy.mainView` is the shell's own signal for "the main column holds
     * this Session"; a row it does not positively retain is not open.
     *
     * @param list - Session list snapshot (`{ids, byId}`).
     * @returns the open Session id, or null when no conversation is selected.
     */
    function currentSessionId(list) {
      if (list === null || list === undefined || !Array.isArray(list.ids)) return null
      for (const id of list.ids) {
        if (((list.byId?.[id]?.retainedBy?.mainView) ?? 0) > 0) return id
      }
      return null
    }

    /**
     * Find the rendered sidebar row for a Session.
     * @param listArea - the sidebar's list seat.
     * @param sessionId - Session whose row to find.
     * @returns the row element, or undefined when it is not rendered.
     */
    function findSessionRow(listArea, sessionId) {
      if (!isElement(listArea) && typeof listArea?.querySelector !== 'function') return undefined
      const row = listArea.querySelector(`[data-row-key="session:${sessionId}"]`)
      return isElement(row) ? row : undefined
    }

    /** Bring a row into view in its own scrollport — the exact call the shell's own reveal makes. */
    function revealRow(row) {
      if (typeof row?.scrollIntoView !== 'function') return
      row.scrollIntoView({ block: 'nearest' })
    }

    /**
     * Flash a row once, so the eye can find it after the scroll.
     *
     * The Web Animations API is used instead of a class: React owns the row's
     * `className` and would drop a class on its next render, while an animation
     * effect survives it. The colour resolves through the shell's own token so
     * the flash follows the theme; an unparsable value degrades to no flash
     * rather than to an error.
     *
     * @param row - the row to flash.
     */
    function flashRow(row) {
      if (typeof row?.animate !== 'function') return
      try {
        row.animate(
          [
            { backgroundColor: 'rgba(0, 0, 0, 0)' },
            { backgroundColor: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 140, 0.24))' },
            { backgroundColor: 'rgba(0, 0, 0, 0)' },
          ],
          { duration: FLASH_MS, easing: 'ease-in-out' },
        )
      } catch {
        // A shell that cannot animate the row still got the scroll.
      }
    }

    /**
     * Resolve the Workspace group key that holds a Session.
     *
     * The Session list does not carry its Workspace; the registry's
     * `sessionIds` is the only attribution the shell itself uses. A Session no
     * Workspace claims renders in the ungrouped bucket, whose row key is the
     * empty string.
     *
     * @param items - Workspace registry rows.
     * @param sessionId - Session to place.
     * @returns the group key, or `''` for the ungrouped bucket.
     */
    function owningGroupKey(items, sessionId) {
      for (const workspace of items ?? []) {
        if (workspace?.sessionIds?.includes(sessionId)) return workspace.workspaceId ?? ''
      }
      return ''
    }

    /**
     * Bring one Session's row into view, taking the one expansion step that
     * stands between the row and the viewport.
     *
     * @param listArea - the sidebar's list seat.
     * @param groupKey - owning Workspace group key.
     * @param sessionId - Session to reveal.
     * @returns `revealed`, `expanding-group`, `expanding-overflow`, `missing`, or `no-list`.
     */
    function revealSessionRow(listArea, groupKey, sessionId) {
      if (listArea === null || listArea === undefined) return { status: 'no-list' }
      const row = findSessionRow(listArea, sessionId)
      if (row !== undefined) {
        revealRow(row)
        flashRow(row)
        return { status: 'revealed' }
      }
      // A folded group renders no member rows at all, so its disclosure is the
      // only way in. `aria-expanded` is the shell's own fold state.
      const group = listArea.querySelector(`[data-row-key="workspace:${groupKey}"]`)
      if (isElement(group) && group.getAttribute('aria-expanded') === 'false') {
        group.click()
        return { status: 'expanding-group' }
      }
      // An open group still hides its tail behind an overflow row.
      const overflow = listArea.querySelector(`[data-row-key="overflow:${groupKey}"]`)
      if (isElement(overflow)) {
        overflow.click()
        return { status: 'expanding-overflow' }
      }
      return { status: 'missing' }
    }

    /**
     * Resolve the sidebar's list seat from the button's own position.
     *
     * The nearest ancestor that owns a list seat IS the sidebar root, so this
     * can never reach a list elsewhere in the page; the search simply never
     * leaves the column the button lives in.
     *
     * @param anchor - the button element.
     * @returns the list seat, or null while the browsing region is unmounted.
     */
    function resolveListArea(anchor) {
      let node = anchor?.parentElement ?? null
      while (isElement(node)) {
        const area = node.querySelector('[class*="listArea"]')
        if (isElement(area)) return area
        node = node.parentElement
      }
      return null
    }

    /**
     * Whether the sidebar currently renders as a rail.
     *
     * The layout frame publishes its own collapsed fact as a boolean attribute,
     * which is also what the shell's stylesheets key off; a rail has no list
     * seat, so this is the one case where locating must expand first.
     *
     * @param doc - document to read.
     * @returns true while the sidebar is collapsed.
     */
    function isSidebarCollapsed(doc) {
      return (doc?.querySelector?.('[data-sidebar-collapsed]') ?? null) !== null
    }

    /**
     * One locating pass.
     *
     * The caller drives this in a bounded loop: an expansion was just kicked
     * off and the shell needs a repaint before the next pass can see the row.
     *
     * @param input - anchor, resolved seat, both snapshots, and the expansion hooks.
     * @returns `no-session`, `revealed`, `expanding-sidebar`, `retry`, or `missing`.
     */
    function locateCurrentSession(input) {
      const sessionId = currentSessionId(input.sessionList)
      if (sessionId === null) return { status: 'no-session' }
      const listArea = input.listArea ?? resolveListArea(input.anchor)
      if (listArea === null || listArea === undefined) {
        // A rail renders no rows at all: expand it, then look again.
        if (input.collapsed === true && typeof input.expandSidebar === 'function') {
          input.expandSidebar()
          return { status: 'expanding-sidebar' }
        }
        // The region may simply not have mounted yet.
        return { status: 'retry' }
      }
      const step = revealSessionRow(listArea, owningGroupKey(input.workspaceList?.items, sessionId), sessionId)
      if (step.status === 'revealed') return { status: 'revealed' }
      if (step.status === 'expanding-group' || step.status === 'expanding-overflow') return { status: 'retry' }
      return { status: 'missing' }
    }

    /**
     * Read the button preference off the plugin's config form.
     * @param form - `ctx.configForms.get('flow')`.
     * @returns whether the button is shown; an unreadable form keeps the default.
     */
    function readLocateEnabled(form) {
      let value
      try {
        value = form.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value === null || typeof value !== 'object') return true
      return value.locateButton !== false
    }

    // #endregion

    // #region styles

    const STYLE_TAG = 'dsh-flow/flow.css'

    const CSS = `
.flow-locate{box-sizing:border-box;flex:none;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.flow-locate:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,140,.12))}
.flow-locate:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:-2px}
.flow-locate[data-rail="true"]{width:36px;height:36px;border-radius:var(--dsw-radius-md,10px);color:var(--dsw-alias-label-primary,currentColor)}
.flow-locate[data-miss="true"]{color:var(--dsw-alias-state-warning-primary,currentColor)}
.flow-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.flow-section{display:flex;flex-direction:column}
.flow-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,140,.2))}
.flow-row__title{font-size:14px;line-height:20px}
.flow-row__description{margin-top:4px;color:var(--dsw-alias-label-secondary,currentColor);font-size:12px;line-height:18px}
.flow-row__error{margin-top:4px;color:var(--dsw-alias-state-error-primary,currentColor);font-size:12px;line-height:18px}
`

    /** Inject the plugin's one stylesheet; the disposer removes it with the fiber. */
    function injectStyles() {
      if (typeof document === 'undefined') return { remove() {} }
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG}"]`)
      if (existing !== null) return { remove() { existing.remove() } }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-flow'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
      return { remove() { tag.remove() } }
    }

    // #endregion

    // #region copy

    /** Simplified Chinese copy (the key-set source of truth). */
    const zh = {
      'locate.label': '定位当前会话',
      'locate.done': '已定位到当前会话',
      'locate.noSession': '当前没有打开的会话',
      'locate.missing': '当前会话不在侧边栏的筛选结果里',
      'section.title': '心流',
      'section.locate.title': '定位当前会话按钮',
      'section.locate.description': '在侧边栏底部显示「定位当前会话」按钮：点击后展开并滚动到当前打开的会话。',
      'section.locate.error': '偏好没有保存成功，请重试',
    }

    /** English dictionary, complete against the zh key set. */
    const en = {
      'locate.label': 'Locate current Session',
      'locate.done': 'Current Session located',
      'locate.noSession': 'No Session is open',
      'locate.missing': 'The current Session is outside the sidebar filter',
      'section.title': 'Flow',
      'section.locate.title': 'Locate current Session button',
      'section.locate.description': 'Show a “Locate current Session” button at the sidebar foot; clicking it expands and scrolls to the open Session.',
      'section.locate.error': 'The preference was not saved. Try again.',
    }

    // #endregion

    // #region components

    /** The JetBrains-style target mark the button wears. */
    function LocateIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { cx: 8, cy: 8, r: 4.25, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 8, cy: 8, r: 1.1, fill: 'currentColor' }),
        h('path', {
          d: 'M8 0.9V3.2M8 12.8V15.1M0.9 8H3.2M12.8 8H15.1',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * The sidebar-foot button.
     *
     * @param props - slot owner share, the localized copy, both snapshots, and
     * the sidebar expansion hook.
     */
    function LocateButton(props) {
      const { t, wide, sessions, workspaces, layout } = props
      const anchor = useRef(null)
      const [notice, setNotice] = useState(null)
      const [missed, setMissed] = useState(false)
      const enabled = useConfigValue(props.config)
      // The locale revision is this component's only re-render trigger for copy.
      props.useLocaleRevision()

      const locate = useCallback(() => {
        let attempt = 0
        setMissed(false)
        const pass = () => {
          const outcome = locateCurrentSession({
            anchor: anchor.current,
            sessionList: sessions.getSnapshot(),
            workspaceList: workspaces.getSnapshot(),
            collapsed: isSidebarCollapsed(anchor.current?.ownerDocument ?? globalThis.document),
            expandSidebar: () => layout.toggleSidebar(),
          })
          if (outcome.status === 'revealed') {
            setNotice(t('locate.done'))
            return
          }
          if (outcome.status === 'no-session') {
            setNotice(t('locate.noSession'))
            setMissed(true)
            return
          }
          if (outcome.status === 'missing') {
            setNotice(t('locate.missing'))
            setMissed(true)
            return
          }
          // `retry` and `expanding-sidebar`: an expansion is in flight.
          attempt += 1
          if (attempt > RETRY_ATTEMPTS) {
            setNotice(t('locate.missing'))
            setMissed(true)
            return
          }
          setTimeout(pass, RETRY_BASE_MS * attempt)
        }
        pass()
      }, [layout, sessions, t, workspaces])

      if (!enabled) return null

      return h(
        React.Fragment,
        null,
        h(
          Tooltip,
          { label: t('locate.label'), delayMs: 500 },
          h(
            'button',
            {
              ref: anchor,
              type: 'button',
              className: 'flow-locate',
              'data-rail': wide ? 'false' : 'true',
              'data-miss': missed ? 'true' : 'false',
              'aria-label': t('locate.label'),
              onClick: locate,
            },
            h(LocateIcon, null),
          ),
        ),
        h(
          'span',
          { className: 'flow-visually-hidden', role: 'status', 'aria-live': 'polite' },
          notice ?? '',
        ),
      )
    }

    /**
     * The 心流 settings page: the button's one preference.
     *
     * @param props - localized copy and the plugin's config form.
     */
    function FlowSection(props) {
      const { t, config } = props
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      const enabled = useConfigValue(config)
      props.useLocaleRevision()

      const write = (next) => {
        setFailed(false)
        setBusy(true)
        Promise.resolve(config.set('locateButton', next))
          .then((accepted) => {
            if (accepted === false) setFailed(true)
          }, () => {
            setFailed(true)
          })
          .finally(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'flow-section' },
        h(
          'div',
          { className: 'flow-row' },
          h(
            'div',
            null,
            h('div', { className: 'flow-row__title' }, t('section.locate.title')),
            h('div', { className: 'flow-row__description' }, t('section.locate.description')),
            failed && h('div', { className: 'flow-row__error', role: 'alert' }, t('section.locate.error')),
          ),
          h(Switch, {
            checked: enabled,
            disabled: busy,
            label: t('section.locate.title'),
            onChange: write,
          }),
        ),
      )
    }

    /** Observe the plugin's config form as the button/page preference. */
    function useConfigValue(config) {
      const subscribe = useCallback((listener) => config.subscribe(listener), [config])
      const read = useCallback(() => readLocateEnabled(config), [config])
      return useSyncExternalStore(subscribe, read, read)
    }

    // #endregion

    return {
      inject: ['slots', 'locale', 'configForms', 'sessions', 'workspaces', 'layout'],
      apply(ctx) {
        ctx.effect(() => {
          const style = injectStyles()
          return () => style.remove()
        }, 'flow: styles')
        ctx.effect(() => ctx.locale.register(ENTRY_ID, { zh, en }), 'flow: dictionaries')

        const t = ctx.locale.bind(ENTRY_ID)
        /** Re-render a surface when the active locale, or its dictionaries, move. */
        const useLocaleRevision = () => useSyncExternalStore(
          useCallback((listener) => ctx.locale.subscribe(listener), []),
          useCallback(() => ctx.locale.getSnapshot().revision, []),
        )

        const sessions = ctx.sessions.list
        const workspaces = ctx.workspaces.list
        const layout = ctx.layout
        // One form, two surfaces: the button reads it for its visibility, the
        // page reads and writes it.
        const forms = ctx.configForms
        const config = forms.get(ENTRY_ID)

        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: ENTRY_ID,
          order: FOOTER_ORDER,
          locale: ENTRY_ID,
        }, (props) => h(LocateButton, {
          ...props,
          t,
          sessions,
          workspaces,
          layout,
          config,
          useLocaleRevision,
        }))), 'flow: locate button')

        // The page follows the Host's own namespace: a deployment that never
        // served `flow` shows no trace of the section.
        ctx.effect(() => forms.whileServed([ENTRY_ID], () => ctx.slots.inject(
          'settings.section',
          () => ctx.slots.register({
            name: 'settings.section',
            id: ENTRY_ID,
            order: SECTION_ORDER,
            label: () => t('section.title'),
            locale: ENTRY_ID,
          }, (props) => h(FlowSection, { ...props, t, config, useLocaleRevision })),
        )), 'flow: settings section')
      },
      internals: {
        ENTRY_ID,
        FOOTER_ORDER,
        SECTION_ORDER,
        currentSessionId,
        findSessionRow,
        owningGroupKey,
        revealSessionRow,
        locateCurrentSession,
        resolveListArea,
        isSidebarCollapsed,
        readLocateEnabled,
      },
    }
  },
})
