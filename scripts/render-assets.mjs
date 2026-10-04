#!/usr/bin/env node
/**
 * Render dsh-flow's documentation assets from source.
 *
 * Two outputs, one run:
 *
 *  - `assets/locate-flow.svg` — the hand-drawn explainer the README shows and
 *    the plugin market uses as the entry image. It is a **diagram, not a
 *    screenshot**: nothing in it comes from a real session, a real workspace, or
 *    a real account, which is exactly why it is safe to publish.
 *  - `assets/locate-flow.png` — the same drawing rasterised at 2x through a
 *    headless Chrome, because several marketplaces and package pages do not
 *    render SVG.
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

/**
 * Rasterise one local file through a throwaway headless Chrome.
 *
 * Chrome writes the screenshot and then, on this platform, sometimes keeps the
 * process alive instead of exiting; waiting only on `exit` hung a real run. So
 * the wait is bounded by the screenshot appearing on disk, and the process is
 * killed either way — the profile directory is removed unconditionally.
 *
 * @param svgPath - the SVG source to render.
 * @param pngPath - destination PNG.
 */
async function rasterise(svgPath, pngPath) {
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
    chrome.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(chromePath)) throw new Error('Chrome not found; pass --chrome <path>')
  mkdirSync(join(ROOT, 'assets'), { recursive: true })
  const svgPath = join(ROOT, 'assets', 'locate-flow.svg')
  const pngPath = join(ROOT, 'assets', 'locate-flow.png')
  writeFileSync(svgPath, drawing())
  console.log('wrote ' + svgPath)
  await rasterise(svgPath, pngPath)
  console.log('wrote ' + pngPath)
}

await main()
