/**
 * dsh-flow — browser half.
 *
 * Five surfaces, one entry:
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
 *  - off-origin links — a document-level capture listener takes an
 *    `http`/`https`/`mailto`/`tel` click away from the shell while the
 *    preference is on, and posts the URL to the Host's `/flow/open-external`
 *    route so the OS default application opens it. That is the only path which
 *    also covers `http://localhost`, the address the Electron shell otherwise
 *    keeps in an in-app window; everything else — same-origin links, other
 *    schemes, a host that cannot answer — stays with the shell.
 *  - inline `code` in a conversation's markdown — a right-click opens a menu
 *    with 「打开」 and 「复制」. Only `contextmenu` is listened for, in the capture
 *    phase and only while the preference is on. 「打开」 dispatches one ordinary
 *    left-button `click` at the control the shell made clickable, so the choice
 *    between an in-app preview and the OS opener stays where it already lives.
 *    A plain left press is intercepted for exactly one purpose: the path is
 *    probed first, and a path that is definitely absent becomes a non-blocking
 *    notice instead of the shell's blocking "path open failed" dialog.
 *    A `~/…` code is the one shape the shell cannot open on its own — it
 *    resolves a relative path against the Workspace — so this plugin expands it
 *    against the Host account's home and opens it in the Sidebar itself.
 *  - the composer's send key — with the preference on, a plain Enter inserts a
 *    newline and ⌘/Ctrl+Enter sends, i.e. the shipped pair with its two halves
 *    swapped. The shipped composer decides Enter inside its own keymap (a plain
 *    Enter submits, `Shift+Enter` is the newline branch), so this plugin does not
 *    reimplement either: it takes the press away in the capture phase and hands
 *    the shell the *other* gesture as a synthetic keydown on the same element,
 *    which keeps the submit adjudication, the undo history and the IME
 *    bookkeeping exactly where they already are. A highlighted `/`-or-`@`
 *    candidate, an IME composition and an Alt chord are all left alone.
 *  - `settings.section` — the 心流 page, holding the five preferences that turn
 *    the button, the copy, the link hand-off, the inline-code menu and the
 *    swapped send key off. They live in this plugin's Host Config namespace
 *    (`flow.locateButton` / `flow.copySessionId` / `flow.externalLink` /
 *    `flow.codeMenu` / `flow.modEnterSend`), reached through `ctx.configForms`,
 *    so they are a durable part of the settings document rather than page-local
 *    state.
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
      Menu,
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

    /** Exact Host route that hands one URL to the platform opener. */
    const OPEN_ROUTE = '/flow/open-external'

    /** The schemes the OS opener is allowed to receive. */
    const OPENABLE = new Set(['http:', 'https:', 'mailto:', 'tel:'])

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
     * Read the external-link preference off the plugin's config form.
     *
     * The default is on: the feature is the reason this plugin owns the route at
     * all, and a click the host cannot answer falls back to the shell rather than
     * being swallowed, so an unreadable form cannot break links.
     *
     * @param form - `ctx.configForms.get('flow')`.
     * @returns whether off-origin links leave through the platform opener.
     */
    function readExternalLinkEnabled(form) {
      let value
      try {
        value = form.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value === null || typeof value !== 'object') return true
      return value.externalLink !== false
    }

    /**
     * The off-origin, openable URL behind a click, or null.
     *
     * Everything else — a click that is not inside a link, a scheme the opener
     * must not receive, and the application's own navigation — is not this
     * plugin's to take.
     *
     * @param event - the document click event.
     * @param base - `location.href`, what a relative `href` resolves against.
     * @param origin - `location.origin`, what counts as this application.
     * @returns the absolute href to open, or null when this click is not one.
     */
    function linkOf(event, base, origin) {
      const target = event?.target
      const anchor = target !== null && target !== undefined && typeof target.closest === 'function'
        ? target.closest('a[href]')
        : null
      if (anchor === null || anchor === undefined) return null
      let url
      try {
        url = new URL(anchor.href, base)
      } catch {
        return null
      }
      if (!OPENABLE.has(url.protocol)) return null
      if (url.origin === origin) return null
      return url.href
    }

    /**
     * Ask the host to hand one URL to the platform opener.
     *
     * @param url - the URL to open.
     * @param impl - the fetch to use, so the caller's page owns the transport.
     * @returns the host's answer; a non-2xx status is a refusal, not a success.
     */
    function openExternal(url, impl) {
      return Promise.resolve().then(() => impl(OPEN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      }))
    }

    /**
     * Capture-phase anchor handler.
     *
     * Off-origin links leave through the host; everything else — a click that is
     * not a link, a scheme the opener must not receive, the application's own
     * navigation, or a preference that is off — keeps the shell's behaviour
     * untouched. A host that refuses or cannot be reached falls back to the
     * page's own `window.open`, because a swallowed click is the one outcome a
     * link must not have.
     *
     * @param event - the document click event.
     * @param input.enabled - whether the preference still wants the feature.
     * @param input.base - `location.href`.
     * @param input.origin - `location.origin`.
     * @param input.fetch - the transport for the host route.
     * @param input.fallback - open the URL the page's own way.
     * @returns whether this click was taken.
     */
    function handleAnchorClick(event, input) {
      if (!input.enabled()) return false
      const url = linkOf(event, input.base, input.origin)
      if (url === null) return false
      event.preventDefault()
      event.stopPropagation()
      void openExternal(url, input.fetch).then(
        (response) => { if (response?.ok === false) input.fallback(url) },
        () => { input.fallback(url) },
      )
      return true
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
     * The inline `code` a context-menu press landed in, with the text to copy.
     *
     * Every exclusion here is a place where a `code` element means something
     * other than "a path or a snippet in the conversation": a fenced block
     * (`pre > code`) is multi-line and out of scope, the composer and the
     * shortcut editor are contenteditable, and an anchor already has an owner —
     * the capture-phase click listener that hands off-origin URLs to the Host.
     *
     * The positive half of the scope is the markdown body itself. The shipped
     * renderer wraps every message body in `div._markdown_<hash>`, and the
     * CSS-module local name is the part that survives a rebuild; this is the same
     * kind of dependency as `[class*="sectionHeader"]`, and it is why a `code`
     * in a tool card, a settings page or another plugin's own panel is left
     * alone. No attempt is made to name the surrounding conversation container:
     * those classes are content hashes.
     *
     * @param event - the document `contextmenu` event.
     * @returns `{element, text}`, or null when this press is not ours.
     */
    function codeMenuTarget(event) {
      const target = event?.target
      if (!isElement(target) || typeof target.closest !== 'function') return null
      const element = target.closest('code')
      if (!isElement(element) || typeof element.closest !== 'function') return null
      if (element.closest('pre') !== null) return null
      if (element.closest('[contenteditable]') !== null) return null
      if (element.closest('a[href]') !== null) return null
      if (element.closest('[class*="_markdown_"]') === null) return null
      // An empty `code` has nothing to offer either entry of the menu.
      const text = String(element.textContent ?? '').trim()
      if (text === '') return null
      return { element, text }
    }

    /**
     * The control the shell itself made clickable inside one inline `code`.
     *
     * The shipped renderer turns an inline code it resolved as a file mention
     * into `code > button._fileMention_*` and puts the open handler on that
     * button — the `<code>` carries no handler at all (measured in the running
     * instance: one sample conversation rendered 64 inline codes, 14 of them as
     * that button). A code the shell never resolved keeps no control, which is
     * exactly how a `~/…` path arrives: the mention vocabulary only holds paths
     * a tool produced or delivered, and those never leave the Workspace.
     *
     * @param element - the `<code>` element.
     * @returns the control, or null when the shell wired none.
     */
    function shellWiredControl(element) {
      if (typeof element?.querySelector !== 'function') return null
      const button = element.querySelector('button')
      return isElement(button) ? button : null
    }

    /**
     * The node one open dispatch has to be aimed at.
     *
     * A click dispatched at the `code` never reaches the shell's handler, which
     * lives on the button when there is one, so the button is preferred and the
     * element itself is the fallback.
     *
     * @param element - the `<code>` element.
     * @returns the button to activate, or the element itself.
     */
    function clickTargetOf(element) {
      if (typeof element?.querySelector !== 'function') return null
      return shellWiredControl(element) ?? element
    }

    /**
     * Run the shell's own activation for one inline `code`.
     *
     * This is the whole of "打开": one ordinary, bubbling, cancelable left-button
     * `click` dispatched at the control the shell wired up, so whatever the shell
     * does with a real click today — in-app preview, file manager, OS opener — is
     * exactly what happens here. Nothing is called directly.
     *
     * `dispatchEvent` answers whether the event was *not* cancelled, which a
     * handler that calls `preventDefault` turns into `false` on success; the
     * return value here is therefore "a click was dispatched", never "the shell
     * accepted it".
     *
     * @param element - the `<code>` element the press landed in.
     * @param view - the window whose `MouseEvent` constructor to use.
     * @returns whether a click was dispatched.
     */
    function activateInlineCode(element, view) {
      const target = clickTargetOf(element)
      if (target === null || typeof target.dispatchEvent !== 'function') return false
      const scope = view ?? element?.ownerDocument?.defaultView
      const Ctor = scope?.MouseEvent
      if (typeof Ctor !== 'function') return false
      target.dispatchEvent(new Ctor('click', { bubbles: true, cancelable: true, view: scope }))
      return true
    }

    /**
     * Copy one inline code and report the outcome.
     *
     * The same contract as copying a Session id: the clipboard is asked first and
     * the notice repeats its verdict, so a refused write reads as a refusal
     * instead of as a copy that appeared to work.
     *
     * @param input.text - the code's exact text.
     * @param input.write - the clipboard write, answering whether the host accepted it.
     * @param input.notify - raise a notice.
     * @param input.t - the plugin's localized copy.
     * @returns whether the clipboard accepted the write.
     */
    function copyInlineCode(input) {
      return Promise.resolve()
        .then(() => input.write(input.text))
        .then(
          (accepted) => {
            const copied = accepted === true
            input.notify(copied ? input.t('codeMenu.done') : input.t('codeMenu.failed'), copied ? 'success' : 'warning')
            return copied
          },
          () => {
            input.notify(input.t('codeMenu.failed'), 'warning')
            return false
          },
        )
    }

    /**
     * Capture-phase `contextmenu` handler.
     *
     * Taking the press away from the shell is only done when the menu is really
     * about to open; anything else — another element, a fenced block, a
     * contenteditable — is passed through untouched, so the shell's own row menus
     * and native menus still work.
     *
     * @param event - the document `contextmenu` event.
     * @param input.open - place the menu: `({x, y, text, element}) => void`.
     * @returns whether this press was claimed.
     */
    function handleCodeContextMenu(event, input) {
      const hit = codeMenuTarget(event)
      if (hit === null) return false
      event.preventDefault()
      event.stopPropagation()
      input.open({ x: event.clientX, y: event.clientY, text: hit.text, element: hit.element })
      return true
    }

    /** Whether this press is a plain left click — the only gesture this feature may take. */
    function isPlainLeftPress(event) {
      if (event === null || typeof event !== "object") return false
      if (event.button !== undefined && event.button !== 0) return false
      if (event.metaKey === true || event.ctrlKey === true) return false
      if (event.shiftKey === true || event.altKey === true) return false
      return true
    }

    /**
     * Whether one inline code names a path under the current user's home.
     *
     * Only the bare and current-user spellings the shell itself understands are
     * claimed: `~/…` and `~\…`. A bare `~` names a directory, and a
     * named-user form such as `~alice/…` is not this account's home, so both
     * stay with the shell.
     *
     * @param text - the code's exact text.
     * @returns whether this is a current-user home path.
     */
    function isTildePath(text) {
      if (typeof text !== 'string') return false
      if (text.startsWith('~/')) return true
      return text.startsWith('~\\')
    }

    /**
     * Expand one `~/…` code against the Host account's home.
     *
     * The home comes from the connection's host facts; a home that is not known
     * (no generation yet, or a deployment that never sent one) answers null,
     * which is what leaves the press to the shell instead of guessing.
     *
     * @param text - the code's exact text.
     * @param home - the Host account's home, when known.
     * @returns the absolute path, or null when this is not one to expand.
     */
    function expandHomePath(text, home) {
      if (!isTildePath(text)) return null
      if (typeof home !== 'string' || home === '') return null
      const root = home.replace(/[\\/]+$/, '')
      if (root === '') return null
      return root + '/' + text.slice(2)
    }

    /**
     * The `dsh-resource://file/…` address the Sidebar previews one absolute
     * path through.
     *
     * This is the grammar `sessionFileAddress` spells on the Host side; a browser
     * bundle cannot import that library, so the one shape needed here is kept
     * inline — each segment component-encoded with `:` left literal and the
     * leading `/` preserved, so the Host resolves an absolute path.
     *
     * @param sessionId - the Session that authorizes the read.
     * @param absolutePath - the absolute path to address.
     * @returns the address, or null when it cannot be built.
     */
    function fileAddress(sessionId, absolutePath) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      if (typeof absolutePath !== 'string' || absolutePath === '') return null
      const encode = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
      const path = absolutePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return 'dsh-resource://file/session/' + encode(sessionId) + '/' + path.split('/').map(encode).join('/')
    }

    /**
     * The inline `code` a plain left press is about to open.
     *
     * The same scope as the menu (`codeMenuTarget`), narrowed to the two shapes
     * this plugin can open: a `code` the shipped renderer wired a control into,
     * and a `~/…` code, which the shell's mention vocabulary never holds because
     * it only names paths a tool produced or delivered. An inert `code` — plain
     * prose — keeps today's behaviour and costs no round trip at all.
     *
     * @param event - the document `click` event.
     * @returns `{element, text}`, or null when this press is not ours to consider.
     */
    function codeOpenTarget(event) {
      if (!isPlainLeftPress(event)) return null
      // A press the page dispatched itself — this plugin's own re-dispatch, or
      // the menu's 「打开」 — is already an explicit instruction. Claiming it
      // again would claim the re-dispatch too, and that loop never ends.
      if (event.isTrusted === false) return null
      const hit = codeMenuTarget(event)
      if (hit === null) return null
      if (isTildePath(hit.text)) return hit
      if (typeof hit.element.querySelector !== "function") return null
      if (shellWiredControl(hit.element) === null) return null
      return hit
    }

    /**
     * Read one answer from the workspace-files probe.
     *
     * The remote answers a Result envelope, so a path that is not there arrives as
     * `{ok: false, error}` rather than as a rejection. Only a failure that *says*
     * the path is absent counts as missing; every other answer — including a host
     * that is away — stays unknown and is handed back to the shell, because this
     * feature must never hide a path that exists.
     *
     * @param result - whatever the probe answered.
     * @returns `present`, `missing`, or `unknown`.
     */
    function statVerdict(result) {
      if (result !== null && typeof result === "object" && result.ok === true) return "present"
      const error = result !== null && typeof result === "object" ? result.error : null
      const code = String(error?.code ?? "")
      const message = String(error?.message ?? "")
      if (/not[-_ ]?found|enoent|no such file/i.test(code + " " + message)) return "missing"
      return "unknown"
    }

    /**
     * What one openable inline `code` would do, decided without a round trip.
     *
     * A code with a shell control goes back to the shell: whatever the renderer
     * resolved there (a produced file, a delivery) is what the user means, and
     * the shell already resolves it. A `~/…` code has no such owner, so this
     * plugin expands it against the Host home and opens the result itself. A home
     * that is not known answers null, which is how the press stays the shell's
     * instead of being claimed.
     *
     * @param hit - `{element, text}` from `codeMenuTarget`.
     * @param home - the Host home, or a getter for it.
     * @returns `{kind, probe}`, or null when there is nothing to open.
     */
    function inlineCodePlan(hit, home) {
      if (shellWiredControl(hit.element) !== null) return { kind: 'shell', probe: hit.text }
      if (!isTildePath(hit.text)) return null
      const absolute = expandHomePath(hit.text, typeof home === 'function' ? home() : home)
      if (absolute === null) return null
      return { kind: 'home', probe: absolute }
    }

    /**
     * Open one planned inline `code`, probing first.
     *
     * Order matters and is the whole design: the probe is a Host round trip, so
     * the press is claimed while the event is still dispatching and the decision
     * arrives later. A path the probe definitely calls absent becomes a notice;
     * a home path the probe cannot answer opens nothing at all — never a path
     * this plugin cannot prove.
     *
     * @param hit - `{element, text}` from `codeMenuTarget`.
     * @param plan - the verdict from `inlineCodePlan`.
     * @param input.stat - `(path) => Promise<probe result>`, on the planned path.
     * @param input.open - re-dispatch the shell activation for one element.
     * @param input.openHome - open one absolute path in the Sidebar.
     * @param input.notify - raise a notice.
     * @param input.t - the plugin's localized copy.
     * @returns `missing` (noticed), `open` (opened), or `unknown` (left alone).
     */
    function openInlineCodeHit(hit, plan, input) {
      return Promise.resolve()
        .then(() => input.stat(plan.probe))
        .then((result) => statVerdict(result), () => "unknown")
        .then((verdict) => {
          if (verdict === "missing") {
            input.notify(input.t("linkMissing.notice") + " " + hit.text, "warning")
            return "missing"
          }
          if (plan.kind === "shell") {
            input.open(hit.element)
            return "open"
          }
          if (verdict !== "present") return "unknown"
          return input.openHome(plan.probe) ? "open" : "unknown"
        })
    }

    /**
     * Handle one left press that landed on inline code.
     *
     * The plan is decided synchronously, so a press with nothing to open is never
     * claimed; once claimed, the probe's verdict decides between the shell's own
     * activation, this plugin's home open, and the notice.
     *
     * @param event - the document `click` event.
     * @param input - `openInlineCodeHit`'s inputs plus `home` for the plan.
     * @returns `pass` (not ours), `missing`, `open`, or `unknown`.
     */
    function handleInlineCodeClick(event, input) {
      const hit = codeOpenTarget(event)
      if (hit === null) return Promise.resolve("pass")
      const plan = inlineCodePlan(hit, input.home)
      if (plan === null) return Promise.resolve("pass")
      event.preventDefault()
      event.stopPropagation()
      return openInlineCodeHit(hit, plan, input)
    }

    /**
     * Whether one press landed in the shipped composer.
     *
     * @param target - the event target.
     * @returns whether the target sits inside `[data-composer-input]`.
     */
    function isComposerTarget(target) {
      if (!isElement(target) || typeof target.closest !== 'function') return false
      return target.closest(COMPOSER_INPUT) !== null
    }

    /**
     * Decide what one Enter press in the composer has to become.
     *
     * The shipped composer treats a plain Enter as "submit" and Shift+Enter as
     * "newline"; the two are separate branches of its own keymap, which is why
     * this plugin does not have to know anything about Lexical: it only has to
     * hand the shell the *other* gesture, with the same modifiers the shell
     * already understands.
     *
     * @param input - the press and the context it happened in.
     * @returns `{shiftKey, primary}` for the gesture to replay, or null to leave the press alone.
     */
    function composerEnterRewrite(input) {
      if (input === null || typeof input !== 'object') return null
      if (input.enabled !== true) return null
      if (input.key !== 'Enter') return null
      // An IME's Enter belongs to the IME, and an Alt chord belongs to whatever
      // the shell already made of it (a dead key on macOS, for one).
      if (input.composing === true) return null
      if (input.altKey === true) return null
      if (input.inComposer !== true) return null
      // A highlighted trigger candidate is picked with Enter; that press is the
      // menu's, not this plugin's.
      if (input.menuOwnsEnter === true) return null
      const primary = input.metaKey === true || input.ctrlKey === true
      if (!primary) return { shiftKey: true, primary: false }
      // The complementary chord keeps its primary modifier once Shift is gone,
      // so the busy Queue/Steer pair still has both halves after the swap.
      return { shiftKey: false, primary: input.shiftKey === true }
    }

    /**
     * Hand one gesture back to the shell.
     *
     * The press is dispatched at the element the user actually typed into, and
     * it bubbles: the composer's own keymap listens on that editor, so the
     * replay takes exactly the path the real key would have taken — the same
     * submit adjudication, the same undo history, the same IME bookkeeping.
     *
     * @param event - the press being replaced.
     * @param plan - the gesture `composerEnterRewrite` decided on.
     * @param KeyboardEvent - the constructor to mint it with.
     * @returns whether a gesture could be dispatched.
     */
    function replayComposerEnter(event, plan, KeyboardEvent) {
      const target = event?.target
      if (typeof KeyboardEvent !== 'function') return false
      if (!isElement(target) || typeof target.dispatchEvent !== 'function') return false
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: plan.shiftKey === true,
        ctrlKey: plan.primary === true && event.ctrlKey === true,
        metaKey: plan.primary === true && event.metaKey === true,
        altKey: false,
        repeat: false,
      }))
      return true
    }

    /**
     * The swapped send key: one capture-phase listener's worth of behavior.
     *
     * The DOM is kept at arm's length — the decision, the replay and the
     * re-entrancy guard are all driven through `input`, so the whole thing is
     * asserted without a browser.
     *
     * @param input.enabled - reads the live preference.
     * @param input.inComposer - `(event) => boolean`: the press landed in the composer.
     * @param input.menuOwnsEnter - `() => boolean`: the trigger menu has a highlighted candidate.
     * @param input.replay - dispatches the decided gesture; defaults to `replayComposerEnter`.
     * @param input.KeyboardEvent - the constructor the default replay mints with.
     * @returns the seat the document listener drives.
     */
    function createComposerSendKey(input) {
      const replay = input.replay ?? ((event, plan) => replayComposerEnter(event, plan, input.KeyboardEvent ?? globalThis.KeyboardEvent))
      // The gesture this seat dispatches comes back through the same
      // capture-phase listener; without this flag it would be rewritten again.
      let replaying = false
      return {
        /**
         * Rewrite one press, or let it through.
         *
         * @param event - the document `keydown` event.
         * @returns whether this press was taken away from the shell.
         */
        handle(event) {
          if (replaying) return false
          const plan = composerEnterRewrite({
            enabled: input.enabled() === true,
            key: event?.key,
            composing: event?.isComposing === true || event?.keyCode === 229,
            altKey: event?.altKey === true,
            metaKey: event?.metaKey === true,
            ctrlKey: event?.ctrlKey === true,
            shiftKey: event?.shiftKey === true,
            inComposer: input.inComposer(event) === true,
            menuOwnsEnter: input.menuOwnsEnter() === true,
          })
          if (plan === null) return false
          event.preventDefault()
          event.stopImmediatePropagation()
          replaying = true
          try {
            replay(event, plan)
          } finally {
            replaying = false
          }
          return true
        },
      }
    }

    /**
     * The one-slot seat the inline-code menu renders from.
     *
     * A press that lands on another `code` while the menu is open replaces the
     * snapshot, and every open mints a new object carrying a new sequence: React
     * compares snapshots by identity, so re-opening a menu at the very same
     * coordinates still re-renders and re-places it.
     *
     * @returns the store the capture listener writes and the overlay entry reads.
     */
    function createCodeMenuStore() {
      let snapshot = null
      let seq = 0
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        /** @returns the menu on screen, or null. */
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
         * Show one menu at one press point.
         * @param input.x - viewport x of the press.
         * @param input.y - viewport y of the press.
         * @param input.text - the code's exact text.
         * @param input.element - the `<code>` element the press landed in.
         */
        open: (input) => {
          seq += 1
          snapshot = { seq, x: input.x, y: input.y, text: input.text, element: input.element }
          emit()
        },
        /** Retire the menu on screen; an empty seat is not a change. */
        close: () => {
          if (snapshot === null) return
          snapshot = null
          emit()
        },
      }
    }

    /**
     * The zero-size box the menu hangs from: the press point.
     *
     * `Menu` places a portaled list from a DOMRect-shaped box, so the cursor is
     * expressed as the box it would have measured had it been a control. The list
     * then opens just below and right of the pointer and is clamped inside the
     * viewport by the shipped placement code.
     *
     * @param x - viewport x.
     * @param y - viewport y.
     * @returns the rect.
     */
    function cursorRect(x, y) {
      return { x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 }
    }

    /**
     * Read the inline-code menu preference off the plugin's config form.
     *
     * The default is on, and an unreadable form keeps that default: a Host that
     * does not project the field yet must not silently take the feature away.
     *
     * @param form - `ctx.configForms.get('flow')`.
     * @returns whether a right-click on inline code opens the menu.
     */
    function readCodeMenuEnabled(form) {
      let value
      try {
        value = form.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value === null || typeof value !== 'object') return true
      return value.codeMenu !== false
    }

    /**
     * Read the send-key preference off the plugin's config form.
     *
     * The default is off, and an unreadable form keeps that default: the shipped
     * Enter-sends pair is what someone who never touched this setting expects,
     * so a Host that does not project the field yet must not swap it.
     *
     * @param form - `ctx.configForms.get('flow')`.
     * @returns whether Cmd/Ctrl+Enter sends and Enter breaks the line.
     */
    function readModEnterSend(form) {
      let value
      try {
        value = form.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value === null || typeof value !== 'object') return false
      return value.modEnterSend === true
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
     * Cell key of the inline-code menu's own entry in `shell.overlay`.
     *
     * `shell.overlay` is a list slot and its `id` is the cell key: a fresh id is
     * added beside the entries already in the slot, while reusing one puts this
     * plugin into that entry's cell and replaces what it renders. The copy
     * notice already owns the `flow` cell, so the menu takes a second one instead
     * of sharing it — two surfaces, two lifespans.
     */
    const CODE_MENU_ID = 'flow.code-menu'

    /**
     * The shipped composer's editable root, which is the only place a swapped
     * Enter belongs.
     *
     * Measured in the running instance: the composer is one
     * `div[data-composer-input]` (contenteditable, carrying Lexical's
     * `__lexicalEditor`), and it is the element the shell's keydown reaches.
     * Every other Enter in the application — the Queue dock's editor input, the
     * settings search box — lives outside it and is left untouched.
     */
    const COMPOSER_INPUT = '[data-composer-input]'

    /**
     * The `/` and `@` menu, while one of its candidates is highlighted.
     *
     * Enter is how that menu picks: the composer asks the trigger pipeline to
     * arbitrate first, and the pipeline answers `pass` unless a candidate is
     * highlighted. Rewriting the press while a highlight is up would take the
     * pick away, so this plugin steps aside exactly then.
     */
    const TRIGGER_MENU_PICK = '[data-trigger-menu] [role="listbox"][aria-activedescendant]'

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
.flow-code-menu-anchor{display:none}
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
      'codeMenu.open': '打开',
      'codeMenu.copy': '复制',
      'codeMenu.done': '已复制行内代码',
      'codeMenu.failed': '复制失败，剪贴板不可用',
      'linkMissing.notice': '找不到这个路径',
      'section.title': '心流',
      'section.locate.title': '定位当前会话按钮',
      'section.locate.description': '在工作区标题行、搜索按钮右侧显示「定位当前会话」按钮：点击后展开并滚动到当前打开的会话。',
      'section.copy.title': '复制会话 ID',
      'section.copy.description': '在会话行的右键菜单里加上「复制会话 ID」，并用 `⇧⌘C`（Windows/Linux 为 Ctrl+Shift+C）复制当前会话的 ID。快捷键可在 设置 → 通用 → 快捷键 里改。',
      'section.external.title': '在系统默认程序中打开链接',
      'section.external.description': '点击非本站的 http、https、mailto、tel 链接时，交给操作系统的默认应用打开（macOS 用 open、Windows 用 start、Linux 用 xdg-open），包括本来会开在内置窗口里的 localhost 地址。关闭后恢复壳自身的打开方式。',
      'section.codeMenu.title': '行内代码右键菜单',
      'section.codeMenu.description': '在对话正文的行内代码上点右键，弹出「打开 / 复制」菜单：复制把代码原文写进剪贴板；打开对 ~/… 家目录路径会先展开、再由插件在侧栏打开（壳自己解析不了），其余仍走壳自己的链路。单击一条指向不存在路径的行内代码会换成一条非阻塞提示；关闭后右键与这条接管都不注册。',
      'section.sendKey.title': '⌘+Enter 发送',
      'section.sendKey.description': '打开后：⌘+Enter（Windows/Linux 为 Ctrl+Enter）发送，Enter 换行，⇧+Enter 仍是换行；⇧⌘+Enter 保留官方的另一种发送方式。关闭后回到官方行为——Enter 发送，⌘+Enter 走另一种发送方式。',
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
      'codeMenu.open': 'Open',
      'codeMenu.copy': 'Copy',
      'codeMenu.done': 'Inline code copied',
      'codeMenu.failed': 'Copy failed: the clipboard rejected the write',
      'linkMissing.notice': 'No such path',
      'section.title': 'Flow',
      'section.locate.title': 'Locate current Session button',
      'section.locate.description': 'Show a “Locate current Session” button in the workspace header, beside the search control; clicking it expands and scrolls to the open Session.',
      'section.copy.title': 'Copy Session ID',
      'section.copy.description': 'Add “Copy Session ID” to a Session row’s right-click menu, and bind `⇧⌘C` (Ctrl+Shift+C on Windows/Linux) to copying the open Session’s ID. Rebind it under Settings → General → Shortcuts.',
      'section.external.title': 'Open links in the system default app',
      'section.external.description': 'Off-origin http, https, mailto and tel links open in the operating system’s default application (open on macOS, start on Windows, xdg-open on Linux), including the localhost addresses that would otherwise open in an in-app window. Switching this off restores the shell’s own behaviour.',
      'section.codeMenu.title': 'Inline code right-click menu',
      'section.codeMenu.description': 'Right-clicking inline code in a conversation opens an “Open / Copy” menu: Copy puts the code’s text on the clipboard, and Open expands a ~/… home path and opens it in the Sidebar itself — the shell cannot resolve that one; everything else keeps the shell’s own path. Left-clicking code whose path does not exist becomes a non-blocking notice instead; switching this off registers neither.',
      'section.sendKey.title': '⌘+Enter to send',
      'section.sendKey.description': 'On: ⌘+Enter (Ctrl+Enter on Windows/Linux) sends, Enter starts a new line, ⇧+Enter still breaks the line, and ⇧⌘+Enter keeps the shell’s complementary delivery. Off: the shell’s own pair — Enter sends and ⌘+Enter uses the complementary delivery.',
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
     * Observe the inline-code menu's one slot.
     *
     * @param store - `createCodeMenuStore()`.
     * @returns the menu on screen, or null.
     */
    function useCodeMenuSnapshot(store) {
      const subscribe = useCallback((listener) => store.subscribe(listener), [store])
      const snapshot = useCallback(() => store.getSnapshot(), [store])
      return useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    /**
     * The inline-code menu itself: 「打开」 and 「复制」, floating at the press.
     *
     * It is the shell's own `Menu` rather than a surface built here, so the
     * keyboard walk (↑↓/Home/End, Enter), Escape, and dismissal on an outside
     * pointerdown are the shipped ones. `Menu` owns exactly those behaviours;
     * `MenuSurface` is only the card it paints, with no keys of its own, so using
     * the surface directly would mean writing the keyboard handling this feature
     * deliberately does not own.
     *
     * The list is portaled under `document.body` and placed from `getAnchorRect`,
     * because the overlay slot cannot be measured at a pointer: the rect handed
     * back is the zero-size box at the press point (:func:`cursorRect`).
     * `autoFocus` puts the keyboard on the first row, which is what makes the
     * arrow keys work from a right-click that had no focused trigger.
     *
     * @param props - the seat, the config form, the clipboard writer, and the localized copy.
     */
    function CodeMenu(props) {
      const { store, config, t } = props
      // Every Hook runs before the preference is consulted, so the entry keeps
      // one call order across a toggle.
      const enabled = useConfigValue(config, readCodeMenuEnabled)
      const menu = useCodeMenuSnapshot(store)
      props.useLocaleRevision()
      const anchorRect = useCallback(
        () => cursorRect(menu?.x ?? 0, menu?.y ?? 0),
        [menu?.x, menu?.y],
      )

      if (!enabled || menu === null) return null

      return h(
        Menu,
        {
          open: true,
          portal: true,
          autoFocus: true,
          anchor: h('span', { className: 'flow-code-menu-anchor' }),
          getAnchorRect: anchorRect,
          onClose: () => { store.close() },
        },
        h(
          MenuItemButton,
          {
            key: 'open',
            onSelect: () => {
              // Closing first keeps the menu's own dismissal out of the way of
              // whatever this is about to open.
              const { element, text } = menu
              store.close()
              props.openCode({ element, text })
            },
          },
          t('codeMenu.open'),
        ),
        h(
          MenuItemButton,
          {
            key: 'copy',
            onSelect: () => {
              const { text } = menu
              store.close()
              copyInlineCode({ text, write: props.write, notify: props.notify, t })
            },
          },
          t('codeMenu.copy'),
        ),
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
     * The 心流 settings page: the five preferences this plugin owns.
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
        h(SettingsRow, {
          config,
          field: 'externalLink',
          read: readExternalLinkEnabled,
          title: t('section.external.title'),
          description: t('section.external.description'),
          error: t('section.saveError'),
          useLocaleRevision: props.useLocaleRevision,
        }),
        h(SettingsRow, {
          config,
          field: 'codeMenu',
          read: readCodeMenuEnabled,
          title: t('section.codeMenu.title'),
          description: t('section.codeMenu.description'),
          error: t('section.saveError'),
          useLocaleRevision: props.useLocaleRevision,
        }),
        h(SettingsRow, {
          config,
          field: 'modEnterSend',
          read: readModEnterSend,
          title: t('section.sendKey.title'),
          description: t('section.sendKey.description'),
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
        // One capture-phase listener for the whole page: it has to run before the
        // shell's own handlers to take a link away from them, and it reads the
        // preference per click rather than per registration, so the settings
        // switch takes effect without re-binding anything.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const onClick = (event) => {
            handleAnchorClick(event, {
              enabled: () => readExternalLinkEnabled(config),
              base: location.href,
              origin: location.origin,
              fetch: (route, init) => fetch(route, init),
              fallback: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
            })
          }
          document.addEventListener('click', onClick, true)
          return () => { document.removeEventListener('click', onClick, true) }
        }, 'flow: external links')
        // The existence probe behind the left-press takeover. It is asked about
        // the planned path — the raw text for a shell-owned mention, the expanded
        // absolute path for a `~/…` code. The shell's own workspace-files remote
        // answers a Result envelope, so "not there" is a value rather than an
        // exception; a probe that cannot answer inside the deadline is treated as
        // unknown, which never hides a path that may well exist.
        const LINK_STAT_DEADLINE_MS = 2000
        // The Host account's home, as the connection's host facts publish it. A
        // generation that has not arrived, or a deployment that never sent one,
        // answers null; a `~/…` press then stays with the shell rather than
        // guessing.
        const hostHome = () => {
          try {
            const home = ctx.remote?.$host?.home
            return typeof home === 'string' && home !== '' ? home : null
          } catch {
            return null
          }
        }
        // The plugin's own open for a path the shell cannot resolve: one
        // `dsh-resource://file/…` address handed to the Sidebar controller. Every
        // step may be missing — no Session, no controller, a controller that
        // refuses — and the answer is always "nothing was opened", never a throw.
        const openAtHome = (absolute) => {
          const sessionId = currentSessionId(sessions.getSnapshot())
          if (sessionId === null) return false
          const address = fileAddress(sessionId, absolute)
          if (address === null) return false
          let sidebarRight
          try {
            sidebarRight = ctx.sidebarRight
          } catch {
            return false
          }
          if (typeof sidebarRight?.openResource !== 'function') return false
          try {
            sidebarRight.openResource(address)
          } catch {
            return false
          }
          return true
        }
        const readInlineCodeStat = (path) => {
          const sessionId = currentSessionId(sessions.getSnapshot())
          const stat = ctx.remote?.workspaceFiles?.stat
          if (sessionId === null || typeof stat !== 'function') return Promise.resolve(null)
          let timer = null
          const deadline = new Promise((resolve) => {
            timer = setTimeout(() => { resolve(null) }, LINK_STAT_DEADLINE_MS)
          })
          const probe = Promise.resolve()
            .then(() => stat.call(ctx.remote.workspaceFiles, sessionId, path))
            .then((result) => result, () => null)
          return Promise.race([probe, deadline]).then((result) => {
            if (timer !== null) clearTimeout(timer)
            return result
          })
        }
        // The inline-code menu: one capture-phase listener for the whole page,
        // and only while the preference is on. An off feature adds no listener
        // at all rather than a listener that decides to do nothing, and the
        // form's own subscription is what makes a toggle take effect without
        // anything being re-registered by hand.
        const codeMenu = createCodeMenuStore()
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          let detach = null
          const sync = () => {
            if (!readCodeMenuEnabled(config)) {
              // Turning the feature off also retires a menu it left open.
              codeMenu.close()
              detach?.()
              detach = null
              return
            }
            if (detach !== null) return
            const onContextMenu = (event) => {
              handleCodeContextMenu(event, { open: (hit) => { codeMenu.open(hit) } })
            }
            // A left press on a file mention is claimed here, probed, and handed
            // back to the shell when the path exists — see
            // :func:`handleInlineCodeClick` for why the order is this way.
            const onClick = (event) => {
              handleInlineCodeClick(event, {
                stat: (path) => readInlineCodeStat(path),
                home: hostHome,
                open: (element) => {
                  activateInlineCode(element, element?.ownerDocument?.defaultView)
                },
                openHome: openAtHome,
                notify,
                t,
              })
            }
            document.addEventListener('contextmenu', onContextMenu, true)
            document.addEventListener('click', onClick, true)
            detach = () => {
              document.removeEventListener('contextmenu', onContextMenu, true)
              document.removeEventListener('click', onClick, true)
            }
          }
          sync()
          const unsubscribe = config.subscribe(sync)
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
            detach?.()
          }
        }, 'flow: inline code menu')
        // The swapped send key: the same shape as the code-menu listener — one
        // capture-phase listener for the whole page, present only while the
        // preference is on — but it has to run before the *editor's* own
        // handler rather than the shell's, because Enter is adjudicated there.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const sendKey = createComposerSendKey({
            enabled: () => readModEnterSend(config),
            inComposer: (event) => isComposerTarget(event?.target),
            menuOwnsEnter: () => document.querySelector(TRIGGER_MENU_PICK) !== null,
          })
          let detach = null
          const sync = () => {
            if (!readModEnterSend(config)) {
              detach?.()
              detach = null
              return
            }
            if (detach !== null) return
            const onKeyDown = (event) => { sendKey.handle(event) }
            document.addEventListener('keydown', onKeyDown, true)
            detach = () => { document.removeEventListener('keydown', onKeyDown, true) }
          }
          sync()
          const unsubscribe = config.subscribe(sync)
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
            detach?.()
          }
        }, 'flow: swapped send key')
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

        // The inline-code menu is a second cell in the same list slot: the
        // shipped contract adds a fresh id beside the existing entries, and the
        // `flow` cell already carries the copy notice.
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: CODE_MENU_ID,
          locale: ENTRY_ID,
          inject: () => ({
            store: codeMenu,
            config,
            write: writeClipboard,
            notify,
            useLocaleRevision,
            // A control the shell wired keeps its own activation untouched. Only
            // a `~/…` code has no owner, and that one goes through the same probe
            // and home open the left press uses.
            openCode: (hit) => {
              const plan = inlineCodePlan(hit, hostHome)
              if (plan === null || plan.kind === 'shell') {
                activateInlineCode(hit.element, window)
                return
              }
              openInlineCodeHit(hit, plan, {
                stat: (path) => readInlineCodeStat(path),
                openHome: openAtHome,
                notify,
                t,
              })
            },
          }),
        }, CodeMenu)), 'flow: inline code menu overlay')

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
        OPEN_ROUTE,
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
        readExternalLinkEnabled,
        linkOf,
        openExternal,
        handleAnchorClick,
        copyCommand,
        copySessionId,
        createNoticeStore,
        CODE_MENU_ID,
        codeMenuTarget,
        clickTargetOf,
        activateInlineCode,
        copyInlineCode,
        handleCodeContextMenu,
        createCodeMenuStore,
        cursorRect,
        readCodeMenuEnabled,
        isPlainLeftPress,
        codeOpenTarget,
        shellWiredControl,
        isTildePath,
        expandHomePath,
        fileAddress,
        inlineCodePlan,
        openInlineCodeHit,
        statVerdict,
        handleInlineCodeClick,
        COMPOSER_INPUT,
        TRIGGER_MENU_PICK,
        isComposerTarget,
        composerEnterRewrite,
        replayComposerEnter,
        createComposerSendKey,
        readModEnterSend,
      },
    }
  },
})
