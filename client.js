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
 *  - 「复制会话 ID」 — right-clicking a Session row opens the shell's own row
 *    menu, so the seat for this is that menu's item list rather than a context
 *    menu of this plugin's own: one entry reaches both the right-click menu and
 *    the "..." menu. The same copy is `flow.copySessionId` (`⇧⌘C`), which copies
 *    the Session the conversation column holds. Both report through one notice
 *    seat (`shell.overlay` + the shipped `Toast`), so a copy is never silent.
 *  - `settings.section` — the 心流 page, holding the two preferences that turn
 *    the button and the copy off. They live in this plugin's Host Config
 *    namespace (`flow.locateButton` / `flow.copySessionId`), reached through
 *    `ctx.configForms`, so they are a durable part of the settings document
 *    rather than page-local state.
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
    const {
      IconCopyOutlineRegular,
      IconWarningOutlineRegular,
      MenuItemButton,
      Switch,
      Toast,
      Tooltip,
      writeClipboard,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

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

    /**
     * Read the copy preference off the plugin's config form.
     * @param form - `ctx.configForms.get('flow')`.
     * @returns whether the feature is on; an unreadable form keeps the default.
     */
    function readCopyEnabled(form) {
      let value
      try {
        value = form.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value === null || typeof value !== 'object') return true
      return value.copySessionId !== false
    }

    /**
     * The one notice seat both copy entry points report through.
     *
     * Every notice is a new snapshot carrying a new sequence: React compares
     * snapshots by identity, and the Toast restarts its cycle when it remounts.
     *
     * @returns the store the notice overlay reads and both copiers write.
     */
    function createNoticeStore() {
      let snapshot = null
      let seq = 0
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        /** @returns the notice on display, or null. */
        getSnapshot: () => snapshot,
        /**
         * @param listener - called on every change.
         * @returns a disposer removing only this listener.
         */
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /**
         * Raise one notice, replacing whatever is on screen.
         * @param text - the localized sentence to show.
         * @param tone - `success` for a deed done, `warning` for a refusal.
         */
        show: (text, tone) => {
          seq += 1
          snapshot = { seq, text, tone }
          emit()
        },
        /** Retire the notice on screen; an empty seat is not a change. */
        clear: () => {
          if (snapshot === null) return
          snapshot = null
          emit()
        },
      }
    }

    /**
     * Copy one Session id and report the outcome.
     *
     * A copy is never silent: the clipboard is asked first and the notice
     * repeats its verdict, so a refused write reads as a refusal instead of as a
     * copy that appeared to work.
     *
     * @param input.sessionId - the id to place on the clipboard.
     * @param input.write - the clipboard write, answering whether the host accepted it.
     * @param input.notify - raise a notice.
     * @param input.t - the plugin's localized copy.
     * @returns whether the clipboard accepted the write.
     */
    function copySessionId(input) {
      return Promise.resolve()
        .then(() => input.write(input.sessionId))
        .then(
          (accepted) => {
            const copied = accepted === true
            input.notify(copied ? input.t('copy.done') : input.t('copy.failed'), copied ? 'success' : 'warning')
            return copied
          },
          () => {
            input.notify(input.t('copy.failed'), 'warning')
            return false
          },
        )
    }

    /**
     * Create the one-slot seat the mounted button and the plugin-scope command
     * share.
     *
     * Locating can only live inside the mounted button: it needs the resolved
     * header container to read the list seat from, it owns the retry pacing, and
     * it owns the live region that reports the outcome. The command, on the
     * other hand, is registered once for the plugin's lifetime. This seat is
     * that seam — the button publishes while it is mounted, the command resolves
     * against the current publication, and a resolved action captures the
     * handler it saw.
     *
     * @returns the seat.
     */
    function createLocateSeat() {
      let current = null
      return {
        /**
         * Publish the mounted handler.
         * @param handler - the button's locate, or null to clear it.
         * @returns a disposer that clears only the value it published.
         */
        publish(handler) {
          current = handler
          return () => {
            if (current === handler) current = null
          }
        },
        /** @returns the current handler, or null while no button is mounted. */
        current: () => current,
      }
    }

    /**
     * Command ids. They key the stored key overrides, so they have to stay
     * stable.
     */
    const LOCATE_COMMAND = 'flow.locateCurrent'
    const COPY_COMMAND = 'flow.copySessionId'

    /**
     * Order of this plugin's Session-row menu row: the shell's own recipe for a
     * third-party row places it after the shipped actions (pin 100, rename 200,
     * fork 300, archive 400) and opens the group with a separator.
     */
    const MENU_ORDER = 500

    /**
     * Every profile that admits a `Mod+Shift+<letter>` default, and the reason
     * this plugin declares no other shape.
     *
     * macOS Desktop runs the Web shortcut path (its preload sets
     * `data-dsh-desktop-web-shortcuts`, so the runtime is `web`), where a bare
     * Command+letter is rejected as `unsupported-browser` and an Option
     * combination can die as a macOS dead key — Mod+Shift avoids both. Linux Web
     * admits only Mod+Slash, Mod+Shift+Comma and Mod+Shift+Period, so it is left
     * unbound rather than declared: the registry rejects a default it cannot
     * honour by throwing, and a throw takes the whole client half down with it.
     */
    const MOD_SHIFT_PROFILES = [
      'desktop:macos',
      'desktop:windows',
      'desktop:linux',
      'web:macos',
      'web:windows',
    ]

    /**
     * Per-profile defaults for one command.
     * @param code - the physical key code every profile binds.
     * @param profiles - the shells to declare it for.
     * @returns the default map `ctx.shortcuts.register` validates.
     */
    function primaryShiftDefaults(code, profiles) {
      return Object.fromEntries(
        profiles.map((profile) => [profile, { code, modifiers: ['primary', 'shift'] }]),
      )
    }

    /** Locating: ⇧⌘D. */
    const LOCATE_DEFAULTS = primaryShiftDefaults('KeyD', MOD_SHIFT_PROFILES)

    /**
     * Copying: ⇧⌘C.
     *
     * The Linux shells are left out deliberately. The registry reserves a
     * primary modifier together with `KeyC` — the browser's own copy — on every
     * shell that is not macOS or Windows, and it validates a default for every
     * declared profile at registration. Declaring one there does not merely lose
     * the key: it throws, and the throw takes the whole client half with it.
     * macOS and Windows are unaffected in both runtimes, because their Web
     * branch admits a two-modifier Mod+Shift combination before the reservation
     * list is consulted.
     */
    const COPY_DEFAULTS = primaryShiftDefaults(
      'KeyC',
      MOD_SHIFT_PROFILES.filter((profile) => !profile.endsWith(':linux')),
    )

    /**
     * Build the locating command over the seat.
     *
     * @param seat - the seat the mounted button publishes into.
     * @param label - localized command name shown in the shortcut reference.
     * @param reasons - localized reasons a press can be refused.
     * @returns the command definition for `ctx.shortcuts.register`.
     */
    function locateCommand(seat, label, reasons) {
      return {
        id: LOCATE_COMMAND,
        label,
        aliases: ['locate current session', 'scroll from source', '定位当前会话'],
        defaults: LOCATE_DEFAULTS,
        regions: ['page', 'editable'],
        modals: [],
        resolve: () => {
          const handler = seat.current()
          // The button has no rail form, so a folded sidebar has nothing to
          // press and the command says so instead of reopening the column.
          if (handler === null) return { status: 'blocked', reason: reasons.unmounted() }
          if (!handler.available()) return { status: 'blocked', reason: reasons.noSession() }
          return { status: 'handled', run: () => { handler.run() } }
        },
      }
    }

    /**
     * Build the copy-Session-id command.
     *
     * The menu row keeps its own click while the command owns the keyboard; both
     * call the same `copy`, so the two entry points cannot drift apart.
     *
     * @param input.copy - copy one Session id.
     * @param input.currentSessionId - the Session the conversation column holds, or null.
     * @param input.enabled - whether the preference still wants the feature.
     * @param input.notify - raise a notice: `(text, tone) => void`.
     * @param input.label - localized command name shown in the shortcut reference.
     * @param input.t - the plugin's localized copy.
     * @returns the command definition for `ctx.shortcuts.register`.
     */
    function copyCommand(input) {
      return {
        id: COPY_COMMAND,
        label: input.label,
        aliases: ['copy session id', 'copy conversation id', '复制会话 ID'],
        defaults: COPY_DEFAULTS,
        regions: ['page', 'editable'],
        modals: [],
        resolve: () => {
          // A preference that turned the feature off is not a refusal to report:
          // passing leaves the combination to the browser or the platform rather
          // than swallowing it.
          if (!input.enabled()) return { status: 'pass' }
          const sessionId = input.currentSessionId()
          if (sessionId === null) {
            // Never `blocked`: the shell drops a blocked reason on the floor, and
            // a press that does nothing visible is the one outcome a copy must
            // not have.
            return { status: 'handled', run: () => { input.notify(input.t('copy.noSession'), 'warning') } }
          }
          return { status: 'handled', run: () => { input.copy(sessionId) } }
        },
      }
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
.flow-row:last-child{border-bottom:none}
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
      'locate.unmounted': '侧边栏已折叠，定位按钮当前不在界面上',
      'copy.label': '复制会话 ID',
      'copy.menu': '复制会话 ID',
      'copy.done': '已复制会话 ID',
      'copy.failed': '复制失败，剪贴板不可用',
      'copy.noSession': '当前没有打开的会话',
      'section.title': '心流',
      'section.locate.title': '定位当前会话按钮',
      'section.locate.description': '在工作区标题行、搜索按钮右侧显示「定位当前会话」按钮：点击后展开并滚动到当前打开的会话。',
      'section.copy.title': '复制会话 ID',
      'section.copy.description': '在会话行的右键菜单里加上「复制会话 ID」，并用 `⇧⌘C`（Windows/Linux 为 Ctrl+Shift+C）复制当前会话的 ID。快捷键可在 设置 → 通用 → 快捷键 里改。',
      'section.saveError': '偏好没有保存成功，请重试',
    }

    /** English dictionary, complete against the zh key set. */
    const en = {
      'locate.label': 'Locate current Session',
      'locate.done': 'Current Session located',
      'locate.noSession': 'No Session is open',
      'locate.missing': 'The current Session is outside the sidebar filter',
      'locate.unmounted': 'The sidebar is collapsed, so the locate button is not on screen',
      'copy.label': 'Copy Session ID',
      'copy.menu': 'Copy Session ID',
      'copy.done': 'Session ID copied',
      'copy.failed': 'Copy failed: the clipboard rejected the write',
      'copy.noSession': 'No Session is open',
      'section.title': 'Flow',
      'section.locate.title': 'Locate current Session button',
      'section.locate.description': 'Show a “Locate current Session” button in the workspace header, beside the search control; clicking it expands and scrolls to the open Session.',
      'section.copy.title': 'Copy Session ID',
      'section.copy.description': 'Add “Copy Session ID” to a Session row’s right-click menu, and bind `⇧⌘C` (Ctrl+Shift+C on Windows/Linux) to copying the open Session’s ID. Rebind it under Settings → General → Shortcuts.',
      'section.saveError': 'The preference was not saved. Try again.',
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
      const enabled = useConfigValue(props.config, readLocateEnabled)
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

      // Hand the live locate to the plugin-scope command while this button is
      // mounted; the command has no other way to reach it.
      useEffect(() => props.seat.publish({
        available: () => currentSessionId(sessions.getSnapshot()) !== null,
        run: locate,
      }), [locate, props.seat, sessions])

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
     * The 「复制会话 ID」 row of a Session row's menu.
     *
     * Right-clicking a Session row opens the shell's own row menu, so the seat
     * for this is that menu's item list rather than a context menu of this
     * plugin's own: one entry reaches the right-click menu and the "..." menu
     * alike. The trailing key hint is read from the live shortcut catalog, so a
     * rebound combination shows up here without this plugin knowing about it.
     *
     * @param props - the row identity, the shell's menu hooks, the plugin's
     * config form, the clipboard writer, and the localized copy.
     */
    function CopySessionIdMenuItem(props) {
      const { sessionId, config, write, notify, t } = props
      const [, setMenuOpen] = props.useMenuOpenState()
      // Every Hook runs before the preference is consulted: the row stays
      // mounted across a toggle and React keeps one call order.
      const shortcut = props.useShortcuts((rows) => rows.find((row) => row.id === COPY_COMMAND))
      const enabled = useConfigValue(config, readCopyEnabled)
      props.useLocaleRevision()
      if (!enabled) return null
      return h(
        MenuItemButton,
        {
          separatorBefore: true,
          icon: h(IconCopyOutlineRegular, null),
          shortcut,
          onSelect: () => {
            setMenuOpen(false)
            copySessionId({ sessionId, write, notify, t })
          },
        },
        t('copy.menu'),
      )
    }

    /**
     * The notice a finished copy reports through: the shell's own Toast, driven
     * by this plugin's one notice seat.
     *
     * It hangs off the overlay layer rather than the Session row, because the
     * row menu unmounts the moment its action is taken.
     *
     * @param props - the notice hook and the dismissal.
     */
    function CopyNotice(props) {
      const notice = props.useNotice((current) => current)
      if (notice === null) return null
      return h(
        Toast,
        {
          text: notice.text,
          tone: notice.tone === 'success' ? 'success' : undefined,
          icon: notice.tone === 'success' ? undefined : h(IconWarningOutlineRegular, null),
          onDone: () => { props.dismiss() },
        },
        `flow-notice-${String(notice.seq)}`,
      )
    }

    /**
     * One settings row: a title, a description, a switch, and its own save state.
     *
     * The write state belongs to the row, not to the page: a refused write on one
     * preference used to paint its error onto the other one as well, which reads
     * as two failures where there is one.
     *
     * @param props - the config form, the preference's own field and reader, the
     * localized copy, and the locale revision hook.
     */
    function SettingsRow(props) {
      const { config, field, read, title, description, error } = props
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      const checked = useConfigValue(config, read)
      props.useLocaleRevision()

      const write = (next) => {
        setFailed(false)
        setBusy(true)
        Promise.resolve(config.set(field, next))
          .then((accepted) => {
            if (accepted === false) setFailed(true)
          }, () => {
            setFailed(true)
          })
          .finally(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'flow-row' },
        h(
          'div',
          null,
          h('div', { className: 'flow-row__title' }, title),
          h('div', { className: 'flow-row__description' }, description),
          failed && h('div', { className: 'flow-row__error', role: 'alert' }, error),
        ),
        h(Switch, {
          checked,
          disabled: busy,
          label: title,
          onChange: write,
        }),
      )
    }

    /**
     * The 心流 settings page: the two preferences this plugin owns.
     *
     * @param props - localized copy and the plugin's config form.
     */
    function FlowSection(props) {
      const { t, config } = props
      return h(
        'div',
        { className: 'flow-section' },
        h(SettingsRow, {
          config,
          field: 'locateButton',
          read: readLocateEnabled,
          title: t('section.locate.title'),
          description: t('section.locate.description'),
          error: t('section.saveError'),
          useLocaleRevision: props.useLocaleRevision,
        }),
        h(SettingsRow, {
          config,
          field: 'copySessionId',
          read: readCopyEnabled,
          title: t('section.copy.title'),
          description: t('section.copy.description'),
          error: t('section.saveError'),
          useLocaleRevision: props.useLocaleRevision,
        }),
      )
    }

    /**
     * Observe one preference on the plugin's config form.
     *
     * @param config - `ctx.configForms.get('flow')`.
     * @param read - the preference's own reader, which owns its default.
     */
    function useConfigValue(config, read) {
      const subscribe = useCallback((listener) => config.subscribe(listener), [config])
      const snapshot = useCallback(() => read(config), [config, read])
      return useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    // #endregion

    return {
      inject: ['slots', 'locale', 'configForms', 'sessions', 'workspaces', 'shortcuts'],
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
        // One notice seat for both copy entry points: the row menu and the
        // command copy the same text and report through the same place.
        const notice = createNoticeStore()
        const notify = (text, tone) => { notice.show(text, tone) }
        const copy = (sessionId) => copySessionId({ sessionId, write: writeClipboard, notify, t })
        // The locate command is plugin-scope while the locate itself lives in the
        // mounted button, so the two meet through one seat.
        const seat = createLocateSeat()
        ctx.effect(() => ctx.shortcuts.register(locateCommand(seat, () => t('locate.label'), {
          unmounted: () => t('locate.unmounted'),
          noSession: () => t('locate.noSession'),
        })), 'flow: locate command')
        ctx.effect(() => ctx.shortcuts.register(copyCommand({
          label: () => t('copy.label'),
          enabled: () => readCopyEnabled(config),
          currentSessionId: () => currentSessionId(sessions.getSnapshot()),
          copy,
          notify,
          t,
        })), 'flow: copy command')

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
          seat,
          useLocaleRevision,
        }))), 'flow: locate button seat')

        // The Session row menu is the shell's own: a right-click on the row opens
        // it, so registering into its item list is what reaches both gestures.
        ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: ENTRY_ID,
          order: MENU_ORDER,
          locale: ENTRY_ID,
          inject: () => ({ config, write: writeClipboard, notify, useLocaleRevision }),
        }, CopySessionIdMenuItem)), 'flow: copy menu row')

        // The notice hangs off the overlay layer, not the row: the menu unmounts
        // the moment its action is taken.
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: ENTRY_ID,
          locale: ENTRY_ID,
          inject: () => ({ hooks: { notice }, dismiss: () => { notice.clear() } }),
        }, CopyNotice)), 'flow: copy notice')

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
        MENU_ORDER,
        LOCATE_COMMAND,
        LOCATE_DEFAULTS,
        COPY_COMMAND,
        COPY_DEFAULTS,
        createLocateSeat,
        locateCommand,
        currentSessionId,
        findSessionRow,
        owningGroupKey,
        revealSessionRow,
        locateCurrentSession,
        resolveListArea,
        resolveHeaderAnchors,
        attachLocateHost,
        readLocateEnabled,
        readCopyEnabled,
        copyCommand,
        copySessionId,
        createNoticeStore,
      },
    }
  },
})
