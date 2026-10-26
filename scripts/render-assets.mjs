#!/usr/bin/env node
/**
 * Render dsh-flow's documentation assets from source.
 *
 * Three outputs, one run (all hand-drawn diagrams, never screenshots):
 *
 *  - `assets/locate-flow.svg` — the hand-drawn explainer the README shows and
 *    the plugin market uses as the entry image. It is a **diagram, not a
 *    screenshot**: nothing in it comes from a real session, a real workspace, or
 *    a real account, which is exactly why it is safe to publish.
 *  - `assets/code-menu.svg` — the inline-code right-click menu: the press, the
 *    two entries, and the three conditions a press must satisfy before the
 *    feature takes it (see `client.js` `codeMenuTarget`).
 *  - `assets/send-key.svg` — the same Enter chord before and after the send-key
 *    swap, plus what the rewrite does and does not touch;
 *  - `assets/link-open.svg` — the same `http://localhost` click before and after
 *    the plugin, plus the host route's contract (see `index.js` `openRequestHandler`).
 *  - `assets/tab-menu.svg` — the right sidebar's tab strip: the middle-click
 *    close gesture and the pane menu the extension cell adds.
 *  - `assets/workspace-name.svg` — the shipped "Open In…" split button with
 *    and without the Workspace name, plus why the name can live inside that
 *    button at all (the seat writes data-flow-workspace, and the stylesheet
 *    draws it as that button's ::before; see client.js applyWorkspaceName).
 *  - `assets/*.png` — each drawing rasterised at 2x through a headless Chrome,
 *    because several marketplaces and package pages do not render SVG.
 *
 * The drawing is generated from the data below rather than hand-edited in a
 * vector editor, so the three steps it shows can be kept in step with the code:
 * the real chain is *folded group → group overflow → scroll*, and a collapsed
 * sidebar is a refusal rather than a fourth step (see `client.js`
 * `revealSessionRow` / `locateCommand`).
 *
 * Preconditions: Google Chrome at the default macOS path (override with
 * `--chrome`), no running DSH instance and no network.
 * Side effects: writes the two files above; starts and kills one headless Chrome
 * with a throwaway profile it then deletes.
 *
 * Usage:
 *   node scripts/render-assets.mjs
 *   node scripts/render-assets.mjs --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *
 * @module dsh-flow/scripts/render-assets
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf('--' + name)
  return at === -1 ? fallback : argv[at + 1]
}
const chromePath = option('chrome', DEFAULT_CHROME)

const WIDTH = 1200
const HEIGHT = 640
const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif"

const INK = '#1f2329'
const MUTED = '#8a9099'
const LINE = '#e6e8eb'
const PANEL = '#ffffff'
const CANVAS = '#f7f8fa'
const ACCENT = '#2f6feb'
const ACCENT_SOFT = '#e8f0fe'
const RAIL = '#eef0f3'

/** Escape the five characters that would otherwise break the SVG document. */
const esc = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/** One text run. */
const text = (x, y, body, { size = 13, fill = INK, weight = 400, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(body)}</text>`

/** One rounded rectangle. */
const rect = (x, y, w, h, { fill = PANEL, stroke = LINE, radius = 10, width = 1, opacity = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`

/**
 * The IntelliJ platform's *Locate* mark, verbatim
 * (`platform/icons/src/icons/general/locate.svg`, Apache-2.0 — see
 * THIRD-PARTY-NOTICES.md). Drawn as a scaled group so the diagram and the button
 * cannot drift apart.
 */
const locateMark = (x, y, size, fill) =>
  `<g transform="translate(${x} ${y}) scale(${size / 16})">`
  + `<path fill-rule="evenodd" clip-rule="evenodd" fill="${fill}" d="M8.5 5V2.02054C11.4149 2.26101 13.739 4.5851 13.9795 7.5H11C10.7239 7.5 10.5 7.72386 10.5 8C10.5 8.27614 10.7239 8.5 11 8.5H13.9795C13.739 11.4149 11.4149 13.739 8.5 13.9795V11C8.5 10.7239 8.27614 10.5 8 10.5C7.72386 10.5 7.5 10.7239 7.5 11V13.9795C4.5851 13.739 2.26101 11.4149 2.02054 8.5H5C5.27614 8.5 5.5 8.27614 5.5 8C5.5 7.72386 5.27614 7.5 5 7.5H2.02054C2.26101 4.5851 4.5851 2.26101 7.5 2.02054V5C7.5 5.27614 7.72386 5.5 8 5.5C8.27614 5.5 8.5 5.27614 8.5 5ZM1 8C1 4.13401 4.13401 1 8 1C11.866 1 15 4.13401 15 8C15 11.866 11.866 15 8 15C4.13401 15 1 11.866 1 8Z"/>`
  + '</g>'

/** A magnifier — the shipped search control the button sits beside. */
const searchMark = (x, y, size, color) =>
  `<g transform="translate(${x} ${y}) scale(${size / 16})" fill="none" stroke="${color}" stroke-width="1.4">`
  + '<circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4 14 14" stroke-linecap="round"/></g>'

/** A bell — the unread control, to show the button is not at the row's end. */
const bellMark = (x, y, size, color) =>
  `<g transform="translate(${x} ${y}) scale(${size / 16})" fill="none" stroke="${color}" stroke-width="1.4">`
  + '<path d="M4.2 11.2V7.4a3.8 3.8 0 0 1 7.6 0v3.8l1 .9H3.2l1-.9Z"/><path d="M6.8 13.4a1.3 1.3 0 0 0 2.4 0"/></g>'

/** A plain folder — the shipped "Open In…" glyph. */
const folderMark = (x, y, size, color) =>
  `<g transform="translate(${x} ${y}) scale(${size / 16})" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round">`
  + '<path d="M2 4.4h4.2l1.3 1.7H14v6.5H2z"/></g>'

/** The trailing action glyph, drawn as a folder-with-plus. */
const addMark = (x, y, size, color) =>
  `<g transform="translate(${x} ${y}) scale(${size / 16})" fill="none" stroke="${color}" stroke-width="1.4">`
  + '<path d="M2 4.5h4l1.2 1.6H14v6.4H2z"/><path d="M11.5 2.5v4M9.5 4.5h4" stroke-linecap="round"/></g>'

/** A disclosure chevron; `open` points down (expanded group). */
const chevron = (x, y, size, color, open) =>
  `<g transform="translate(${x} ${y}) rotate(${open ? 90 : 0}) scale(${size / 10})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`
  + '<path d="M3 1.5 5.5 4 3 6.5"/></g>'

/** The four stages the plugin actually performs, in the order the code does them. */
const STAGES = [
  {
    step: '①',
    title: '分组折叠',
    caption: '所属工作区分组是折起来的，行根本没渲染',
    action: '点一下 → 展开分组',
    body: 'folded',
  },
  {
    step: '②',
    title: '分组内溢出折叠',
    caption: '分组开着，但当前会话在「还有 7 个」后面',
    action: '自动 → 展开溢出',
    body: 'overflow',
  },
  {
    step: '③',
    title: '滚动 + 高亮',
    caption: '行已渲染，把它滚进视口并闪一下',
    action: "scrollIntoView({block:'nearest'})",
    body: 'revealed',
  },
  {
    step: '④',
    title: '边界：侧栏收起',
    caption: 'rail 没有搜索座位，按钮不在界面上',
    action: '⇧⌘D 明确拒绝并说明原因，不静默无事',
    body: 'rail',
  },
]

/** One mock session row. */
const row = (x, y, w, label, { active = false, faded = false } = {}) => {
  const fill = active ? ACCENT_SOFT : 'none'
  const ink = active ? ACCENT : (faded ? MUTED : INK)
  return rect(x, y, w, 26, { fill, stroke: active ? ACCENT : 'none', radius: 7, width: active ? 1.4 : 0 })
    + `<circle cx="${x + 14}" cy="${y + 13}" r="3.2" fill="${ink}" opacity="${faded ? 0.5 : 0.85}"/>`
    + text(x + 24, y + 17.5, label, { size: 12, fill: ink, weight: active ? 600 : 400 })
}

/** One group header row. */
const groupRow = (x, y, w, label, { open = false, target = false } = {}) => {
  const ink = target ? ACCENT : INK
  return chevron(x + 8, y + 8, 10, ink, open)
    + text(x + 26, y + 17, label, { size: 12, fill: ink, weight: open || target ? 600 : 400 })
    + (target ? `<rect x="${x - 6}" y="${y - 4}" width="${w + 12}" height="30" rx="8" fill="none" stroke="${ACCENT}" stroke-width="1.2" stroke-dasharray="4 3"/>` : '')
}

/** One stage panel body: a mock sidebar in the state that stage describes. */
const panelBody = (kind, x, y, w) => {
  const inner = w - 24
  const ix = x + 12
  if (kind === 'rail') {
    return rect(ix, y, 56, 210, { fill: RAIL, stroke: 'none', radius: 10 })
      + [0, 1, 2, 3].map((i) => rect(ix + 16, y + 16 + i * 34, 24, 24, { fill: '#d9dde3', stroke: 'none', radius: 7 })).join('')
      + rect(ix + 16, y + 170, 24, 24, { fill: '#d9dde3', stroke: 'none', radius: 7 })
      + text(ix + 72, y + 26, '没有会话列表', { size: 12, fill: MUTED })
      + text(ix + 72, y + 46, '（也没有那个按钮）', { size: 12, fill: MUTED })
  }
  if (kind === 'folded') {
    return groupRow(ix, y, inner, '工作区 A', { open: false })
      + groupRow(ix, y + 38, inner, '工作区 B', { open: false, target: true })
      + groupRow(ix, y + 76, inner, '工作区 C', { open: false })
      + rect(ix - 4, y + 104, inner + 8, 106, { fill: 'none', stroke: LINE, radius: 10 })
      + text(ix + 8, y + 128, '分组折叠 = 组内一行都不渲染', { size: 11, fill: MUTED })
      + text(ix + 8, y + 152, 'scrollIntoView 无从下手', { size: 11, fill: MUTED })
      + text(ix + 8, y + 182, '所以必须先点开它', { size: 11, fill: ACCENT, weight: 600 })
  }
  if (kind === 'overflow') {
    return groupRow(ix, y, inner, '工作区 B', { open: true, target: true })
      + row(ix + 12, y + 34, inner - 12, '更早的会话')
      + row(ix + 12, y + 64, inner - 12, '更早的会话')
      + rect(ix + 12, y + 94, inner - 12, 24, { fill: 'none', stroke: LINE, radius: 7 })
      + text(ix + 22, y + 110, '还有 7 个', { size: 12, fill: MUTED })
      + rect(ix - 4, y + 132, inner + 8, 78, { fill: 'none', stroke: LINE, radius: 10 })
      + text(ix + 8, y + 156, '当前会话在折叠的尾部里', { size: 11, fill: MUTED })
      + text(ix + 8, y + 180, 'overflow 行被点开即可', { size: 11, fill: ACCENT, weight: 600 })
  }
  return groupRow(ix, y, inner, '工作区 B', { open: true, target: true })
    + row(ix + 12, y + 34, inner - 12, '更早的会话', { faded: true })
    + row(ix + 12, y + 64, inner - 12, '更早的会话', { faded: true })
    + row(ix + 12, y + 94, inner - 12, '当前会话', { active: true })
    + text(ix + 12, y + 142, '滚进视口 + 闪一下', { size: 11, fill: ACCENT, weight: 600 })
    + text(ix + 12, y + 162, '状态文本：已定位到当前会话', { size: 11, fill: MUTED })
}

/** The whole drawing. */
function drawing() {
  const parts = []
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${CANVAS}"/>`)

  // Title + keycap.
  parts.push(text(28, 44, '⇧⌘D 定位当前会话', { size: 22, weight: 600 }))
  parts.push(text(28, 68, '一次拆掉挡住它的折叠，再滚回你正在聊的那一行（示意图，非截图）', { size: 13, fill: MUTED }))
  const capW = 118
  parts.push(rect(WIDTH - 28 - capW, 26, capW, 44, { fill: PANEL, radius: 10 }))
  parts.push(text(WIDTH - 28 - capW + capW / 2, 54, '⇧ ⌘ D', { size: 17, weight: 600, anchor: 'middle' }))

  // Where the button lives: the shipped section header, with our seat boxed.
  // The icons are right-aligned in the same order the shell renders them
  // (search → our button → bell → add), so the seat reads as "beside search,
  // not at the end of the row".
  const hx = 28
  const hy = 92
  const hw = WIDTH - 56
  parts.push(rect(hx, hy, hw, 60, { radius: 12 }))
  parts.push(text(hx + 18, hy + 36, '工作区', { size: 14, weight: 600 }))
  parts.push(text(hx + 78, hy + 36, '← 我们的按钮落在搜索右侧（标题行不是 slot，靠 portal 注入）', { size: 11, fill: ACCENT, weight: 600 }))
  const iconY = hy + 22
  parts.push(addMark(hx + hw - 46, iconY, 16, MUTED))
  parts.push(bellMark(hx + hw - 104, iconY, 16, MUTED))
  parts.push(rect(hx + hw - 168, hy + 12, 36, 36, { fill: ACCENT_SOFT, stroke: ACCENT, radius: 9, width: 1.4 }))
  parts.push(locateMark(hx + hw - 158, iconY, 16, ACCENT))
  parts.push(searchMark(hx + hw - 210, iconY, 16, MUTED))

  // Four stages.
  const gap = 20
  const pw = (hw - gap * 3) / 4
  STAGES.forEach((stage, index) => {
    const px = hx + index * (pw + gap)
    const py = 176
    const ph = 424
    parts.push(rect(px, py, pw, ph, { radius: 12 }))
    parts.push(text(px + 16, py + 30, stage.step + ' ' + stage.title, { size: 14, weight: 600 }))
    parts.push(rect(px + 12, py + 44, pw - 24, 210, { fill: '#fbfcfd', stroke: 'none', radius: 10 }))
    parts.push(panelBody(stage.body, px + 12, py + 56, pw - 24))
    parts.push(text(px + 16, py + 288, stage.caption, { size: 12, fill: MUTED }))
    parts.push(rect(px + 12, py + ph - 84, pw - 24, 64, { fill: ACCENT_SOFT, stroke: 'none', radius: 10 }))
    parts.push(text(px + 24, py + ph - 56, stage.action, { size: 12, fill: ACCENT, weight: 600 }))
    if (index < STAGES.length - 1) {
      parts.push(text(px + pw + gap / 2, py + 152, '→', { size: 16, fill: MUTED, anchor: 'middle' }))
    }
  })

  parts.push(text(28, HEIGHT - 16, '三层折叠 = 侧栏 rail / 工作区分组 / 分组内溢出；前两层与「滚动」按顺序自动完成，rail 是明确拒绝而不是第四步。', { size: 11, fill: MUTED }))
  parts.push(text(WIDTH - 28, HEIGHT - 16, '图标：IntelliJ platform general/locate.svg (Apache-2.0)', { size: 11, fill: MUTED, anchor: 'end' }))

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="dsh-flow：⇧⌘D 定位当前会话的三步流程与 rail 边界">`
    + parts.join('') + '</svg>\n'
}

/** One inline-code chip, optionally ringed as the pressed target. */
const chip = (x, y, w, label, hot) => rect(x, y - 14, w, 24, { fill: '#f1f2f4', stroke: 'none', radius: 5 })
  + '<text x="' + (x + 7) + '" y="' + (y + 3) + '" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12.5" fill="' + INK + '">' + esc(label) + '</text>'
  + (hot
    ? '<rect x="' + (x - 4) + '" y="' + (y - 18) + '" width="' + (w + 8) + '" height="32" rx="8" fill="none" stroke="' + ACCENT + '" stroke-width="1.2" stroke-dasharray="4 3"/>'
    : '')

/** The shell-style menu surface the right-click opens. */
const menuSurface = (x, y, items) => rect(x, y, 190, 12 + items.length * 32, { radius: 10 })
  + items.map((item, index) => {
    const iy = y + 6 + index * 32
    return rect(x + 6, iy, 178, 28, { fill: index === 0 ? '#f2f3f5' : 'none', stroke: 'none', radius: 7 })
      + text(x + 16, iy + 19, item.label, { size: 13 })
      + (item.hint ? text(x + 180, iy + 19, item.hint, { size: 12, fill: MUTED, anchor: 'end' }) : '')
  }).join('')

/** A window frame; `kind` picks the shell-internal window or a real browser. */
const frame = (x, y, w, h, kind) => {
  const bar = rect(x, y, w, 30, { fill: kind === 'browser' ? '#eef1f5' : '#f4f5f7', stroke: 'none', radius: 10 })
  const dots = [0, 1, 2].map((i) => '<circle cx="' + (x + 16 + i * 12) + '" cy="' + (y + 15) + '" r="3" fill="#d3d7dd"/>').join('')
  const body = rect(x, y + 30, w, h - 30, { fill: '#ffffff', stroke: 'none', radius: 0 })
  const outline = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="10" fill="none" stroke="' + LINE + '"/>'
  const label = kind === 'browser'
    ? text(x + w - 12, y + 21, '系统默认浏览器', { size: 11, fill: MUTED, anchor: 'end' })
    : text(x + w - 12, y + 21, '壳的内置窗口', { size: 11, fill: MUTED, anchor: 'end' })
  return bar + body + dots + label + outline
}

/**
 * The inline-code menu explainer: what a right-click opens, what each entry does,
 * and what the feature deliberately refuses to touch.
 *
 * @returns the SVG document.
 */
function codeMenuDrawing() {
  const parts = []
  parts.push('<rect width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + CANVAS + '"/>')
  parts.push(text(28, 44, '行内代码右键菜单：复制 + 本机打开方式', { size: 22, weight: 600 }))
  parts.push(text(28, 68, '想复制代码里的路径时，不用再怕手一抖把文件点开（示意图，非截图）', { size: 13, fill: MUTED }))
  const capW = 108
  parts.push(rect(WIDTH - 28 - capW, 26, capW, 44, { fill: PANEL, radius: 10 }))
  parts.push(text(WIDTH - 28 - capW / 2 - 54, 54, '右键 · 两项', { size: 15, weight: 600, anchor: 'middle' }))

  // A: the press itself, on a mock transcript line.
  const ax = 28
  const ay = 100
  const aw = 560
  const ah = 296
  parts.push(rect(ax, ay, aw, ah, { radius: 12 }))
  parts.push(text(ax + 20, ay + 32, '对话正文', { size: 13, weight: 600 }))
  parts.push(text(ax + 20, ay + 58, '把仓库放到本机任意位置，然后', { size: 13 }))
  parts.push(chip(ax + 240, ay + 54, 168, '~/dsh-external-link', true))
  parts.push(text(ax + 416, ay + 58, '就是宿主半边。', { size: 13 }))
  // the press marker
  parts.push('<path d="M' + (ax + 404) + ' ' + (ay + 66) + ' l0 16 l4 -4 l3 7 l3 -1 l-3 -7 l6 -1 z" fill="' + INK + '"/>')
  parts.push(menuSurface(ax + 300, ay + 96, [{ label: '复制', hint: '⌘C' }, { label: '访达' }, { label: 'VS Code' }]))
  parts.push(text(ax + 20, ay + 250, '菜单浮在光标处，用壳自己的 Menu 组件', { size: 11, fill: MUTED }))
  parts.push(text(ax + 20, ay + 270, '↑↓/Home/End 移动 · ↵ 执行 · Esc 或点外面关闭', { size: 11, fill: MUTED }))

  // B: what the two entries do.
  const bx = 604
  const bw = 568
  parts.push(rect(bx, ay, bw, ah, { radius: 12 }))
  parts.push(text(bx + 20, ay + 32, '菜单里有什么', { size: 13, weight: 600 }))
  parts.push(rect(bx + 16, ay + 48, bw - 32, 96, { fill: '#fbfcfd', stroke: 'none', radius: 10 }))
  parts.push(text(bx + 32, ay + 76, '打开方式', { size: 13, weight: 600, fill: ACCENT }))
  parts.push(text(bx + 32, ay + 98, '是路径的代码：复制在最上，下面接这条路径能用的应用，各带图标；', { size: 12 }))
  parts.push(text(bx + 32, ay + 118, '不是路径的代码：仍是「打开 / 复制」，打开走壳自己那条链路。', { size: 12 }))
  parts.push(rect(bx + 16, ay + 156, bw - 32, 96, { fill: '#fbfcfd', stroke: 'none', radius: 10 }))
  parts.push(text(bx + 32, ay + 184, '复制', { size: 13, weight: 600, fill: ACCENT }))
  parts.push(text(bx + 32, ay + 206, '把这段代码的原文写进剪贴板，成功或失败都有顶部横幅。', { size: 12 }))
  parts.push(text(bx + 32, ay + 226, '剪贴板拒绝写入时如实报失败，不静默。', { size: 12 }))

  // C: the boundary.
  const cy = 424
  parts.push(rect(ax, cy, WIDTH - 56, 168, { radius: 12 }))
  parts.push(text(ax + 20, cy + 32, '命中条件（三条同时成立才接管这次右键）', { size: 13, weight: 600 }))
  parts.push(text(ax + 20, cy + 58, '① 目标在 <code> 内，且祖先含 _markdown_（正文渲染出来的行内代码）', { size: 12 }))
  parts.push(text(ax + 20, cy + 80, '② 不在 pre（多行代码块）/ [contenteditable]（输入框与快捷键编辑器）/ <a href>（链接另有归属）里', { size: 12 }))
  parts.push(text(ax + 20, cy + 102, '③ 文本去掉空白后非空', { size: 12 }))
  parts.push(rect(ax + 16, cy + 118, WIDTH - 88, 34, { fill: ACCENT_SOFT, stroke: 'none', radius: 9 }))
  parts.push(text(ax + 32, cy + 140, '只监听 contextmenu；左键只接管「路径不存在」与 ~/… 家目录两种，其余照旧。', { size: 12, fill: ACCENT, weight: 600 }))
  parts.push(text(28, HEIGHT - 16, '单击基本照旧：路径不存在、或 ~/… 家目录路径时才接管。是路径的代码右键给「复制 + 打开方式」：目录列全部应用，文件只列 IDE。', { size: 11, fill: MUTED }))

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" role="img" aria-label="dsh-flow：行内代码右键菜单的命中条件与打开方式">'
    + parts.join('') + '</svg>\n'
}

/**
 * The link-destination explainer: the same `http://localhost` click, before and
 * after the plugin, plus the host route contract that makes it possible.
 *
 * @returns the SVG document.
 */
function linkDrawing() {
  const parts = []
  parts.push('<rect width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + CANVAS + '"/>')
  parts.push(text(28, 44, '点链接：交给系统默认程序', { size: 22, weight: 600 }))
  parts.push(text(28, 68, '重点是 http://localhost —— 壳本来会把它开进一个内置窗口（示意图，非截图）', { size: 13, fill: MUTED }))
  const capW = 118
  parts.push(rect(WIDTH - 28 - capW, 26, capW, 44, { fill: PANEL, radius: 10 }))
  parts.push(text(WIDTH - 28 - capW / 2, 54, '零配置', { size: 15, weight: 600, anchor: 'middle' }))
  const py = 104
  const ph = 300
  const pw = 520
  // before
  parts.push(rect(28, py, pw, ph, { radius: 12 }))
  parts.push(text(48, py + 32, '壳默认：内置窗口', { size: 14, weight: 600, fill: MUTED }))
  parts.push(chip(48, py + 68, 208, 'http://localhost:5173', false))
  parts.push(frame(48, py + 92, pw - 40, 176, 'inapp'))
  parts.push(text(64, py + 146, '光秃秃的一个窗口', { size: 12, fill: MUTED }))
  parts.push(text(64, py + 168, '没有标签页、没有扩展、没有登录态', { size: 12, fill: MUTED }))
  // arrow
  parts.push(text(568, py + 150, '→', { size: 22, fill: MUTED, anchor: 'middle' }))
  parts.push(text(568, py + 174, '宿主', { size: 11, fill: MUTED, anchor: 'middle' }))
  // after
  parts.push(rect(652, py, pw, ph, { radius: 12 }))
  parts.push(text(672, py + 32, '装了本插件：系统默认程序', { size: 14, weight: 600, fill: ACCENT }))
  parts.push(chip(672, py + 68, 208, 'http://localhost:5173', true))
  parts.push(frame(672, py + 92, pw - 40, 176, 'browser'))
  parts.push(text(688, py + 146, '你平时那个浏览器', { size: 12, fill: MUTED }))
  parts.push(text(688, py + 168, '标签页、扩展、登录态都在', { size: 12, fill: MUTED }))
  // contract
  const cy = 428
  parts.push(rect(28, cy, WIDTH - 56, 164, { radius: 12 }))
  parts.push(text(48, cy + 32, '宿主路由 POST /flow/open-external 的边界', { size: 13, weight: 600 }))
  parts.push(text(48, cy + 58, '只放行 http / https / mailto / tel；未认证 401；只接受 POST（405）；请求体 16KB（413）；URL ≤ 8192（400）', { size: 12 }))
  parts.push(text(48, cy + 80, '只把 new URL() 解析后的 href 交给打开器（macOS open / Windows start / Linux xdg-open），原始字符串不进程命令行', { size: 12 }))
  parts.push(text(48, cy + 102, '同源链接、其它协议（file: / javascript: / data: / 相对路径）一律放行，应用内跳转照旧', { size: 12 }))
  parts.push(rect(44, cy + 118, WIDTH - 88, 32, { fill: ACCENT_SOFT, stroke: 'none', radius: 9 }))
  parts.push(text(60, cy + 139, '宿主答不了（旧版宿主 / 路由不可用）时，点击回退到页面自己的 window.open —— 不会变成「点了没反应」。', { size: 12, fill: ACCENT, weight: 600 }))
  parts.push(text(28, HEIGHT - 16, '插件自身不访问外部网络；唯一副作用是把一个 URL 交给操作系统的默认程序。', { size: 11, fill: MUTED }))

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" role="img" aria-label="dsh-flow：点链接交给系统默认程序（含 localhost）与宿主路由边界">'
    + parts.join('') + '</svg>\n'
}
/**
 * The send-key explainer: the same two keys before and after the switch, plus
 * what the plugin does and does not touch.
 *
 * @returns the SVG document.
 */
function sendKeyDrawing() {
  const parts = []
  parts.push('<rect width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + CANVAS + '"/>')
  parts.push(text(28, 44, '发送键对调：Enter 换行，⌘/Ctrl+Enter 发送', { size: 22, weight: 600 }))
  parts.push(text(28, 68, '官方那一对键上下互换；只在对话输入框里生效（示意图，非截图）', { size: 13, fill: MUTED }))
  const capW = 208
  parts.push(rect(WIDTH - 28 - capW, 26, capW, 44, { fill: PANEL, radius: 10 }))
  parts.push(text(WIDTH - 28 - capW / 2, 54, '心流 → ⌘+Enter 发送', { size: 14, weight: 600, anchor: 'middle' }))
  /** One keycap, an arrow, and where the press goes. */
  const keyRow = (x, y, keys, result, hot) => {
    const out = []
    out.push(rect(x, y - 17, 150, 32, { fill: hot ? ACCENT_SOFT : '#f1f2f4', stroke: 'none', radius: 7 }))
    out.push(text(x + 75, y + 4, keys, { size: 13, weight: 600, fill: hot ? ACCENT : INK, anchor: 'middle' }))
    out.push(text(x + 172, y + 4, '→', { size: 15, fill: MUTED, anchor: 'middle' }))
    out.push(text(x + 196, y + 4, result, { size: 13, fill: hot ? ACCENT : INK, weight: hot ? 600 : 400 }))
    return out
  }
  const py = 104
  const ph = 300
  const pw = 520
  // before: the shipped pair
  parts.push(rect(28, py, pw, ph, { radius: 12 }))
  parts.push(text(48, py + 32, '开关关（官方行为）', { size: 14, weight: 600, fill: MUTED }))
  parts.push(text(48, py + 56, 'Enter 发送、Shift+Enter 换行', { size: 12, fill: MUTED }))
  parts.push(...keyRow(48, py + 108, 'Enter', '发送', false))
  parts.push(...keyRow(48, py + 156, '⇧Enter', '换行', false))
  parts.push(...keyRow(48, py + 204, '⌘/Ctrl+Enter', '另一种发送方式', false))
  parts.push(text(48, py + 252, '智能体运行时 Queue／Steer 的另一档，由官方设置决定', { size: 11, fill: MUTED }))
  // arrow between the panels
  parts.push(text(568, py + 150, '→', { size: 22, fill: MUTED, anchor: 'middle' }))
  parts.push(text(568, py + 174, '开关打开', { size: 11, fill: MUTED, anchor: 'middle' }))
  // after: the swapped pair
  parts.push(rect(652, py, pw, ph, { radius: 12 }))
  parts.push(text(672, py + 32, '开关开：写消息时 Enter 只换行', { size: 14, weight: 600, fill: ACCENT }))
  parts.push(text(672, py + 56, '⌘+Enter 发送，⇧Enter 仍是换行', { size: 12, fill: MUTED }))
  parts.push(...keyRow(672, py + 108, 'Enter', '换行', true))
  parts.push(...keyRow(672, py + 156, '⇧Enter', '换行', true))
  parts.push(...keyRow(672, py + 204, '⌘/Ctrl+Enter', '发送', true))
  parts.push(text(672, py + 252, '⇧⌘/Ctrl+Enter 保留官方的「另一种发送方式」', { size: 11, fill: MUTED }))
  // the contract strip
  const cy = 428
  parts.push(rect(28, cy, WIDTH - 56, 164, { radius: 12 }))
  parts.push(text(48, cy + 32, '实现边界：换的是「按下的那个键」，不是改写输入框', { size: 13, weight: 600 }))
  parts.push(text(48, cy + 58, '捕获阶段拿走这一下按键，再对着同一个输入框补发官方本来就认的另一个手势 → 提交判定、撤销历史、输入法记账仍是官方那一套', { size: 12 }))
  parts.push(text(48, cy + 80, '一律放行：目标不在输入框内、输入法组字中、⌥ 组合、以及 / 或 @ 菜单正有高亮候选（那一下 Enter 是「选中」）', { size: 12 }))
  parts.push(text(48, cy + 102, '官方快捷键表里那 11 行只读项一个都不动（发送／换行在官方设置页仍是不可改）；开关关闭时连监听都不注册', { size: 12 }))
  parts.push(rect(44, cy + 118, WIDTH - 88, 32, { fill: ACCENT_SOFT, stroke: 'none', radius: 9 }))
  parts.push(text(60, cy + 139, '开关默认关：没打开过它的人拿到的就是官方行为；想用就在 设置 → 心流 → 「⌘+Enter 发送」里打开。', { size: 12, fill: ACCENT, weight: 600 }))
  parts.push(text(28, HEIGHT - 16, '本插件不写你的草稿内容、不碰提交链路；唯一的副作用是把一个键盘手势换成官方认的另一个。', { size: 11, fill: MUTED }))

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" role="img" aria-label="dsh-flow：Enter 与 Cmd/Ctrl+Enter 发送键对调，以及实现边界">'
    + parts.join('') + '</svg>\n'
}

/**
 * The shipped "Open In…" split button, at the proportions the real one has.
 *
 * The Workspace name is not a second control: when there is one, it is drawn
 * inside the main half, which is exactly where the stylesheet renders it (the
 * ::before of the button that carries data-flow-workspace). The pill is
 * right-aligned in the header, so a name can only make it grow to the left —
 * the icon never moves (measured 0px shift on a live instance).
 *
 * @param x - left edge of the pill.
 * @param y - top edge of the pill.
 * @param name - the name drawn inside the main half, or '' for the shipped pill.
 * @returns SVG fragments for one pill.
 */
function splitPill(x, y, name) {
  const out = []
  const nameW = name === '' ? 0 : Math.min(name.length * 12.5, 140)
  const mainW = 34 + nameW
  const totalW = mainW + 26
  out.push(rect(x, y, totalW, 24, { fill: '#f4f5f7', stroke: LINE, radius: 8 }))
  if (nameW > 0) out.push(text(x + 11, y + 16, name, { size: 12, fill: ACCENT, weight: 500 }))
  out.push(folderMark(x + 11 + nameW, y + 5, 14, INK))
  out.push('<line x1="' + (x + mainW) + '" y1="' + (y + 5) + '" x2="' + (x + mainW) + '" y2="' + (y + 19) + '" stroke="' + LINE + '"/>')
  out.push(chevron(x + mainW + 8, y + 7, 10, MUTED, true))
  return out
}

/**
 * The header row the button lives in: the search control, the plugin's locate
 * button, then the shipped split button, right-aligned.
 *
 * @param x - left edge of the row.
 * @param y - vertical centre of the row.
 * @param name - the Workspace name drawn inside the split button, or ''.
 * @param named - whether this row is meant to show a name.
 * @returns SVG fragments for one header row.
 */
function headerRow(x, y, name, named) {
  const out = []
  const w = 470
  out.push(rect(x, y - 24, w, 48, { fill: PANEL, radius: 10 }))
  out.push(searchMark(x + 16, y - 8, 16, MUTED))
  out.push(locateMark(x + 46, y - 8, 16, named ? ACCENT : MUTED))
  const nameW = name === '' ? 0 : Math.min(name.length * 12.5, 140)
  const pillW = 34 + nameW + 26
  out.push(...splitPill(x + w - 16 - pillW, y - 12, name))
  if (named) out.push(text(x + w - 16 - pillW + 11, y - 18, '名字写在这里', { size: 10, fill: ACCENT }))
  return out
}

/**
 * The Workspace name inside the shipped "Open In…" button.
 *
 * Two states side by side (shipped pill vs. pill with a name), then why the name
 * can live inside the button at all. The name shown is a placeholder: this file
 * must stay free of any real workspace, project or session.
 */
function workspaceNameDrawing() {
  const parts = []
  parts.push('<rect width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + CANVAS + '"/>')
  parts.push(text(28, 44, '工作区名写进「打开」按钮：点名字 = 点图标', { size: 22, weight: 600 }))
  parts.push(text(28, 68, '名字是那颗按钮自己的一部分，不是旁边多出来的控件（示意图，非截图）', { size: 13, fill: MUTED }))
  const capW = 316
  parts.push(rect(WIDTH - 28 - capW, 26, capW, 44, { fill: PANEL, radius: 10 }))
  parts.push(text(WIDTH - 28 - capW / 2, 54, '心流 → 在「打开」按钮里显示当前工作区名', { size: 13, weight: 600, anchor: 'middle' }))
  const py = 104
  const ph = 300
  const pw = 520
  parts.push(rect(28, py, pw, ph, { radius: 12 }))
  parts.push(text(48, py + 32, '没有名字时（或「未分组」的会话）', { size: 14, weight: 600, fill: MUTED }))
  parts.push(text(48, py + 56, '按钮保持出厂样子：图标 + 下拉箭头', { size: 12, fill: MUTED }))
  parts.push(...headerRow(48, py + 128, '', false))
  parts.push(text(48, py + 196, '会话标题行右侧，右对齐', { size: 11, fill: MUTED }))
  parts.push(text(48, py + 224, '同一个槽：搜索控件、插件的定位按钮、官方那颗「打开」按钮', { size: 11, fill: MUTED }))
  parts.push(text(48, py + 252, '名字取不到就不写属性 —— 不猜、也不放占位文案', { size: 11, fill: MUTED }))
  parts.push(text(568, py + 150, '→', { size: 22, fill: MUTED, anchor: 'middle' }))
  parts.push(text(568, py + 174, '有归属工作区', { size: 11, fill: MUTED, anchor: 'middle' }))
  parts.push(rect(652, py, pw, ph, { radius: 12 }))
  parts.push(text(672, py + 32, '现在：图标左边就是当前工作区名', { size: 14, weight: 600, fill: ACCENT }))
  parts.push(text(672, py + 56, '侧栏分组行那个名字（工作区自己的标题）', { size: 12, fill: MUTED }))
  parts.push(...headerRow(672, py + 128, '示例工作区', true))
  parts.push(rect(672, py + 176, pw - 40, 34, { fill: ACCENT_SOFT, stroke: 'none', radius: 9 }))
  parts.push(text(690, py + 198, '点名字 = 点图标：同一个按钮、同一条激活路径', { size: 12, fill: ACCENT, weight: 600 }))
  parts.push(text(672, py + 236, '药丸往左长，图标不挪位；名字最长 140px 后以 … 收尾', { size: 11, fill: MUTED }))
  const cy = 428
  parts.push(rect(28, cy, WIDTH - 56, 164, { radius: 12 }))
  parts.push(text(48, cy + 32, '名字怎么进去的：座位写一个属性，样式表把它画出来', { size: 13, weight: 600 }))
  parts.push(text(48, cy + 58, '座位注册在 conversation.session.header.utilities，它把名字写成官方主按钮的 data-flow-workspace，样式表用 ::before 显示', { size: 12 }))
  parts.push(text(48, cy + 80, '不插节点、不改按钮行为 → 药丸的 padding、圆角、hover 底色、图标位置全部照旧；官方换掉按钮时由 childList 观察重新写上', { size: 12 }))
  parts.push(text(48, cy + 102, '没有归属工作区就不写属性；开关默认开（设置 → 心流 第 8 行），关掉时把属性摘掉，按钮立刻回到出厂样子', { size: 12 }))
  parts.push(rect(44, cy + 118, WIDTH - 88, 32, { fill: ACCENT_SOFT, stroke: 'none', radius: 9 }))
  parts.push(text(60, cy + 139, '脆弱点只有一处：[data-open-target="directory"] button（数据属性；旁边的 class 是构建哈希）——官方改形状时症状只是「名字不见了」，不报错。', { size: 12, fill: ACCENT, weight: 600 }))
  parts.push(text(28, HEIGHT - 16, '本插件不读工作区内容、不改那颗按钮的行为；唯一的副作用是往官方按钮上写一个属性。', { size: 11, fill: MUTED }))

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" role="img" aria-label="dsh-flow：把当前工作区名写进「打开」按钮，以及它的实现边界">'
    + parts.join('') + '</svg>\n'
}


/**
 * Rasterise one local file through a throwaway headless Chrome.
 *
 * Chrome writes the screenshot and then, on this platform, sometimes keeps the
 * process alive instead of exiting; waiting only on `exit` hung a real run. So
 * the wait is bounded by the screenshot appearing on disk, and the process is
 * killed either way. Two things this has to get right, both learned by running
 * it: the destination is **deleted first**, or a PNG from an earlier run
 * satisfies the wait before Chrome has written anything and the stale image
 * ships; and the profile removal is **retried after the process is gone**,
 * because a bare `rmSync` right after the kill loses the race and throws
 * `ENOTEMPTY` out of a run that had already produced every asset.
 *
 * @param svgPath - the SVG source to render.
 * @param pngPath - destination PNG.
 */
async function rasterise(svgPath, pngPath) {
  rmSync(pngPath, { force: true })
  const profile = mkdtempSync(join(tmpdir(), 'dsh-flow-assets-'))
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--virtual-time-budget=3000',
    `--window-size=${WIDTH},${HEIGHT}`,
    '--force-device-scale-factor=2',
    `--user-data-dir=${profile}`,
    `--screenshot=${pngPath}`,
    `file://${svgPath}`,
  ], { stdio: 'ignore' })
  try {
    const deadline = Date.now() + 30000
    for (;;) {
      if (existsSync(pngPath) && statSync(pngPath).size > 0) break
      if (chrome.exitCode !== null) throw new Error('headless Chrome exited with ' + String(chrome.exitCode))
      if (Date.now() > deadline) throw new Error('headless Chrome produced no screenshot within 30s')
      await new Promise((done) => setTimeout(done, 200))
    }
  } finally {
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
    const exited = Date.now() + 10000
    while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < exited) {
      await new Promise((done) => setTimeout(done, 100))
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true })
        break
      } catch {
        await new Promise((done) => setTimeout(done, 200))
      }
    }
  }
}

