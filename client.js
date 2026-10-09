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

    /** Host route that lists the applications this Host has actually installed. */
    const APPS_ROUTE = '/flow/apps'

    /** Host route that opens one existing absolute path in a chosen application. */
    const OPEN_WITH_ROUTE = '/flow/open-with'

    /** GET prefix serving one PNG bundle icon per catalog id. */
    const OPEN_IN_APP_ICON_ROUTE = '/open-in-app/icon'

    /**
     * Catalog ids whose label this plugin carries.
     *
     * The names are the shipped Open In dictionary verbatim; an id that is not
     * here (a newer catalog entry) shows its raw id instead of a broken label.
     */
    const APP_LABEL_IDS = new Set([
      'cursor', 'vscode', 'vscodeinsiders', 'windsurf', 'zed', 'sublimetext', 'xcode', 'androidstudio',
      'intellij', 'pycharm', 'webstorm', 'phpstorm', 'goland', 'rider', 'rustrover',
      'fork', 'sourcetree', 'github', 'tower', 'gitkraken', 'smartgit', 'sublimemerge',
      'ghostty', 'warp', 'iterm', 'kitty', 'windowsterminal', 'gitbash', 'gnometerminal', 'konsole',
      'finder', 'explorer', 'filemanager', 'terminal',
    ])

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
     * This is the one recognition point for "this click is a link". The shell
     * reaches it through two shapes today, and a future shape is patched here
     * rather than at each caller:
     *
     *   - an anchor the shell rendered (`a[href]`) — markdown links and the
     *     inline code it resolved as a URL;
     *   - a URL that stayed **plain text** — the user's own message and other
     *     plain runs never get an anchor, so a press on the URL itself is the
     *     only way to open it (`textLinkOf`).
     *
     * Everything else — a click that is not on a link, a scheme the opener must
     * not receive, and the application's own navigation — is not this plugin's
     * to take.
     *
     * @param event - the document click event.
     * @param base - `location.href`, what a relative `href` resolves against.
     * @param origin - `location.origin`, what counts as this application.
     * @returns the absolute href to open, or null when this click is not one.
     */
    function linkOf(event, base, origin) {
      return anchorLinkOf(event, base, origin) ?? textLinkOf(event, base, origin)
    }

    /**
     * The URL an anchor really names when the shell's linkifier over-captured it.
     *
     * GFM's autolink literal runs to the next whitespace, so a bare URL glued to
     * CJK takes the sentence tail with it: the shipped renderer turns
     * `http://localhost:6006/，来自 worktree）` into one anchor whose href is the
     * URL **plus** the percent-encoded `，来自`, and the link then points at a URL
     * nobody wrote. This is the one recognition patch for that shape.
     *
     * It only fires when the anchor is exactly its own text — a deliberate
     * markdown link whose text is another URL, or whose href differs from its
     * text, is left alone — and when the URL token is only a prefix of that text,
     * so `linkTokensIn` (the same tokenizer the click and the paint already use)
     * says where the real URL ends.
     *
     * @param anchor - the `<a href>` element.
     * @returns `{url, tailStart, tailEnd}`, or null when the anchor is exact.
     */
    function overcapturedAnchor(anchor) {
      if (!isElement(anchor) || typeof anchor.textContent !== 'string') return null
      const text = anchor.textContent
      const first = linkTokensIn(text)[0]
      if (first === undefined || first.start !== 0) return null
      if (first.end >= text.length) return null
      let href
      try {
        href = String(anchor.getAttribute('href') ?? '')
      } catch {
        return null
      }
      let decoded = href
      try {
        decoded = decodeURIComponent(href)
      } catch {
        decoded = href
      }
      if (decoded !== text) return null
      return { url: first.token, tailStart: first.end, tailEnd: text.length }
    }

    /**
     * The off-origin URL behind a click on a rendered anchor, or null.
     *
     * An anchor the shell over-captured is handed the URL `overcapturedAnchor`
     * recovered rather than the one the attribute spells.
     *
     * @param event - the document click event.
     * @param base - `location.href`.
     * @param origin - `location.origin`.
     * @returns the absolute href to open, or null.
     */
    function anchorLinkOf(event, base, origin) {
      const target = event?.target
      const anchor = target !== null && target !== undefined && typeof target.closest === 'function'
        ? target.closest('a[href]')
        : null
      if (anchor === null || anchor === undefined) return null
      const overcaptured = overcapturedAnchor(anchor)
      let url
      try {
        url = new URL(overcaptured === null ? anchor.href : overcaptured.url, base)
      } catch {
        return null
      }
      if (!OPENABLE.has(url.protocol)) return null
      if (url.origin === origin) return null
      return url.href
    }

    /**
     * Every URL token one plain-text run carries, with its offsets.
     *
     * A plain `https?://\S+` search cannot be used: the user's sentence puts a
     * full-width comma right after the URL, and `\S+` would swallow it along
     * with every following CJK character. Only ASCII URL characters are accepted
     * after the scheme, so a token ends exactly where the shell's own linkifier
     * would end it, and trailing ASCII sentence punctuation is trimmed.
     *
     * This is the one tokenizer behind both the click recognition and the visual
     * link highlight, so what looks like a link and what opens are the same set.
     *
     * @param text - the text node's data.
     * @returns `[{token, start, end}]`, in document order.
     */
    function linkTokensIn(text) {
      if (typeof text !== 'string' || text === '') return []
      const tokens = []
      const pattern = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&()*+,;=%]+/g
      let match
      while ((match = pattern.exec(text)) !== null) {
        const token = match[0].replace(/[.,;:!?)\]}>'"]+$/u, '')
        if (token === '') continue
        tokens.push({ token, start: match.index, end: match.index + token.length })
      }
      return tokens
    }

    /**
     * The URL token a plain-text run carries at one caret offset, or null.
     *
     * A click has to fall **inside** a token — a press on the words around it is
     * not that link's to take.
     *
     * @param text - the text node's data.
     * @param offset - the caret offset the click landed on.
     * @returns the URL text, or null.
     */
    function linkTokenAt(text, offset) {
      if (typeof offset !== 'number' || !Number.isFinite(offset)) return null
      for (const hit of linkTokensIn(text)) {
        if (offset >= hit.start && offset <= hit.end) return hit.token
      }
      return null
    }

    /**
     * The text node and offset under one viewport point, or null.
     *
     * Chromium and WebKit answer `caretRangeFromPoint`; the standard spelling is
     * `caretPositionFromPoint`. Both are read through the target's own document,
     * and a missing or throwing implementation just means this shape is not
     * recognised — never an exception out of a click handler.
     *
     * @param doc - the target's owner document.
     * @param x - the viewport x of the click.
     * @param y - the viewport y of the click.
     * @returns `{node, offset}`, or null when no text caret is there.
     */
    function caretTextAt(doc, x, y) {
      if (doc === null || doc === undefined) return null
      if (typeof x !== 'number' || typeof y !== 'number') return null
      try {
        if (typeof doc.caretRangeFromPoint === 'function') {
          const range = doc.caretRangeFromPoint(x, y)
          if (range !== null && range !== undefined && range.startContainer?.nodeType === 3) {
            return { node: range.startContainer, offset: range.startOffset }
          }
        }
        if (typeof doc.caretPositionFromPoint === 'function') {
          const position = doc.caretPositionFromPoint(x, y)
          if (position !== null && position !== undefined && position.offsetNode?.nodeType === 3) {
            return { node: position.offsetNode, offset: position.offset }
          }
        }
      } catch {
        return null
      }
      return null
    }

    /**
     * The off-origin URL one plain-text click landed on, or null.
     *
     * Deliberately narrow, because unlike an anchor this shape is only text: a
     * plain left press with nothing selected, no `contenteditable` and no
     * `pre`/`code` above it. A selection drag, the composer, a fenced block and
     * a double-click are all the reader's, not this plugin's. The markdown
     * branch never needs this because the renderer already made those anchors.
     *
     * @param event - the document click event.
     * @param base - `location.href`.
     * @param origin - `location.origin`.
     * @returns the absolute href to open, or null when this click is not one.
     */
    function textLinkOf(event, base, origin) {
      if (!isPlainLeftPress(event)) return null
      if (event?.detail !== undefined && event.detail > 1) return null
      const target = event?.target
      if (!isElement(target) || typeof target.closest !== 'function') return null
      // An anchor already went through `anchorLinkOf`; whatever it answered for
      // this press stands, so a click inside one is never re-read as text.
      if (target.closest('a[href]') !== null) return null
      if (target.closest('[contenteditable]') !== null) return null
      if (target.closest('pre') !== null) return null
      if (target.closest('code') !== null) return null
      const doc = target.ownerDocument
      if (doc === null || doc === undefined) return null
      const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null
      if (selection !== null && selection !== undefined && selection.isCollapsed === false) return null
      const caret = caretTextAt(doc, event.clientX, event.clientY)
      if (caret === null) return null
      const token = linkTokenAt(caret.node.data, caret.offset)
      if (token === null) return null
      let url
      try {
        url = new URL(token, base)
      } catch {
        return null
      }
      if (!OPENABLE.has(url.protocol)) return null
      if (url.origin === origin) return null
      return url.href
    }

    /**
     * One text node's URL ranges, inside the conversation body only.
     *
     * The paint uses the CSS Custom Highlight API, so nothing in React's tree is
     * wrapped or moved: a Range is a paint instruction, not a DOM edit, and a
     * re-render that replaces the node simply drops its Range until the next
     * sync. Anchors are skipped because the shell already styled them, and
     * `code`/`pre`/`contenteditable` surfaces keep their text exactly as it is.
     *
     * @param root - the conversation element to scan.
     * @returns Range objects, one per URL token, capped at `TEXT_LINK_RANGE_LIMIT`.
     */
    function textLinkRanges(root) {
      if (!isElement(root) || typeof root.ownerDocument?.createTreeWalker !== 'function') return []
      const doc = root.ownerDocument
      const ranges = []
      const walker = doc.createTreeWalker(root, 4) // NodeFilter.SHOW_TEXT
      let node = walker.nextNode()
      while (node !== null && ranges.length < TEXT_LINK_RANGE_LIMIT) {
        const tokens = linkTokensIn(node.data)
        const parent = node.parentElement
        if (tokens.length > 0 && parent !== null
          && parent.closest('a[href]') === null
          && parent.closest('code') === null
          && parent.closest('pre') === null
          && parent.closest('[contenteditable]') === null) {
          for (const hit of tokens) {
            if (ranges.length >= TEXT_LINK_RANGE_LIMIT) break
            const range = doc.createRange()
            range.setStart(node, hit.start)
            range.setEnd(node, hit.end)
            ranges.push(range)
          }
        }
        node = walker.nextNode()
      }
      return ranges
    }

    /**
     * One Range per sentence tail the shell's linkifier swallowed into an anchor.
     *
     * These are painted back to the ordinary text colour, so a link that points
     * at `http://localhost:6006/，来自` still *looks* like it ends at the URL.
     * The anchor itself is untouched — a Range is a paint instruction — which is
     * what keeps React's tree reconcilable.
     *
     * @param root - the conversation element to scan.
     * @returns Range objects, one per over-captured anchor tail.
     */
    function linkTailRanges(root) {
      if (!isElement(root) || typeof root.querySelectorAll !== 'function') return []
      const doc = root.ownerDocument
      if (typeof doc?.createRange !== 'function') return []
      const ranges = []
      for (const anchor of root.querySelectorAll('a[href]')) {
        if (ranges.length >= TEXT_LINK_RANGE_LIMIT) break
        const tail = overcapturedAnchor(anchor)
        if (tail === null) continue
        const node = [...anchor.childNodes].find((child) => child.nodeType === 3)
        if (node === undefined || anchor.textContent !== node.data) continue
        const range = doc.createRange()
        range.setStart(node, tail.tailStart)
        range.setEnd(node, tail.tailEnd)
        ranges.push(range)
      }
      return ranges
    }

    /**
     * Take the shell's underline off every over-captured anchor under one root.
     *
     * The anchor is one decorating box, so its underline runs under the sentence
     * tail it swallowed no matter what a highlight says — a highlight can add
     * decoration, not remove it. The mark lets the stylesheet drop the anchor's
     * own line; the URL gets the plugin's underline back through
     * `trimmedUrlRanges`, so the visible line still ends where the URL ends.
     *
     * @param root - the conversation element to scan.
     * @returns how many anchors were newly marked.
     */
    function markTrimmedAnchors(root) {
      if (!isElement(root) || typeof root.querySelectorAll !== 'function') return 0
      let count = 0
      for (const anchor of root.querySelectorAll('a[href]')) {
        if (overcapturedAnchor(anchor) === null) continue
        if (anchor.getAttribute(LINK_TRIM_ATTR) === 'true') continue
        try {
          anchor.setAttribute(LINK_TRIM_ATTR, 'true')
          count += 1
        } catch {
          // A hostile attribute is not this feature's to report.
        }
      }
      return count
    }

    /**
     * One Range per URL that lives inside an over-captured anchor.
     *
     * `markTrimmedAnchors` drops the shell's underline for those anchors, so the
     * URL part is underlined by the same highlight the plain-text URLs use —
     * the plugin's own link style, and the only line the reader sees.
     *
     * @param root - the conversation element to scan.
     * @returns Range objects, one per over-captured URL.
     */
    function trimmedUrlRanges(root) {
      if (!isElement(root) || typeof root.querySelectorAll !== 'function') return []
      const doc = root.ownerDocument
      if (typeof doc?.createRange !== 'function') return []
      const ranges = []
      for (const anchor of root.querySelectorAll('a[href]')) {
        if (ranges.length >= TEXT_LINK_RANGE_LIMIT) break
        if (overcapturedAnchor(anchor) === null) continue
        const node = [...anchor.childNodes].find((child) => child.nodeType === 3)
        if (node === undefined || anchor.textContent !== node.data) continue
        const first = linkTokensIn(node.data)[0]
        if (first === undefined) continue
        const range = doc.createRange()
        range.setStart(node, first.start)
        range.setEnd(node, first.end)
        ranges.push(range)
      }
      return ranges
    }

    /**
     * Paint every plain-text URL under one root as a link.
     *
     * The CSS Custom Highlight API is optional: a shell whose engine lacks it
     * simply keeps the click behaviour and shows no link styling. That is the
     * only failure mode — this never throws into the page.
     *
     * @param root - the conversation element to scan.
     * @returns the number of painted tokens, 0 when the API is absent.
     */
    function paintTextLinks(root) {
      // `globalThis.CSS`, not `CSS`: this very module declares a `const CSS` for its
      // stylesheet, so a bare `CSS` here is that string, not the browser's namespace.
      const api = globalThis.CSS
      const highlights = api === undefined || api === null ? undefined : api.highlights
      const HighlightCtor = globalThis.Highlight
      if (highlights === undefined || highlights === null || typeof HighlightCtor !== 'function') return 0
      try {
        markTrimmedAnchors(root)
        const ranges = [...textLinkRanges(root), ...trimmedUrlRanges(root)]
        highlights.set(TEXT_LINK_HIGHLIGHT, new HighlightCtor(...ranges))
        const tails = linkTailRanges(root)
        highlights.set(TEXT_LINK_TAIL_HIGHLIGHT, new HighlightCtor(...tails))
        return ranges.length
      } catch {
        return 0
      }
    }

    /** Retire the plain-text link paint; an engine without the API has nothing to retire. */
    function clearTextLinks() {
      try {
        const api = globalThis.CSS
        if (api === undefined || api === null || !api.highlights) return
        api.highlights.delete(TEXT_LINK_HIGHLIGHT)
        api.highlights.delete(TEXT_LINK_TAIL_HIGHLIGHT)
      } catch {
        // The API is optional; a refusal is not this feature's to report.
      }
    }

    /**
     * Whether one pointer position is over a plain-text URL, for the hand cursor.
     *
     * The same exclusions and the same tokenizer as the click: what the cursor
     * promises is exactly what a press does.
     *
     * @param event - the document pointer event.
     * @returns whether the cursor should read as a link.
     */
    function pointerOverTextLink(event) {
      const target = event?.target
      if (!isElement(target) || typeof target.closest !== 'function') return false
      if (target.closest('a[href]') !== null) return false
      if (target.closest('[contenteditable]') !== null) return false
      if (target.closest('pre') !== null) return false
      if (target.closest('code') !== null) return false
      const caret = caretTextAt(target.ownerDocument, event.clientX, event.clientY)
      return caret !== null && linkTokenAt(caret.node.data, caret.offset) !== null
    }

    /**
     * The over-captured anchor whose *tail* the pointer sits on, or null.
     *
     * The shell made the URL and the sentence tail one anchor, so CSS alone
     * cannot keep the tail out of the link: the tail is inside the hit area and
     * the cursor over it would read as a link. Both the press handler and the
     * cursor check this one function, so what looks clickable and what is
     * clickable agree.
     *
     * @param event - the document pointer/click event.
     * @returns the anchor whose tail owns the pointer, or null.
     */
    function pointerOverLinkTail(event) {
      const target = event?.target
      if (!isElement(target) || typeof target.closest !== 'function') return null
      const anchor = target.closest('a[href]')
      if (anchor === null || anchor === undefined) return null
      const tail = overcapturedAnchor(anchor)
      if (tail === null) return null
      const node = [...anchor.childNodes].find((child) => child.nodeType === 3)
      if (node === undefined || anchor.textContent !== node.data) return null
      const caret = caretTextAt(anchor.ownerDocument, event.clientX, event.clientY)
      if (caret === null || caret.node !== node || caret.offset <= tail.tailStart) return null
      return anchor
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
     * Capture-phase link handler.
     *
     * Off-origin links — a rendered anchor or a URL that stayed plain text —
     * leave through the host; everything else — a click that is not a link, a
     * scheme the opener must not receive, the application's own navigation, or
     * a preference that is off — keeps the shell's behaviour untouched. A host
     * that refuses or cannot be reached falls back to the page's own
     * `window.open`, because a swallowed click is the one outcome a link must
     * not have.
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
      // The tail the shell swallowed into an anchor is not part of the link:
      // claim the press so the shell's own anchor handler cannot open it, and
      // open nothing. The browser's own mousedown selection is untouched.
      if (pointerOverLinkTail(event) !== null) {
        event.preventDefault()
        event.stopPropagation()
        return true
      }
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
     * The link one inline `code` belongs to, in either direction, or null.
     *
     * The shipped renderer reaches a link through inline code in two shapes,
     * and both already have an owner — the capture-phase click listener that
     * hands off-origin URLs to the Host — so the code menu must not claim
     * either one:
     *
     *   - a markdown link whose text is inline code: `<a href><code>…</code></a>`;
     *   - a URL the renderer resolved as a link *inside* inline code:
     *     `<code><a href>…</a></code>` — the globe glyph in front of the URL is
     *     this shape, and `Ab(s)` in the shipped renderer is what produces it.
     *
     * The second shape is the one a bare `element.closest('a[href]')` misses:
     * there the anchor is a **descendant** of the `code`, so walking up from
     * the code never meets it. Checking both directions is what keeps every
     * "this code is really a link" verdict in one function; a future rendering
     * shape (a `role="link"` control, a new wrapper) is patched here, not in
     * each caller.
     *
     * @param element - the `<code>` element a press landed in.
     * @returns the owning/contained `<a href>`, or null when this code is not a link.
     */
    function inlineCodeLink(element) {
      if (typeof element?.closest === 'function') {
        const outer = element.closest('a[href]')
        if (isElement(outer)) return outer
      }
      if (typeof element?.querySelector === 'function') {
        const inner = element.querySelector('a[href]')
        if (isElement(inner)) return inner
      }
      return null
    }

    /**
     * The inline `code` a context-menu press landed in, with the text to copy.
     *
     * Every exclusion here is a place where a `code` element means something
     * other than "a path or a snippet in the conversation": a fenced block
     * (`pre > code`) is multi-line and out of scope, the composer and the
     * shortcut editor are contenteditable, and a link already has an owner —
     * the capture-phase click listener that hands off-origin URLs to the Host.
     * A link reaches inline code from either direction, and `inlineCodeLink`
     * is the one place that decides it: a markdown link whose text is code,
     * and — the common one — a URL the shipped renderer resolved *inside*
     * inline code (`code > a`). A future rendering shape is patched there,
     * not here.
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
      // A link, in either direction, belongs to the off-origin hand-off. See
      // `inlineCodeLink`.
      if (inlineCodeLink(element) !== null) return null
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
     * and a `~/…` code, which the shell's path mention resolves against the
     * Workspace root and therefore can never reach the home it names. An inert
     * `code` — plain prose — keeps today's behaviour and costs no round trip.
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
      // Every inline code in scope is this plugin's press now: one that can be
      // opened is opened, and one that cannot is copied.
      return codeMenuTarget(event)
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
     * @returns `present`, `directory`, `missing`, or `unknown`.
     */
    function statVerdict(result) {
      if (result !== null && typeof result === "object" && result.ok === true) return "present"
      const error = result !== null && typeof result === "object" ? result.error : null
      const code = String(error?.code ?? "")
      const message = String(error?.message ?? "")
      const kind = String(error?.details?.kind ?? "")
      if (/not[-_ ]?found|enoent|no such file/i.test(code + " " + message)) return "missing"
      // A directory is a real, addressable thing — just not a file the Sidebar
      // preview can show. It is the one other verdict this plugin acts on.
      if (/not-regular-file/i.test(code) && (kind === "directory" || /\bdirectory\b/i.test(message))) return "directory"
      return "unknown"
    }

    /**
     * The catalog id of this Host's file manager, from the applications it lists.
     *
     * The Host's own catalog is the source: its `kind` already says which entry
     * is the platform file manager, so this client does not carry a second,
     * drifting list of names.
     *
     * @param apps - the `apps` array `GET /flow/apps` answered, when it did.
     * @returns the id, or null when the Host lists no file manager.
     */
    function fileManagerAppOf(apps) {
      if (!Array.isArray(apps)) return null
      const row = apps.find((app) => app !== null && typeof app === 'object' && app.kind === 'files' && typeof app.id === 'string' && app.id !== '')
      return row === undefined ? null : row.id
    }

    /**
     * The rows one application catalog shows, in the Host's own order.
     *
     * A catalog the Host answered with `{id, name, kind}` becomes the rows the two
     * application menus share. The label is this plugin's own localized name for
     * an id it carries — so the English page does not show the Host's Chinese
     * name — and the Host's own name otherwise. The icon rides the shipped route,
     * whose unknown-id 404 the `img`'s own `onerror` absorbs.
     *
     * @param apps - the `apps` array `GET /flow/apps` answered, when it did.
     * @param t - the plugin's localized copy.
     * @returns `[{key, id, label, kind, icon}]`.
     */
    function catalogApplications(apps, t) {
      if (!Array.isArray(apps)) return []
      const rows = []
      for (const app of apps) {
        if (app === null || typeof app !== 'object') continue
        const id = String(app.id ?? '')
        if (id === '') continue
        const label = APP_LABEL_IDS.has(id)
          ? t('app.' + id)
          : (typeof app.name === 'string' && app.name !== '' ? app.name : id)
        rows.push({ key: id, id, label, kind: String(app.kind ?? ''), icon: OPEN_IN_APP_ICON_ROUTE + '/' + id })
      }
      return rows
    }

    /**
     * The application rows that may open one target, by the target's own kind.
     *
     * A file is only ever handed to an IDE — the Host's open route enforces the
     * same rule; this is the half that keeps the menu honest — while a directory
     * may go to anything the Host has installed, terminals and the file manager
     * included.
     *
     * @param apps - the catalog rows.
     * @param kind - `file` or `directory`.
     * @returns the rows the menu may offer.
     */
    function applicationsForKind(apps, kind) {
      if (!Array.isArray(apps)) return []
      if (kind === 'directory') return apps
      return apps.filter((app) => app !== null && typeof app === 'object' && app.kind === 'ide')
    }

    /**
     * One page's installed-application catalog, remembered after the first
     * successful answer.
     *
     * A page asks the Host once and keeps the answer: the list changes only when
     * the user installs an application, and every menu would otherwise repeat the
     * round trip. A failed answer is **not** remembered — the Host may be
     * restarting, and a shared cache of an empty list would leave every menu
     * short for the rest of the page's life.
     *
     * @param input.fetch - the page's fetch.
     * @param input.route - the route answering `{apps}`.
     * @returns `() => Promise<app[]>`.
     */
    function createAppsLookup({ fetch, route = APPS_ROUTE }) {
      let cache = null
      let pending = null
      return () => {
        if (cache !== null) return Promise.resolve(cache)
        if (pending === null) {
          pending = Promise.resolve()
            .then(() => fetch(route, { credentials: 'same-origin' }))
            .then((response) => (response.ok ? response.json() : null), () => null)
            .then((payload) => (Array.isArray(payload?.apps) ? payload.apps : null), () => null)
            .then((apps) => {
              pending = null
              if (apps === null) return []
              cache = apps
              return apps
            })
        }
        return pending
      }
    }

    /**
     * The two paths one inline `code` names: what to ask the Host about, and
     * what to hand an application.
     *
     * `~/…` expands to the account home; an absolute code is already absolute;
     * anything else is relative to the Session's workspace directory. A code this
     * client cannot complete (no home, no workspace root, empty text) is not a
     * target at all, and that press keeps the shipped pair.
     *
     * @param text - the code's exact text.
     * @param home - the Host home, or a getter for it.
     * @param root - the Session's workspace directory, when known.
     * @returns `{probe, absolute}`, or null.
     */
    function pathTarget(text, home, root) {
      if (typeof text !== 'string') return null
      const trimmed = text.trim()
      if (trimmed === '') return null
      // Whitespace means prose, a command line or a sentence, never a path this
      // plugin may spend a round trip on: prose keeps offering copy alone.
      if (/\s/.test(trimmed)) return null
      if (isTildePath(trimmed)) {
        const absolute = expandHomePath(trimmed, typeof home === 'function' ? home() : home)
        return absolute === null ? null : { probe: absolute, absolute }
      }
      if (trimmed.startsWith('/')) return { probe: trimmed, absolute: trimmed }
      if (typeof root !== 'string' || root === '') return null
      return { probe: trimmed, absolute: root.replace(/\/+$/u, '') + '/' + trimmed }
    }

    /**
     * The rows one open inline-code menu shows.
     *
     * A code that names no path keeps the shipped 打开 / 复制 pair. Once the code is
     * known to name a path the menu is copy-first, and the application rows are
     * appended as they arrive, so the top row never moves under the pointer.
     *
     * @param menu - the code-menu store's snapshot, or null.
     * @returns `[{key, kind, app?, labelKey}]`.
     */
    function codeMenuRows(menu) {
      if (menu === null || typeof menu !== 'object') return []
      // Nothing can open this code — no shell control, no path shape — so the
      // menu offers the one thing it has, without a probe it would never send.
      if (menu.copyOnly === true) {
        return [{ key: 'copy', kind: 'copy', labelKey: 'codeMenu.copy' }]
      }
      if (typeof menu.path !== 'string' || menu.path === '') {
        return [
          { key: 'open', kind: 'open', labelKey: 'codeMenu.open' },
          { key: 'copy', kind: 'copy', labelKey: 'codeMenu.copy' },
        ]
      }
      const rows = [{ key: 'copy', kind: 'copy', labelKey: 'codeMenu.copy' }]
      for (const app of (Array.isArray(menu.apps) ? menu.apps : [])) {
        rows.push({ key: app.key, kind: 'app', app })
      }
      return rows
    }

    /**
     * One Session's workspace directory, which is what a relative code resolves
     * against.
     *
     * @param snapshot - the `sessions` store snapshot.
     * @param sessionId - the current Session id, or null.
     * @returns the directory, or null.
     */
    function sessionCwd(snapshot, sessionId) {
      const cwd = snapshot?.byId?.[sessionId]?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : null
    }

    /**
     * What one openable inline `code` would do, decided without a round trip.
     *
     * A `~/…` code is this plugin's own case **even when the shell wired a
     * control into it**: the shipped path mention resolves a relative path against
     * the Workspace root, so `~/x` never reaches the account home it names. The
     * control is still remembered on the plan — a verdict the probe cannot prove
     * falls back to it rather than guessing. Every other control-bearing code
     * belongs to the shell; a code with neither owner is not ours to open.
     *
     * @param hit - `{element, text}` from `codeMenuTarget`.
     * @param home - the Host home, or a getter for it.
     * @returns `{kind, probe[, shell]}`, or null when there is nothing to open.
     */
    function inlineCodePlan(hit, home) {
      const control = shellWiredControl(hit.element)
      if (isTildePath(hit.text)) {
        const absolute = expandHomePath(hit.text, typeof home === 'function' ? home() : home)
        if (absolute !== null) return { kind: 'home', probe: absolute, shell: control !== null }
      }
      if (control !== null) return { kind: 'shell', probe: hit.text }
      return null
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
     * @param input.openHome - open one absolute file in the Sidebar.
     * @param input.openDirectory - open one absolute directory in the platform file manager.
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
          if (verdict === "directory") {
            // The Sidebar preview shows files only, so a directory takes the
            // Host's own open-in-app route out to the platform file manager.
            return Promise.resolve(input.openDirectory(plan.probe))
              .then((opened) => (opened === true ? "open" : "unknown"), () => "unknown")
          }
          if (verdict !== "present") {
            // The probe could not prove this path — a directory, or a Host that
            // is away. A code the shell wired a control into goes back to the
            // shell (its own directory handling stays intact); one without a
            // control opens nothing at all.
            if (plan.shell === true) {
              input.open(hit.element)
              return "open"
            }
            return "unknown"
          }
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
      event.preventDefault()
      event.stopPropagation()
      if (plan === null) {
        // Nothing can open this code: the shell wired no control into it and it
        // names no home path this plugin can reach. The press does the one thing
        // left — it copies the code — instead of leaving a dead menu entry.
        if (typeof input.copy !== 'function') return Promise.resolve("pass")
        return Promise.resolve()
          .then(() => input.copy(hit.text))
          .then(() => "copy", () => "copy")
      }
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
     * Every message the user really sent, oldest first.
     *
     * The Session event window also carries user-role messages a plugin
     * injected (workspace instructions, reminders); the source kind is what
     * tells them apart, so only a user-produced message survives. Text blocks
     * are joined and durable attachments ride along, so the caller can decide
     * what it can bring back.
     *
     * @param entries - the Session event window's entries.
     * @returns one row per sent message: seq, joined text, image and file refs.
     */
    function sentUserMessages(entries) {
      const messages = []
      if (!Array.isArray(entries)) return messages
      for (const entry of entries) {
        const event = entry?.event ?? entry
        if (event?.type !== 'user/message') continue
        const data = event.data
        if (data?.source?.kind !== 'user') continue
        const content = Array.isArray(data.content) ? data.content : []
        const texts = []
        const images = []
        const files = []
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text)
          } else if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
            images.push(block.attachment)
          } else if (block.type === 'file' && typeof block.attachment?.attachmentId === 'string') {
            files.push(block.attachment)
          }
        }
        if (texts.length === 0 && images.length === 0 && files.length === 0) continue
        messages.push({ seq: event.seq, text: texts.join('\n'), images, files })
      }
      return messages
    }

    /**
     * Where one arrow press wants the recall cursor to go.
     *
     * The list is addressed by seq, never by index: pulling an older page
     * prepends entries, and an index would then point at another message.
     *
     * @param state - the message on screen (anchorSeq) and whether an older page is unloaded.
     * @param key - the pressed key.
     * @param messages - sentUserMessages output, oldest first.
     * @returns the step: idle (leave the press alone), show, restore, or load-older.
     */
    function composerHistoryStep(state, key, messages) {
      const list = Array.isArray(messages) ? messages : []
      const anchor = state?.anchorSeq ?? null
      const hasMore = state?.hasMore === true
      if (key === 'ArrowUp') {
        if (anchor === null) {
          if (list.length > 0) return { kind: 'show', message: list[list.length - 1] }
          return hasMore ? { kind: 'load-older' } : { kind: 'idle' }
        }
        for (let index = list.length - 1; index >= 0; index -= 1) {
          if (list[index].seq < anchor) return { kind: 'show', message: list[index] }
        }
        return hasMore ? { kind: 'load-older' } : { kind: 'idle' }
      }
      if (key === 'ArrowDown') {
        if (anchor === null) return { kind: 'idle' }
        for (const message of list) {
          if (message.seq > anchor) return { kind: 'show', message }
        }
        return { kind: 'restore' }
      }
      return { kind: 'idle' }
    }

    /**
     * What one recalled message puts in the composer.
     *
     * @param message - one sentUserMessages row.
     * @param fileLabel - localizes the placeholder for a file attachment whose
     *   bytes this plugin has no client API to read back.
     * @returns the draft text.
     */
    function historyDraftText(message, fileLabel) {
      const lines = []
      const text = typeof message?.text === 'string' ? message.text : ''
      if (text !== '') lines.push(text)
      const files = Array.isArray(message?.files) ? message.files : []
      for (const file of files) lines.push(fileLabel(file))
      return lines.join('\n')
    }

    /**
     * Hand files back to the shipped composer the way a paste would.
     *
     * The composer's own intake is the only thing that registers a browser
     * attachment draft, so a synthetic paste carrying a real File is the one
     * route that needs no private API. The constructors come from the element's
     * own window, which is also what lets a test supply stand-ins.
     *
     * @param target - the composer's editable root.
     * @param files - the File objects to attach.
     * @param view - the window that owns the constructors.
     * @returns whether a paste event could be dispatched.
     */
    function pasteComposerFiles(target, files, view) {
      const DataTransferCtor = view?.DataTransfer
      const ClipboardEventCtor = view?.ClipboardEvent
      if (typeof DataTransferCtor !== 'function' || typeof ClipboardEventCtor !== 'function') return false
      if (!isElement(target) || typeof target.dispatchEvent !== 'function') return false
      const transfer = new DataTransferCtor()
      for (const file of files) transfer.items.add(file)
      target.dispatchEvent(new ClipboardEventCtor('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }))
      return true
    }

    /**
     * The recalled-messages seat: one capture-phase listener's worth of behavior
     * over the composer.
     *
     * The draft is the gate. The shipped arrows move the caret, and this feature
     * only steps in when the caret has nothing to move: an empty draft, or the
     * text it put there itself. Every DOM read is an injected thunk, so the
     * whole state machine is asserted without a browser.
     *
     * @param input.enabled - reads the live preference.
     * @param input.inComposer - whether the press landed in the composer.
     * @param input.menuOwnsKey - whether the trigger menu has a highlighted candidate.
     * @param input.sessionId - the Session on screen, or null.
     * @param input.draft - the composer's live draft text, or null when unreadable.
     * @param input.setDraft - replaces the draft; false when it could not.
     * @param input.messages - sentUserMessages over the live window.
     * @param input.hasMore - whether older history is still unloaded.
     * @param input.loadOlder - pulls one older page.
     * @param input.pasteImages - brings durable pictures back into the draft.
     * @param input.fileLabel - localizes the file-attachment placeholder.
     * @returns the seat the document listener drives.
     */
    function createComposerHistory(input) {
      let anchorSeq = null
      let shownText = ''
      let stash = ''
      let session = null
      let loading = false

      const forget = () => {
        anchorSeq = null
        shownText = ''
        stash = ''
      }
      const show = (message) => {
        const text = historyDraftText(message, input.fileLabel)
        if (input.setDraft(text) === false) return false
        anchorSeq = message.seq
        shownText = text
        input.pasteImages(Array.isArray(message.images) ? message.images : [])
        return true
      }

      return {
        /**
         * Recall one step, or let the press through.
         *
         * @param event - the document keydown event.
         * @returns whether this press was taken away from the shell.
         */
        handle(event) {
          if (loading) return false
          if (input.enabled() !== true) return false
          const key = event?.key
          if (key !== 'ArrowUp' && key !== 'ArrowDown') return false
          // An IME owns its own arrows, and every modifier chord belongs to
          // whatever the shell already made of it.
          if (event?.isComposing === true || event?.keyCode === 229) return false
          if (event?.altKey === true || event?.metaKey === true || event?.ctrlKey === true || event?.shiftKey === true) return false
          if (input.inComposer(event) !== true) return false
          if (input.menuOwnsKey() === true) return false

          const current = input.sessionId()
          if (current !== session) {
            // A different conversation starts from scratch: the anchors and the
            // stashed draft belong to a composer that is no longer on screen.
            session = current
            forget()
          }

          const draft = input.draft()
          if (typeof draft !== 'string') return false
          // A draft this seat did not put there keeps the arrows for the caret,
          // and so does an edit made to the text it did put there.
          if (anchorSeq === null ? draft !== '' : draft !== shownText) return false

          const step = composerHistoryStep({ anchorSeq, hasMore: input.hasMore() === true }, key, input.messages())
          if (step.kind === 'idle') return false
          if (step.kind === 'load-older') {
            loading = true
            event.preventDefault()
            event.stopImmediatePropagation()
            Promise.resolve(input.loadOlder()).then(() => {
              loading = false
              const next = composerHistoryStep({ anchorSeq, hasMore: input.hasMore() === true }, key, input.messages())
              if (next.kind === 'show') show(next.message)
            }, () => { loading = false })
            return true
          }
          event.preventDefault()
          event.stopImmediatePropagation()
          if (step.kind === 'restore') {
            input.setDraft(stash)
            forget()
            return true
          }
          if (anchorSeq === null) stash = draft
          return show(step.message)
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
          return seq
        },
        /**
         * Patch the menu one probe was measured for.
         *
         * The press that opened a menu and the round trip that classifies it are
         * separated by many frames: another menu can open, and this one can close,
         * before the answer lands. The sequence number is what keeps a late answer
         * from re-labelling a menu it does not belong to.
         *
         * @param target - the value `open` returned for that menu.
         * @param patch - fields to merge into the snapshot.
         * @returns whether the patch landed.
         */
        mark: (target, patch) => {
          if (snapshot === null || snapshot.seq !== target) return false
          snapshot = { ...snapshot, ...patch }
          emit()
          return true
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
     * Read the recalled-messages preference off the plugin's config form.
     *
     * The default is on, and an unreadable form keeps that default: a Host that
     * does not project the field yet must not silently take the feature away.
     *
     * @param form - the plugin's config form.
     * @returns whether an empty composer recalls sent messages on arrow keys.
     */
    function readComposerHistoryEnabled(form) {
      let value
      try {
        value = form.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value === null || typeof value !== 'object') return true
      return value.composerHistory !== false
    }

    /** The changed-files card the shipped deliverables plugin renders at a turn's tail. */
    const CHANGES_CARD = '[data-changed-files]'

    /**
     * The changed-file row a context-menu press landed in, with the Host path.
     *
     * The shipped card renders every changed file as a `button[aria-describedby]`
     * and keeps the path in the hidden element that id names; the card resolved
     * it against the Session workspace, so this plugin never guesses one. The
     * card root is the positive half of the scope: the same button shape in some
     * other surface is left alone.
     *
     * @param event - the document `contextmenu` event.
     * @returns `{element, path}`, or null when this press is not ours.
     */
    function changedFileTarget(event) {
      const target = event?.target
      if (!isElement(target) || typeof target.closest !== 'function') return null
      const element = target.closest('button[aria-describedby]')
      if (!isElement(element) || typeof element.closest !== 'function') return null
      if (element.closest(CHANGES_CARD) === null) return null
      const path = describedFilePath(element)
      if (path === null) return null
      return { element, path }
    }

    /**
     * The Host path one changed-file row names, or null when it names none.
     *
     * The card keeps the path in the hidden element its `aria-describedby`
     * points at, already resolved against the Session workspace, so this plugin
     * never guesses one.
     *
     * @param element - a `button[aria-describedby]` inside a changed-files card.
     * @returns the path, or null.
     */
    function describedFilePath(element) {
      if (!isElement(element)) return null
      const describedBy = element.getAttribute('aria-describedby')
      if (typeof describedBy !== 'string') return null
      const id = describedBy.trim().split(/\s+/)[0]
      if (id === '') return null
      const doc = element.ownerDocument
      if (doc === null || doc === undefined || typeof doc.getElementById !== 'function') return null
      const description = doc.getElementById(id)
      if (!isElement(description)) return null
      const path = String(description.textContent ?? '').trim()
      return path === '' ? null : path
    }

    /**
     * Capture-phase `contextmenu` handler for the changed-file rows.
     *
     * Same rule as the inline-code menu: the press is taken away from the
     * browser only when the menu is really about to open, so every other
     * right-click keeps the shipped behaviour.
     *
     * @param event - the document `contextmenu` event.
     * @param input.open - place the menu: `({x, y, path, element}) => void`.
     * @returns whether this press was claimed.
     */
    function handleChangesContextMenu(event, input) {
      const hit = changedFileTarget(event)
      if (hit === null) return false
      event.preventDefault()
      event.stopPropagation()
      input.open({ x: event.clientX, y: event.clientY, path: hit.path, element: hit.element })
      return true
    }

    /**
     * Hand one absolute path to the Host's open-with route.
     *
     * `app` is a catalog id, `default` for the operating system's own default
     * gesture, or `reveal` for the platform file manager. The Host re-validates
     * both fields, so an id the catalog no longer lists, a relative path and a
     * file handed to a non-IDE are all refused there rather than acted on here.
     * A malformed request never leaves the page at all.
     *
     * @param input.app - the catalog id, or `default` / `reveal`.
     * @param input.path - the absolute Host path.
     * @param input.fetch - the page's fetch, injected so tests own the transport.
     * @returns whether the Host acknowledged the hand-off.
     */
    function openWithPath(input) {
      const app = typeof input?.app === 'string' && input.app !== '' ? input.app : null
      const path = typeof input?.path === 'string' && input.path !== '' ? input.path : null
      if (app === null || path === null || typeof input.fetch !== 'function') return Promise.resolve(false)
      return Promise.resolve()
        .then(() => input.fetch(OPEN_WITH_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app, path }),
        }))
        .then((response) => response.ok === true, () => false)
    }

    /**
     * Open one changed file, or ask the Host to show its location.
     *
     * The request rides this plugin's own `POST /flow/open-with` route rather
     * than the Session Remote: the route re-validates the path against the live
     * filesystem, refuses an application that may not open a file, and answers a
     * status rather than throwing. A refusal, a transport that rejects and a page
     * that never had one all read as the same spoken refusal, so a press never
     * looks like it worked when it did not.
     *
     * @param input.path - the absolute Host path the card recorded.
     * @param input.app - a catalog id, or `default` / `reveal`.
     * @param input.fetch - the page's fetch.
     * @param input.notify - raise a notice.
     * @param input.t - the plugin's localized copy.
     * @returns whether the Host acknowledged the hand-off.
     */
    function openChangedFile(input) {
      const failureKey = input.app === 'reveal' ? 'changesFile.revealFailed' : 'changesFile.failed'
      return openWithPath(input).then((opened) => {
        if (opened === true) return true
        input.notify(input.t(failureKey), 'warning')
        return false
      })
    }

    /**
     * The one-slot seat the changed-file menu renders from.
     *
     * Same contract as the inline-code seat: every open mints a new snapshot
     * carrying a new sequence, so re-opening at the very same press point still
     * re-renders.
     *
     * @returns the store the capture listener writes and the overlay entry reads.
     */
    function createChangesMenuStore() {
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
         * @param input.path - the Host path the row named.
         * @param input.element - the row button the press landed in.
         */
        open: (input) => {
          seq += 1
          snapshot = { seq, x: input.x, y: input.y, path: input.path, element: input.element, apps: [] }
          emit()
          return seq
        },
        /**
         * Patch the menu one catalog answer was measured for.
         *
         * The press that opens a menu and the round trip that fills it are
         * separated by many frames: another menu can open, and this one can
         * close, before the answer lands. The sequence number is what keeps a
         * late answer from relabelling a menu it does not belong to.
         *
         * @param target - the value `open` returned for that menu.
         * @param patch - fields to merge into the snapshot.
         * @returns whether the patch landed.
         */
        mark: (target, patch) => {
          if (snapshot === null || snapshot.seq !== target) return false
          snapshot = { ...snapshot, ...patch }
          emit()
          return true
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
     * Read the changed-file menu preference off the plugin's config form.
     *
     * The default is on, and an unreadable form keeps that default: a Host that
     * does not project the field yet must not silently take the feature away.
     *
     * @param form - `ctx.configForms.get('flow')`.
     * @returns whether a right-click on a changed-file row opens the menu.
     */
    function readChangesFileOpen(form) {
      let value
      try {
        value = form.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value === null || typeof value !== 'object') return true
      return value.changesFileOpen !== false
    }

    /**
     * The rows one changed-file menu shows.
     *
     * The default action and the file-manager reveal are always there, so the
     * menu that opens before the catalog lands is never empty. The application
     * rows are the IDEs the Host has installed — the caller filters the catalog
     * by kind before filling the seat — and they sit between the two anchors, so
     * the first row never moves under the pointer as they arrive.
     *
     * @param menu - the changed-file store's snapshot, or null.
     * @returns `[{key, kind, labelKey?, app?}]`.
     */
    function changesFileRows(menu) {
      if (menu === null || typeof menu !== 'object') return []
      const apps = Array.isArray(menu.apps) ? menu.apps : []
      const rows = [{ key: 'open', kind: 'open', labelKey: 'changesFile.open' }]
      for (const app of apps) rows.push({ key: 'app:' + app.id, kind: 'app', app })
      rows.push({ key: 'reveal', kind: 'reveal', labelKey: 'changesFile.reveal' })
      return rows
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
     * Cell key of the changed-file menu's own entry in `shell.overlay`.
     *
     * Same rule as the inline-code menu: a fresh id is a new cell beside the
     * entries already in the slot, so the copy notice and the two menus never
     * replace one another.
     */
    const CHANGES_MENU_ID = 'flow.changes-menu'

    /**
     * Document attribute that turns on the pointer cursor for inline code.
     *
     * Every in-scope inline code is a press target while the menu preference is
     * on — it opens or it copies — so the cursor has to say so. The attribute is
     * set beside the listeners and removed with them, which is what keeps code
     * looking inert again the moment the preference goes off.
     */
    const CODE_CURSOR_ATTR = 'data-flow-code-cursor'

    /** The CSS Custom Highlight name the plain-text URLs are painted under. */
    const TEXT_LINK_HIGHLIGHT = 'flow-text-link'

    /** The CSS Custom Highlight name the over-captured sentence tails are painted under. */
    const TEXT_LINK_TAIL_HIGHLIGHT = 'flow-link-tail'

    /** The attribute that takes the shell's underline off an over-captured anchor. */
    const LINK_TRIM_ATTR = 'data-flow-link-trimmed'

    /** Upper bound on painted URL ranges, so a huge transcript cannot stall a frame. */
    const TEXT_LINK_RANGE_LIMIT = 600

    /** Document attribute that makes the cursor a hand while it is over a plain-text URL. */
    const TEXT_LINK_CURSOR_ATTR = 'data-flow-text-link-cursor'

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
.flow-changes-menu-anchor{display:none}
.flow-app-icon{display:block;width:14px;height:14px;border-radius:3px}
html[data-flow-code-cursor="true"] [class*="_markdown_"] code{cursor:pointer}
html[data-flow-code-cursor="true"] [class*="_markdown_"] pre code{cursor:auto}
html[data-flow-text-link-cursor="true"],html[data-flow-text-link-cursor="true"] *{cursor:pointer}
::highlight(flow-text-link){color:var(--dsw-alias-link,currentColor);text-decoration:underline dotted var(--dsw-alias-link,currentColor);text-underline-offset:3px}
::highlight(flow-link-tail){color:var(--dsw-alias-label-primary,currentColor);text-decoration:none}
a[data-flow-link-trimmed]{text-decoration:none!important}
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
      'codeMenu.openFailed': '打开失败',
      'codeMenu.done': '已复制行内代码',
      'codeMenu.failed': '复制失败，剪贴板不可用',
      'app.cursor': 'Cursor',
      'app.vscode': 'VS Code',
      'app.vscodeinsiders': 'VS Code Insiders',
      'app.windsurf': 'Windsurf',
      'app.zed': 'Zed',
      'app.sublimetext': 'Sublime Text',
      'app.xcode': 'Xcode',
      'app.androidstudio': 'Android Studio',
      'app.intellij': 'IntelliJ IDEA',
      'app.pycharm': 'PyCharm',
      'app.webstorm': 'WebStorm',
      'app.phpstorm': 'PhpStorm',
      'app.goland': 'GoLand',
      'app.rider': 'Rider',
      'app.rustrover': 'RustRover',
      'app.fork': 'Fork',
      'app.sourcetree': 'Sourcetree',
      'app.github': 'GitHub Desktop',
      'app.tower': 'Tower',
      'app.gitkraken': 'GitKraken',
      'app.smartgit': 'SmartGit',
      'app.sublimemerge': 'Sublime Merge',
      'app.ghostty': 'Ghostty',
      'app.warp': 'Warp',
      'app.iterm': 'iTerm2',
      'app.kitty': 'kitty',
      'app.windowsterminal': 'Windows Terminal',
      'app.gitbash': 'Git Bash',
      'app.gnometerminal': 'GNOME Terminal',
      'app.konsole': 'Konsole',
      'app.finder': '访达',
      'app.explorer': '文件资源管理器',
      'app.filemanager': '文件管理器',
      'app.terminal': '终端',
      'changesFile.open': '用默认应用打开',
      'changesFile.reveal': '在文件管理器中显示',
      'changesFile.failed': '无法用默认应用打开这个文件',
      'changesFile.revealFailed': '无法在文件管理器中显示这个文件',
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
      'section.changesFile.title': '改动文件右键菜单',
      'section.changesFile.description': '在「已编辑 N 个文件」卡片的文件行上点右键，弹出「用默认应用打开」；下面是你装的 IDE（VS Code、Zed、Xcode、IntelliJ IDEA 等，带图标），最后是「在文件管理器中显示」。都交给本插件的宿主路由 POST /flow/open-with 执行，关闭后不注册这个右键菜单。',
      'section.sendKey.title': '⌘+Enter 发送',
      'section.sendKey.description': '打开后：⌘+Enter（Windows/Linux 为 Ctrl+Enter）发送，Enter 换行，⇧+Enter 仍是换行；⇧⌘+Enter 保留官方的另一种发送方式。关闭后回到官方行为——Enter 发送，⌘+Enter 走另一种发送方式。',
      'history.file': '[附件：{name}]',
      'section.history.title': '↑↓ 切换发过的消息',
      'section.history.description': '草稿为空时，用 ↑/↓ 在当前对话发过的消息之间切换：↑ 更早、↓ 更新，越过最新一条回到原来的草稿。带图片的消息会把图片重新粘回草稿；文件附件（本插件读不回内容）以一行占位文字保留，可自行删除。',
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
      'codeMenu.openFailed': 'Could not open',
      'codeMenu.done': 'Inline code copied',
      'codeMenu.failed': 'Copy failed: the clipboard rejected the write',
      'app.cursor': 'Cursor',
      'app.vscode': 'VS Code',
      'app.vscodeinsiders': 'VS Code Insiders',
      'app.windsurf': 'Windsurf',
      'app.zed': 'Zed',
      'app.sublimetext': 'Sublime Text',
      'app.xcode': 'Xcode',
      'app.androidstudio': 'Android Studio',
      'app.intellij': 'IntelliJ IDEA',
      'app.pycharm': 'PyCharm',
      'app.webstorm': 'WebStorm',
      'app.phpstorm': 'PhpStorm',
      'app.goland': 'GoLand',
      'app.rider': 'Rider',
      'app.rustrover': 'RustRover',
      'app.fork': 'Fork',
      'app.sourcetree': 'Sourcetree',
      'app.github': 'GitHub Desktop',
      'app.tower': 'Tower',
      'app.gitkraken': 'GitKraken',
      'app.smartgit': 'SmartGit',
      'app.sublimemerge': 'Sublime Merge',
      'app.ghostty': 'Ghostty',
      'app.warp': 'Warp',
      'app.iterm': 'iTerm2',
      'app.kitty': 'kitty',
      'app.windowsterminal': 'Windows Terminal',
      'app.gitbash': 'Git Bash',
      'app.gnometerminal': 'GNOME Terminal',
      'app.konsole': 'Konsole',
      'app.finder': 'Finder',
      'app.explorer': 'File Explorer',
      'app.filemanager': 'Files',
      'app.terminal': 'Terminal',
      'changesFile.open': 'Open in Default App',
      'changesFile.reveal': 'Show in File Manager',
      'changesFile.failed': 'Could not open this file in the default application',
      'changesFile.revealFailed': 'Could not show this file in the file manager',
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
      'section.changesFile.title': 'Changed-file right-click menu',
      'section.changesFile.description': 'Right-clicking a file row on the edited-files card opens “Open in Default App”, then the IDEs you have installed (VS Code, Zed, Xcode, IntelliJ IDEA…, with their icons), and finally “Show in File Manager”. All of them run through this plugin’s own POST /flow/open-with host route; switching this off registers no such menu.',
      'section.sendKey.title': '⌘+Enter to send',
      'section.sendKey.description': 'On: ⌘+Enter (Ctrl+Enter on Windows/Linux) sends, Enter starts a new line, ⇧+Enter still breaks the line, and ⇧⌘+Enter keeps the shell’s complementary delivery. Off: the shell’s own pair — Enter sends and ⌘+Enter uses the complementary delivery.',
      'history.file': '[attachment: {name}]',
      'section.history.title': 'Recall sent messages with ↑/↓',
      'section.history.description': 'With an empty draft, ↑/↓ walks the messages this conversation already sent: ↑ older, ↓ newer, and ↓ past the newest restores your draft. A recalled image is pasted back into the draft; a file attachment, whose bytes this plugin cannot read back, stays as one placeholder line you can delete.',
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
     * The icon element one application row wears.
     *
     * The icon route 404s for an id it does not know, so the image hides itself
     * rather than leaving a broken-image glyph in the menu.
     *
     * @param app - one catalog row.
     * @returns the `img` element, or undefined for a row that carries no icon.
     */
    function appIcon(app) {
      if (typeof app?.icon !== 'string' || app.icon === '') return undefined
      return h('img', {
        className: 'flow-app-icon',
        src: app.icon,
        alt: '',
        onError: (event) => {
          const node = event?.currentTarget
          if (node?.style) node.style.display = 'none'
        },
      })
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

      const select = (row) => {
        // Closing first keeps the menu's own dismissal out of the way of
        // whatever this is about to open.
        const { element, text, path } = menu
        store.close()
        if (row.kind === 'copy') {
          copyInlineCode({ text, write: props.write, notify: props.notify, t })
          return
        }
        if (row.kind === 'open') {
          props.openCode({ element, text })
          return
        }
        const refuse = () => { props.notify(t('codeMenu.openFailed'), 'warning') }
        Promise.resolve(props.openCodeApp({ app: row.app.id, path })).then((opened) => {
          if (opened !== true) refuse()
        }, refuse)
      }

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
        codeMenuRows(menu).map((row) => h(
          MenuItemButton,
          {
            key: row.key,
            // An application row wears the Host's icon route for its catalog id.
            icon: row.kind === 'app' ? appIcon(row.app) : undefined,
            onSelect: () => { select(row) },
          },
          row.kind === 'app' ? row.app.label : t(row.labelKey),
        )),
      )
    }

    /**
     * Observe the changed-file menu's one slot.
     *
     * @param store - `createChangesMenuStore()`.
     * @returns the menu on screen, or null.
     */
    function useChangesMenuSnapshot(store) {
      const subscribe = useCallback((listener) => store.subscribe(listener), [store])
      const snapshot = useCallback(() => store.getSnapshot(), [store])
      return useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    /**
     * The changed-file menu itself: 「用默认应用打开」 and 「在文件管理器中显示」.
     *
     * The shell's own `Menu`, for the same reasons the inline-code menu uses it:
     * the keyboard walk, Escape and dismissal on an outside pointerdown are
     * shipped behaviours this feature does not reimplement. The anchor carries
     * the resolved path as a data attribute, so the acceptance script can check
     * the path the live card handed over without launching anything.
     *
     * @param props - the seat, the config form, the opener, and the localized copy.
     */
    function ChangesFileMenu(props) {
      const { store, config, t } = props
      // Every Hook runs before the preference is consulted, so the entry keeps
      // one call order across a toggle.
      const enabled = useConfigValue(config, readChangesFileOpen)
      const menu = useChangesMenuSnapshot(store)
      props.useLocaleRevision()
      const anchorRect = useCallback(
        () => cursorRect(menu?.x ?? 0, menu?.y ?? 0),
        [menu?.x, menu?.y],
      )

      if (!enabled || menu === null) return null

      const choose = (row) => {
        const { path } = menu
        // Closing first keeps the menu's own dismissal out of the way of
        // whatever this is about to open.
        store.close()
        if (row.kind === 'app') {
          props.openFile({ path, app: row.app.id })
          return
        }
        props.openFile({ path, app: row.kind === 'reveal' ? 'reveal' : 'default' })
      }

      return h(
        Menu,
        {
          open: true,
          portal: true,
          autoFocus: true,
          anchor: h('span', { className: 'flow-changes-menu-anchor', 'data-flow-changes-path': menu.path }),
          getAnchorRect: anchorRect,
          onClose: () => { store.close() },
        },
        changesFileRows(menu).map((row) => h(
          MenuItemButton,
          {
            key: row.key,
            // An application row wears the Host's icon route; the generic rows
            // have none, which is what the shipped menu items do.
            icon: row.kind === 'app' ? appIcon(row.app) : undefined,
            onSelect: () => { choose(row) },
          },
          row.kind === 'app' ? row.app.label : t(row.labelKey),
        )),
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
          field: 'changesFileOpen',
          read: readChangesFileOpen,
          title: t('section.changesFile.title'),
          description: t('section.changesFile.description'),
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
        h(SettingsRow, {
          config,
          field: 'composerHistory',
          read: readComposerHistoryEnabled,
          title: t('section.history.title'),
          description: t('section.history.description'),
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
      // Every `ctx.<service>` this file touches has to be declared here: cordis does
      // not hang a namespace on the context for a plugin that never asked. Omitting
      // them is silent — `ctx.remote.workspaceFiles` answers `undefined` (every probe
      // says "unknown" and hands the press back to the shell) and `ctx.sidebarRight`
      // is missing (the press is claimed but nothing opens). Opening a path does not
      // need `ctx.remote.session`: that went through the Session Remote before, and
      // now rides this plugin's own `POST /flow/open-with` route instead.
      inject: [
        'slots',
        'locale',
        'configForms',
        'sessions',
        'conversation',
        'workspaces',
        'shortcuts',
        'remote',
        'remote.workspaceFiles',
        'sidebarRight',
      ],
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
        // A plain-text URL does not look like a link: the shell styles a URL only
        // when markdown made it an anchor, and a user's own message (and other
        // plain runs) stay text. This paints the very tokens the click opens,
        // using the CSS Custom Highlight API — a Range is a paint instruction,
        // not a DOM edit, so React's tree is untouched — and keeps a hand cursor
        // over them. The preference owns it: off means no paint, no cursor and no
        // observer, exactly like the click listener above.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          let observer = null
          let timer = null
          let lastMove = 0
          // The anchor whose inline cursor is currently forced to text, so it can
          // be restored when the pointer leaves its over-captured tail.
          let tailCursorAnchor = null
          const clearTailCursor = () => {
            if (tailCursorAnchor === null) return
            tailCursorAnchor.style?.removeProperty?.('cursor')
            tailCursorAnchor = null
          }
          const paintRoot = () => document.querySelector('[data-slot="conversation.session"]')
            ?? document.querySelector('[data-slot="main.conversation"]')
            ?? document.body
          const schedule = () => {
            if (timer !== null) return
            timer = setTimeout(() => { timer = null; paintTextLinks(paintRoot()) }, 160)
          }
          const onPointerMove = (event) => {
            const now = Date.now()
            if (now - lastMove < 60) return
            lastMove = now
            if (pointerOverTextLink(event)) document.documentElement?.setAttribute(TEXT_LINK_CURSOR_ATTR, 'true')
            else document.documentElement?.removeAttribute(TEXT_LINK_CURSOR_ATTR)
            // An over-captured tail keeps the anchor's own pointer cursor; a text
            // cursor on just that anchor says the tail is ordinary prose.
            const tail = pointerOverLinkTail(event)
            if (tail !== tailCursorAnchor) {
              clearTailCursor()
              if (tail !== null && tail.style !== undefined && tail.style !== null) {
                tail.style.setProperty('cursor', 'text')
                tailCursorAnchor = tail
              }
            }
          }
          let detach = null
          const sync = () => {
            if (!readExternalLinkEnabled(config)) {
              clearTextLinks()
              document.documentElement?.removeAttribute(TEXT_LINK_CURSOR_ATTR)
              detach?.()
              detach = null
              return
            }
            if (detach !== null) return
            paintTextLinks(paintRoot())
            // The conversation element itself is replaced when the shell switches
            // sessions, so the observer must sit on a stable ancestor and let each
            // repaint re-resolve the current conversation root.
            const anchor = document.body ?? document.documentElement
            if (typeof MutationObserver === 'function' && anchor !== null && anchor !== undefined) {
              observer = new MutationObserver(schedule)
              observer.observe(anchor, { childList: true, subtree: true, characterData: true })
            }
            document.addEventListener('pointermove', onPointerMove, true)
            detach = () => {
              if (timer !== null) { clearTimeout(timer); timer = null }
              observer?.disconnect()
              observer = null
              document.removeEventListener('pointermove', onPointerMove, true)
              clearTailCursor()
              clearTextLinks()
              document.documentElement?.removeAttribute(TEXT_LINK_CURSOR_ATTR)
            }
          }
          sync()
          const unsubscribe = config.subscribe(sync)
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
            detach?.()
          }
        }, 'flow: plain-text link rendering')
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
        // A `~/…` directory cannot use the Sidebar preview, which shows files
        // only, so the platform file manager opens it through the same open-with
        // route the menus use. The Host's installed-application catalog is asked
        // once per page and remembered; any failure answers "nothing was opened".
        const resolveApps = createAppsLookup({ fetch: (route, init) => fetch(route, init) })
        const openInFileManager = (absolute) => resolveApps()
          .then((apps) => {
            const app = fileManagerAppOf(apps)
            return app === null ? false : openWithPath({ app, path: absolute, fetch: (route, init) => fetch(route, init) })
          }, () => false)
        // One application row's hand-off: every app, file or directory, rides the
        // plugin's own open-with route, which re-validates the pair. The answer is
        // a boolean, never a throw.
        const openCodeApp = (request) => {
          if (request === null || typeof request !== 'object') return Promise.resolve(false)
          return openWithPath({ app: request.app, path: request.path, fetch: (route, init) => fetch(route, init) })
        }
        // The menu opens on the press and fills in when the catalog lands; the
        // sequence number keeps a late answer off a menu it does not belong to.
        const classifyChangedFileMenu = (target) => {
          resolveApps().then((apps) => {
            const rows = applicationsForKind(catalogApplications(apps, t), 'file')
            changesMenu.mark(target, { apps: rows })
          }, () => {})
        }
        // The context menu labels itself from a probe. Every path-looking code
        // gets the copy-first menu: a directory lists every application the Host
        // has installed, a file lists the IDEs, and a path that is not there stays
        // copy-only. The sequence number keeps a late answer off a menu it does
        // not belong to.
        const classifyCodeMenu = (target, hit) => {
          const plan = inlineCodePlan(hit, hostHome)
          const root = sessionCwd(sessions.getSnapshot(), currentSessionId(sessions.getSnapshot()))
          const resolved = pathTarget(hit.text, hostHome(), root)
          // Nothing to open and nothing path-shaped to probe: copy alone, decided
          // before any round trip.
          if (plan === null && resolved === null) {
            codeMenu.mark(target, { copyOnly: true })
            return
          }
          if (resolved === null) return
          // Copy alone until the answer lands, so no row moves under the pointer.
          codeMenu.mark(target, { path: resolved.absolute, apps: [] })
          const probe = plan.kind === 'home' ? plan.probe : hit.text
          readInlineCodeStat(probe).then((result) => {
            const verdict = statVerdict(result)
            if (verdict !== 'present' && verdict !== 'directory') return undefined
            const kind = verdict === 'directory' ? 'directory' : 'file'
            return resolveApps().then((apps) => {
              codeMenu.mark(target, { path: resolved.absolute, apps: applicationsForKind(catalogApplications(apps, t), kind) })
            })
          }, () => {})
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
              // Turning the feature off also retires a menu it left open, and
              // takes the pointer cursor with it.
              codeMenu.close()
              document.documentElement?.removeAttribute(CODE_CURSOR_ATTR)
              detach?.()
              detach = null
              return
            }
            if (detach !== null) return
            // A press opens or copies, so the cursor says "clickable" while this
            // feature owns the press.
            document.documentElement?.setAttribute(CODE_CURSOR_ATTR, 'true')
            const onContextMenu = (event) => {
              handleCodeContextMenu(event, {
                open: (hit) => { classifyCodeMenu(codeMenu.open(hit), hit) },
              })
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
                openDirectory: openInFileManager,
                copy: (text) => copyInlineCode({ text, write: writeClipboard, notify, t }),
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
            document.documentElement?.removeAttribute(CODE_CURSOR_ATTR)
            detach?.()
          }
        }, 'flow: inline code menu')
        // The changed-file menu: the same shape as the inline-code menu — one
        // capture-phase listener, present only while the preference is on. The
        // catalog it lists is a single shared round trip, so the menu opens on
        // the press and fills its application rows when the answer lands.
        const changesMenu = createChangesMenuStore()
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          let detach = null
          const sync = () => {
            if (!readChangesFileOpen(config)) {
              // Turning the feature off also retires a menu it left open.
              changesMenu.close()
              detach?.()
              detach = null
              return
            }
            if (detach !== null) return
            const onContextMenu = (event) => {
              handleChangesContextMenu(event, {
                open: (hit) => { classifyChangedFileMenu(changesMenu.open(hit)) },
              })
            }
            document.addEventListener('contextmenu', onContextMenu, true)
            detach = () => {
              document.removeEventListener('contextmenu', onContextMenu, true)
            }
          }
          sync()
          const unsubscribe = config.subscribe(sync)
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
            detach?.()
          }
        }, 'flow: changed files menu')
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
        // The recalled sent messages: the same shape as the swapped send key —
        // one capture-phase listener, present only while the preference is on —
        // because the shipped arrows belong to the caret, and this seat only
        // steps in when the caret has nothing to move. The Session event window
        // is the source: it carries the durable user messages the conversation
        // really sent, and an older page is the shell's own pagination.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const currentBinding = () => {
            const sessionId = currentSessionId(sessions.getSnapshot())
            if (sessionId === null) return null
            const binding = ctx.sessions.binding(sessionId)
            if (binding === undefined || binding === null) return null
            return { sessionId, binding }
          }
          const currentInput = () => {
            const current = currentBinding()
            if (current === null) return null
            const scope = ctx.sessions.scope(current.sessionId)
            if (scope === undefined || scope === null) return null
            try {
              return { face: ctx.conversation.input.for(scope) }
            } catch {
              return null
            }
          }
          const readWindow = () => {
            const source = currentBinding()?.binding?.eventSource
            if (source === undefined || source === null || typeof source.getSnapshot !== 'function') return null
            return source.getSnapshot()
          }
          const history = createComposerHistory({
            enabled: () => readComposerHistoryEnabled(config),
            inComposer: (event) => isComposerTarget(event?.target),
            menuOwnsKey: () => document.querySelector(TRIGGER_MENU_PICK) !== null,
            sessionId: () => currentBinding()?.sessionId ?? null,
            draft: () => {
              const current = currentInput()
              if (current === null) return null
              try {
                return String(current.face.state.getSnapshot().draft)
              } catch {
                return null
              }
            },
            setDraft: (text) => {
              const current = currentInput()
              if (current === null) return false
              try {
                current.face.setDraft(text)
                return true
              } catch {
                return false
              }
            },
            messages: () => sentUserMessages(readWindow()?.entries),
            hasMore: () => readWindow()?.hasMore === true,
            loadOlder: () => {
              const session = currentBinding()?.binding?.session
              if (session === undefined || session === null || typeof session.loadOlder !== 'function') return Promise.resolve(false)
              return Promise.resolve(session.loadOlder()).then(() => true, () => false)
            },
            pasteImages: (images) => {
              const current = currentInput()
              const active = typeof document.activeElement?.closest === 'function'
                ? document.activeElement.closest(COMPOSER_INPUT)
                : null
              const session = current?.binding?.session
              if (current === null || !isElement(active) || typeof session?.readAttachment !== 'function') return
              const view = active.ownerDocument?.defaultView ?? globalThis
              const FileCtor = view?.File ?? globalThis.File
              if (typeof FileCtor !== 'function') return
              Promise.all(images.map((image) => Promise.resolve(session.readAttachment(image.attachmentId)).then((result) => {
                if (result === null || typeof result !== 'object' || result.ok !== true || result.data === undefined) return null
                const mediaType = typeof image.mediaType === 'string' && image.mediaType !== '' ? image.mediaType : 'image/png'
                const name = typeof image.name === 'string' && image.name !== '' ? image.name : 'image'
                return new FileCtor([result.data], name, { type: mediaType })
              }, () => null))).then((files) => {
                const usable = files.filter((file) => file !== null)
                if (usable.length === 0) return
                pasteComposerFiles(active, usable, view)
              }, () => {})
            },
            fileLabel: (file) => t('history.file', { name: file?.name ?? '' }),
          })
          let detach = null
          const sync = () => {
            if (!readComposerHistoryEnabled(config)) {
              detach?.()
              detach = null
              return
            }
            if (detach !== null) return
            const onKeyDown = (event) => { history.handle(event) }
            document.addEventListener('keydown', onKeyDown, true)
            detach = () => { document.removeEventListener('keydown', onKeyDown, true) }
          }
          sync()
          const unsubscribe = config.subscribe(sync)
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
            detach?.()
          }
        }, 'flow: recalled messages')
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
            // One application row hands one absolute path to one resolved
            // application; the answer is "opened" or "refused".
            openCodeApp: (request) => openCodeApp(request),
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
                open: (element) => activateInlineCode(element, window),
                openHome: openAtHome,
                openDirectory: openInFileManager,
                notify,
                t,
              })
            },
          }),
        }, CodeMenu)), 'flow: inline code menu overlay')

        // The changed-file menu is a third cell in the same list slot.
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: CHANGES_MENU_ID,
          locale: ENTRY_ID,
          inject: () => ({
            store: changesMenu,
            config,
            notify,
            useLocaleRevision,
            openFile: (hit) => {
              openChangedFile({
                path: hit.path,
                app: hit.app,
                fetch: (route, init) => fetch(route, init),
                notify,
                t,
              })
            },
          }),
        }, ChangesFileMenu)), 'flow: changed files menu overlay')

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
        APPS_ROUTE,
        OPEN_WITH_ROUTE,
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
        anchorLinkOf,
        textLinkOf,
        overcapturedAnchor,
        pointerOverLinkTail,
        linkTokenAt,
        linkTokensIn,
        caretTextAt,
        textLinkRanges,
        linkTailRanges,
        markTrimmedAnchors,
        trimmedUrlRanges,
        paintTextLinks,
        clearTextLinks,
        pointerOverTextLink,
        TEXT_LINK_HIGHLIGHT,
        TEXT_LINK_TAIL_HIGHLIGHT,
        LINK_TRIM_ATTR,
        openExternal,
        handleAnchorClick,
        copyCommand,
        copySessionId,
        createNoticeStore,
        CODE_MENU_ID,
        inlineCodeLink,
        codeMenuTarget,
        clickTargetOf,
        activateInlineCode,
        copyInlineCode,
        handleCodeContextMenu,
        createCodeMenuStore,
        cursorRect,
        readCodeMenuEnabled,
        CHANGES_MENU_ID,
        changedFileTarget,
        describedFilePath,
        handleChangesContextMenu,
        createChangesMenuStore,
        readChangesFileOpen,
        applicationsForKind,
        changesFileRows,
        openChangedFile,
        openWithPath,
        isPlainLeftPress,
        codeOpenTarget,
        shellWiredControl,
        isTildePath,
        expandHomePath,
        fileAddress,
        inlineCodePlan,
        openInlineCodeHit,
        statVerdict,
        fileManagerAppOf,
        catalogApplications,
        createAppsLookup,
        pathTarget,
        sessionCwd,
        codeMenuRows,
        handleInlineCodeClick,
        COMPOSER_INPUT,
        TRIGGER_MENU_PICK,
        isComposerTarget,
        composerEnterRewrite,
        replayComposerEnter,
        createComposerSendKey,
        readModEnterSend,
        sentUserMessages,
        composerHistoryStep,
        historyDraftText,
        pasteComposerFiles,
        createComposerHistory,
        readComposerHistoryEnabled,
      },
    }
  },
})
