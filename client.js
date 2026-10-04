/**
 * dsh-flow — browser half.
 *
 * Two surfaces, one entry:
 *
 *  - the 「定位当前会话」 button, sitting in the workspace browser's section
 *    header immediately to the right of the search control — the seat JetBrains
 *    gives *Scroll from Source* in a tool window's toolbar. One click brings the
 *    Session the conversation column is showing back into view: it expands the
 *    sidebar when it is a rail, opens the owning Workspace group when it is
 *    folded, raises that group's overflow when the row hides behind it, then
 *    scrolls the row into view and flashes it. The sidebar reveals rows with
 *    `scrollIntoView({block:'nearest'})` on `[data-row-key="session:<id>"]`;
 *    every step here speaks that same shipped contract.
 *  - `settings.section` — the 心流 page, holding the one preference that turns
 *    the button off. The preference lives in this plugin's Host Config
 *    namespace (`flow.locateButton`), reached through `ctx.configForms`, so it
 *    is a durable part of the settings document rather than page-local state.
 *
 * The header is not a slot: the shell's browsing region is a single-occupant
 * slot (`sidebar.workspaces`) whose header declares no hole beside the search
 * control, so the button is portalled into a container this plugin inserts
 * after that control. The `sidebar.footer.action` entry below renders nothing —
 * it exists for the component's lifecycle and locale seat, which is the only
 * mount point a client plugin gets. Because the rail form of the header carries
 * no search control at all, the button is absent there by design rather than
 * mis-inserted somewhere else.
 *
 * @module dsh-flow/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-flow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { createPortal } = require('react-dom')
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
    const { Switch, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Row id of the bundle — also the settings namespace and the locale namespace. */
    const ENTRY_ID = 'flow'

    /**
     * Order of the footer entry that carries this plugin's lifecycle. The entry
     * renders nothing visible, so the order only has to stay unique: the shipped
     * third-party seats in this slot use 890/900 and 1000.
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
     * Resolve the browsing region's header and the search seat the button sits
     * beside.
     *
     * The header is recognised by the control it must contain, not by position:
     * the section label, the search seat, and the trailing action cluster are
     * the shipped children, and only one header in the shell holds a search
     * seat. A rail header has no search seat at all, which is how the button
     * knows to stay away rather than drift to another edge.
     *
     * @param doc - document to read.
     * @returns `{header, searchSlot}`, or null while no header carries a search seat.
     */
    function resolveHeaderAnchors(doc) {
      if (typeof doc?.querySelectorAll !== 'function') return null
      for (const header of doc.querySelectorAll('[class*="sectionHeader"]')) {
        if (!isElement(header)) continue
        const searchSlot = header.querySelector('[class*="searchSlot"]')
        if (!isElement(searchSlot)) continue
        if (searchSlot.querySelector('button') === null) continue
        return { header, searchSlot }
      }
      return null
    }

    /**
     * Insert this plugin's container directly after the search seat and return
     * it.
     *
     * Inserting — never moving or removing shell nodes — is what keeps the
     * container safe across React re-renders: the shell owns its children, this
     * plugin owns the extra node, and reconciliation leaves it alone. The
     * caller re-runs this only when the container it holds is gone or has been
     * pushed out of position.
     *
     * @param searchSlot - the header's search seat.
     * @returns the attached container.
     */
    function attachLocateHost(searchSlot) {
      const host = searchSlot.ownerDocument.createElement('div')
      host.className = 'flow-host'
      host.dataset.flowHost = 'locate'
      searchSlot.insertAdjacentElement('afterend', host)
      return host
    }

    /**
     * One locating pass.
     *
     * The caller drives this in a bounded loop: an expansion was just kicked
     * off and the shell needs a repaint before the next pass can see the row.
     *
     * @param input - the button, the two snapshots, and an optional resolved seat.
     * @returns `no-session`, `revealed`, `retry`, or `missing`.
     */
    function locateCurrentSession(input) {
      const sessionId = currentSessionId(input.sessionList)
      if (sessionId === null) return { status: 'no-session' }
      const listArea = input.listArea ?? resolveListArea(input.anchor)
      // No seat means the browsing region has not mounted yet; the caller looks
      // again on the next frame before calling this a miss.
      if (listArea === null || listArea === undefined) return { status: 'retry' }
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
.flow-host{flex:none;display:flex;align-items:center}
.flow-locate{box-sizing:border-box;flex:none;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.flow-locate:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,140,.12))}
.flow-locate:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:-2px}
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
      'section.locate.description': '在工作区标题行、搜索按钮右侧显示「定位当前会话」按钮：点击后展开并滚动到当前打开的会话。',
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
      'section.locate.description': 'Show a “Locate current Session” button in the workspace header, beside the search control; clicking it expands and scrolls to the open Session.',
      'section.locate.error': 'The preference was not saved. Try again.',
    }

    // #endregion

    // #region components

    /**
     * The mark the button wears: the IntelliJ platform's own *Locate* icon,
     * `platform/icons/src/icons/general/locate.svg`, carried verbatim.
     *
     * Copyright 2000-2022 JetBrains s.r.o. and contributors. Use of this source
     * code is governed by the Apache 2.0 license (see THIRD-PARTY-NOTICES.md).
     *
     * One change from the original: the shipped artwork hard-codes the light
     * theme's label colour and ships a separate dark file, while this glyph
     * inherits `currentColor` so the button's own theme token decides it.
     */
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
        h('path', {
          fillRule: 'evenodd',
          clipRule: 'evenodd',
          fill: 'currentColor',
          d: 'M8.5 5V2.02054C11.4149 2.26101 13.739 4.5851 13.9795 7.5H11C10.7239 7.5 10.5 7.72386 10.5 8C10.5 8.27614 10.7239 8.5 11 8.5H13.9795C13.739 11.4149 11.4149 13.739 8.5 13.9795V11C8.5 10.7239 8.27614 10.5 8 10.5C7.72386 10.5 7.5 10.7239 7.5 11V13.9795C4.5851 13.739 2.26101 11.4149 2.02054 8.5H5C5.27614 8.5 5.5 8.27614 5.5 8C5.5 7.72386 5.27614 7.5 5 7.5H2.02054C2.26101 4.5851 4.5851 2.26101 7.5 2.02054V5C7.5 5.27614 7.72386 5.5 8 5.5C8.27614 5.5 8.5 5.27614 8.5 5ZM1 8C1 4.13401 4.13401 1 8 1C11.866 1 15 4.13401 15 8C15 11.866 11.866 15 8 15C4.13401 15 1 11.866 1 8Z',
        }),
      )
    }

    /**
     * Keep one container attached immediately after the header's search seat,
     * for as long as the button is wanted and that seat exists.
     *
     * The shell re-renders the browsing region freely (a fold, a view change, a
     * locale switch), so the container is re-checked whenever the document
     * mutates and is only rebuilt when the shell actually dropped it or moved
     * another node into its place. A rail header has no search seat, so the
     * container is removed there and the button simply is not part of that
     * form.
     *
     * @param enabled - whether the preference asks for the button at all.
     * @returns the container to portal into, or null while there is none.
     */
    function useLocateHost(enabled) {
      const [host, setHost] = useState(null)
      useEffect(() => {
        if (!enabled || typeof document === 'undefined') {
          setHost(null)
          return undefined
        }
        let current = null
        let frame = null
        const sync = () => {
          frame = null
          const anchors = resolveHeaderAnchors(document)
          if (anchors === null) {
            if (current !== null) {
              current.remove()
              current = null
              setHost(null)
            }
            return
          }
          if (current !== null && current.isConnected && current.previousElementSibling === anchors.searchSlot) return
          current?.remove()
          current = attachLocateHost(anchors.searchSlot)
          setHost(current)
        }
        const schedule = () => {
          if (frame === null) frame = window.requestAnimationFrame(sync)
        }
        sync()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
          if (frame !== null) window.cancelAnimationFrame(frame)
          current?.remove()
          setHost(null)
        }
      }, [enabled])
      return host
    }

    /**
     * The 「定位当前会话」 button, portalled into the header container.
     *
     * @param props - both snapshots, the plugin's config form, and the
     * localized copy.
     */
    function LocateButton(props) {
      const { t, sessions, workspaces } = props
      const anchor = useRef(null)
      const [notice, setNotice] = useState(null)
      const [missed, setMissed] = useState(false)
      const enabled = useConfigValue(props.config)
      // The locale revision is this component's only re-render trigger for copy.
      props.useLocaleRevision()
      const host = useLocateHost(enabled)

      const locate = useCallback(() => {
        let attempt = 0
        setMissed(false)
        const pass = () => {
          const outcome = locateCurrentSession({
            anchor: anchor.current,
            sessionList: sessions.getSnapshot(),
            workspaceList: workspaces.getSnapshot(),
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
          // `retry`: an expansion is in flight, or the region has not mounted.
          attempt += 1
          if (attempt > RETRY_ATTEMPTS) {
            setNotice(t('locate.missing'))
            setMissed(true)
            return
          }
          setTimeout(pass, RETRY_BASE_MS * attempt)
        }
        pass()
      }, [sessions, t, workspaces])

      if (!enabled || host === null) return null

      return createPortal(
        h(
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
        ),
        host,
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
      inject: ['slots', 'locale', 'configForms', 'sessions', 'workspaces'],
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
        // One form, two surfaces: the button reads it for its visibility, the
        // page reads and writes it.
        const forms = ctx.configForms
        const config = forms.get(ENTRY_ID)

        // The entry itself renders nothing: it is this plugin's lifecycle and
        // locale seat, and the button is portalled into the header instead.
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
          config,
          useLocaleRevision,
        }))), 'flow: locate button seat')

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
        resolveHeaderAnchors,
        attachLocateHost,
        readLocateEnabled,
      },
    }
  },
})