/**
 * The Otty row inserted into the shipped "Open In…" menu.
 *
 * One menu card whose last row is the one this plugin adds, beside the header
 * control that opens it. The menu rows are drawn as placeholder labels — this
 * file must stay free of any real application set, workspace or session.
 *
 * @returns SVG source.
 */
function ottyDrawing() {
  const parts = []
  parts.push('<rect width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + CANVAS + '"/>')
  parts.push(text(28, 44, '在官方「打开」菜单里加一行 Otty', { size: 22, weight: 600 }))
  parts.push(text(28, 68, '官方目录是编译期写死的、插件注册不进去 → 这一行是本插件在菜单打开时插进去的（示意图，非截图）', { size: 13, fill: MUTED }))
  const capW = 300
  parts.push(rect(WIDTH - 28 - capW, 26, capW, 44, { fill: PANEL, radius: 10 }))
  parts.push(text(WIDTH - 28 - capW / 2, 54, '心流 → 在「打开」菜单里加入 Otty', { size: 13, weight: 600, anchor: 'middle' }))

  // Left: the one header control whose menu this plugin extends.
  const py = 104
  const ph = 300
  const pw = 520
  parts.push(rect(28, py, pw, ph, { radius: 12 }))
  parts.push(text(48, py + 32, '① 会话标题行右侧那颗「打开」按钮', { size: 14, weight: 600 }))
  parts.push(text(48, py + 56, '只有这一颗的下拉菜单是本插件认的（侧栏 Files 页那颗形状相同，但不碰）', { size: 12, fill: MUTED }))
  parts.push(...headerRow(48, py + 140, '', false))
  parts.push(text(48, py + 208, '点右边那个小箭头 → 官方菜单浮出', { size: 12, fill: MUTED }))
  parts.push(rect(48, py + 228, pw - 40, 48, { fill: ACCENT_SOFT, stroke: 'none', radius: 9 }))
  parts.push(text(64, py + 249, '插件在捕获阶段认领这一下，并且只认标题行那颗：', { size: 12, fill: ACCENT, weight: 600 }))
  parts.push(text(64, py + 267, '按下之后第一个出现的菜单，就是它要扩展的那一个', { size: 12, fill: ACCENT }))

  // Right: the menu, with the inserted row last.
  const mx = 596
  const mw = WIDTH - 28 - mx
  parts.push(rect(mx, py, mw, ph, { radius: 12 }))
  parts.push(text(mx + 20, py + 32, '② 菜单最后多一行 Otty', { size: 14, weight: 600 }))
  parts.push(text(mx + 20, py + 56, '样式从同菜单的兄弟行现抄；键盘 ↑/↓ 也能走到它', { size: 12, fill: MUTED }))
  const rows = [
    { label: '访达（默认）', active: false },
    { label: 'Zed', active: false },
    { label: 'iTerm2', active: false },
    { label: '终端', active: false },
    { label: 'Otty', active: true },
  ]
  let ry = py + 78
  for (const entry of rows) {
    parts.push(rect(mx + 20, ry, mw - 40, 34, { fill: entry.active ? ACCENT_SOFT : PANEL, stroke: entry.active ? ACCENT : LINE, radius: 9, width: entry.active ? 1.4 : 1 }))
    parts.push(rect(mx + 32, ry + 9, 16, 16, { fill: entry.active ? ACCENT : MUTED, stroke: 'none', radius: 4 }))
    parts.push(text(mx + 58, ry + 22, entry.label, { size: 12.5, fill: entry.active ? ACCENT : INK, weight: entry.active ? 600 : 400 }))
    if (entry.active) parts.push(text(mx + mw - 32, ry + 22, '← 插件插入', { size: 11, fill: ACCENT, weight: 600, anchor: 'end' }))
    ry += 40
  }

  // Bottom: where the row comes from, and when it is there at all.
  const cy = 428
  parts.push(rect(28, cy, WIDTH - 56, 164, { radius: 12 }))
  parts.push(text(48, cy + 32, '这一行怎么来、什么时候在', { size: 13, weight: 600 }))
  parts.push(text(48, cy + 58, '宿主新增 GET /flow/app-icon/<id>：从 .app 里 plutil + sips 提出 128px PNG，未知 id / 非 macOS 返 404（img 自己吸收）', { size: 12 }))
  parts.push(text(48, cy + 80, 'Otty 的启动走它自己的 otty-cli open <目录>：点了会真的在新 Otty 窗口里打开当前工作区', { size: 12 }))
  parts.push(text(48, cy + 102, '只在本机装了 Otty、且宿主是新版时出现；仅 macOS —— 检测不到就不插，不留一个点了没反应的空行', { size: 12 }))
  parts.push(rect(44, cy + 118, WIDTH - 88, 32, { fill: ACCENT_SOFT, stroke: 'none', radius: 9 }))
  parts.push(text(60, cy + 139, '静默失效点：槽名 / data-open-target / 官方 Menu 的 role 结构任一处改名，症状只是「这一行不见了」，不报错。', { size: 12, fill: ACCENT, weight: 600 }))
  parts.push(text(28, HEIGHT - 16, '示意图，非截图：本文件不含任何真实会话、工作区或账号。', { size: 11, fill: MUTED }))

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" role="img" aria-label="dsh-flow：在官方「打开」菜单里插入一行 Otty，以及它的边界">'
    + parts.join('') + '</svg>\n'
}

/**
 * The right-sidebar tab actions: middle click, and the pane menu the slot adds.
 *
 * A diagram, not a screenshot: the strip and rows are drawn from the same
 * labels the plugin ships, and the notes state the two contracts the feature
 * depends on (the kit's tab elements, and the public close API).
 *
 * @returns the SVG document.
 */
function tabActionsDrawing() {
  const parts = []
  parts.push('<rect width="' + WIDTH + '" height="' + HEIGHT + '" fill="' + CANVAS + '"/>')
  parts.push(text(28, 44, '右栏页签：中键关一个，右键关其他 / 左侧 / 右侧 / 全部', { size: 22, weight: 600 }))
  parts.push(text(28, 68, '页签条是官方右栏的，插件只加一条中键手势与菜单里的一个 cell（示意图，非截图）', { size: 13, fill: MUTED }))

  const ax = 28
  const ay = 100
  const aw = 620
  const ah = 360
  parts.push(rect(ax, ay, aw, ah, { radius: 12 }))
  parts.push(text(ax + 20, ay + 32, '右侧栏', { size: 13, weight: 600 }))
  // tab strip
  const tabs = [
    { label: '文件', active: true },
    { label: '开始', active: false },
    { label: '终端', active: false },
  ]
  let tx = ax + 20
  for (const tab of tabs) {
    const width = 104
    parts.push(rect(tx, ay + 48, width, 32, { fill: tab.active ? ACCENT_SOFT : PANEL, stroke: tab.active ? ACCENT : LINE, radius: 8 }))
    parts.push(text(tx + 14, ay + 69, tab.label, { size: 12.5, fill: tab.active ? ACCENT : INK, weight: tab.active ? 600 : 400 }))
    parts.push(text(tx + width - 18, ay + 69, '×', { size: 12, fill: MUTED }))
    tx += width + 10
  }
  // middle-click annotation on the 终端 tab
  const lastX = tx - 114
  parts.push(rect(ax + 20, ay + 96, 132, 24, { fill: PANEL, stroke: ACCENT, radius: 12 }))
  parts.push(text(ax + 86, ay + 112, '中键 · 直接关', { size: 11, fill: ACCENT, weight: 600, anchor: 'middle' }))
  parts.push(text(ax + 20, ay + 138, '起手与释放必须在同一颗页签', { size: 10, fill: MUTED }))
  // menu
  const mx = ax + 250
  const my = ay + 150
  const rows = ['关闭', '关闭其他页签', '关闭左侧页签', '关闭右侧页签', '关闭全部页签']
  parts.push(rect(mx, my, 244, 34 + rows.length * 30, { fill: PANEL, radius: 10 }))
  rows.forEach((label, index) => {
    const ry = my + 26 + index * 30
    const disabled = index === 3
    parts.push(text(mx + 16, ry, label, { size: 12.5, fill: disabled ? MUTED : INK }))
    if (index > 0 && index < rows.length) parts.push('<path d="M' + (mx + 10) + ' ' + (ry - 20) + ' H' + (mx + 234) + '" stroke="' + LINE + '" stroke-width="1"/>')
  })
  parts.push(text(mx - 8, my - 8, '右键页签', { size: 11, fill: MUTED }))
  parts.push(text(ax + 20, ay + 346, '官方「关闭」保持第一行；四项只作用于这一格，摆不下的项变灰。', { size: 11.5, fill: MUTED }))

  const bx = 668
  const bw = 504
  parts.push(rect(bx, ay, bw, ah, { radius: 12 }))
  parts.push(text(bx + 20, ay + 32, '开关与边界', { size: 13, weight: 600 }))
  const bullets = [
    '设置 → 心流 →「右栏页签操作」：默认开，关掉后中键与四项一起消失。',
    '顺序只读 DOM：同一 data-dockkit-strip 内 data-dockkit-tab 的先后。',
    '关闭只调 ctx.sidebarRight.close(tabId)：不读布局快照，不写 localStorage。',
    '浮窗有自己的页签条，按各自的顺序算；跨分栏不动作。',
    '只剩一个页签时只显示一条禁用提示；唯一引导页仍受官方保护。',
  ]
  bullets.forEach((line, index) => {
    parts.push(text(bx + 20, ay + 62 + index * 34, '· ' + line, { size: 11.5 }))
  })
  parts.push(rect(bx + 16, ay + 240, bw - 32, 70, { fill: '#fbfcfd', stroke: 'none', radius: 10 }))
  parts.push(text(bx + 30, ay + 264, '静默失效点', { size: 12, weight: 600, fill: ACCENT }))
  parts.push(text(bx + 30, ay + 286, '官方改 data-dockkit-tab / data-dockkit-strip / 右栏作用域，', { size: 11 }))
  parts.push(text(bx + 30, ay + 304, '症状只是「菜单少几项」「中键不关」，不报错。', { size: 11 }))

  parts.push(rect(ax, 482, WIDTH - 56, 116, { radius: 12 }))
  parts.push(text(ax + 20, 512, '为什么不是新插件', { size: 13, weight: 600 }))
  parts.push(text(ax + 20, 538, '心流已经有设置页、菜单骨架与真浏览器验收；页签动作作为第十个开关落在这里，卸载/关掉即还原。', { size: 12 }))
  parts.push(text(ax + 20, 560, '官方席位是 sidebar.right.tab.menu.item（list），关闭走公开 close；没有 fork 官方包。', { size: 12 }))
  parts.push(text(28, HEIGHT - 16, '示意图，非截图：本文件不含任何真实会话、工作区或账号。', { size: 11, fill: MUTED }))

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" role="img" aria-label="dsh-flow：右栏页签的中键关闭与关闭其他 / 左侧 / 右侧 / 全部">'
    + parts.join('') + '</svg>\n'
}

/** Every asset this repo publishes, in the order it renders them. */
const ASSETS = [
  { name: 'locate-flow', draw: drawing },
  { name: 'code-menu', draw: codeMenuDrawing },
  { name: 'link-open', draw: linkDrawing },
  { name: 'send-key', draw: sendKeyDrawing },
  { name: 'workspace-name', draw: workspaceNameDrawing },
  { name: 'otty-menu', draw: ottyDrawing },
  { name: 'tab-menu', draw: tabActionsDrawing },
]

async function main() {
  if (!existsSync(chromePath)) throw new Error('Chrome not found; pass --chrome <path>')
  mkdirSync(join(ROOT, 'assets'), { recursive: true })
  for (const asset of ASSETS) {
    const svgPath = join(ROOT, 'assets', asset.name + '.svg')
    const pngPath = join(ROOT, 'assets', asset.name + '.png')
    writeFileSync(svgPath, asset.draw())
    console.log('wrote ' + svgPath)
    await rasterise(svgPath, pngPath)
    console.log('wrote ' + pngPath)
  }
}

await main()
