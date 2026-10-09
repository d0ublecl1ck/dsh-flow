/**
 * dsh-flow — host half.
 *
 * Owns three facts:
 *
 *  - the plugin's preference surface. `locateButton`, `copySessionId`,
 *    `externalLink`, `codeMenu`, `changesFileOpen`, `composerHistory`,
 *    `modEnterSend` and `workspaceName` are volatile Config fields,
 *    which is what makes the settings provider project them into the namespace
 *    named by this row's id (`flow`); the browser half reads and writes that
 *    namespace through `ctx.configForms`.
 *  - the presentation policy: this bundle ships its own settings page (the 心流
 *    section the browser half registers), so the settings provider must not also
 *    auto-generate one from the schema. The policy is registered on an optional
 *    `settings` child so a deployment without that service still loads this
 *    bundle.
 *  - the one route that opens a link. The Electron shell treats
 *    `http://localhost` as its own surface, so an anchor click there lands in an
 *    in-app window and never reaches the OS browser. The browser half therefore
 *    posts every off-origin link here, and this half hands it to the platform
 *    opener — the only path that also covers localhost. The route is registered
 *    on an optional `webServer` + `connection` child for the same reason as the
 *    settings policy: a deployment without the web transport stays loadable.
 *
 * Locating a Session, copying one's id and deciding whether a click is an
 * off-origin link are pure browser work over snapshots the shell already
 * publishes; nothing about them is host-side.
 *
 * @module dsh-flow
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name (the bundle row's id is `flow`). */
export const name = 'flow'

/**
 * Row config. `volatile` is what makes a field live-editable from the settings
 * page: the settings domain only projects volatile fields into a namespace.
 *
 * @typedef {object} Config
 * @property {boolean} locateButton - whether the workspace header shows the locate-current-Session button.
 * @property {boolean} copySessionId - whether a Session row offers "copy Session ID", by right-click menu and by shortcut.
 * @property {boolean} externalLink - whether off-origin links leave through the platform opener instead of the shell.
 * @property {boolean} codeMenu - whether right-clicking inline code in a conversation offers "open" and "copy".
 * @property {boolean} changesFileOpen - whether right-clicking a file row on the edited-files card offers opening it with the default application.
 * @property {boolean} composerHistory - whether ↑/↓ in an empty composer recalls the messages this conversation already sent.
 * @property {boolean} modEnterSend - whether Cmd/Ctrl+Enter sends and a plain Enter inserts a newline, instead of the shipped Enter-sends pair.
 * @property {boolean} workspaceName - whether the shipped "Open In…" split button carries the current Workspace's name beside its icon.
 */
export const Config = z.object({
  locateButton: z.boolean().default(true).volatile(),
  copySessionId: z.boolean().default(true).volatile(),
  externalLink: z.boolean().default(true).volatile(),
  codeMenu: z.boolean().default(true).volatile(),
  changesFileOpen: z.boolean().default(true).volatile(),
  composerHistory: z.boolean().default(true).volatile(),
  modEnterSend: z.boolean().default(false).volatile(),
  workspaceName: z.boolean().default(true).volatile(),
})

/** Exact route the browser half posts an off-origin link to. */
export const OPEN_PATH = '/flow/open-external'

/** Exact route that lists the applications this bundle can hand a path to. */
export const APPS_PATH = '/flow/apps'

/** Exact route that opens one path in one chosen application. */
export const OPEN_WITH_PATH = '/flow/open-with'

/** Paths are shorter than this; anything longer is not a path. */
const MAX_PATH_LENGTH = 4096

/**
 * The applications this bundle is willing to launch, and what each may open.
 *
 * This is the plugin's own catalog: it does not ask the OS what a given file is
 * associated with, so an IDE the user has installed is offered for every file.
 * `kind` is the rule the open route enforces — an `ide` takes a file or a
 * directory, a `terminal` and the `files` manager take a directory only. The
 * per-platform lists are candidate spellings, tried in order; an absolute entry
 * is used as is, a bare one is looked for under the platform's application roots
 * (macOS) or on `PATH` (Windows, Linux).
 */
const APP_CATALOG = [
  { id: 'vscode', name: 'VS Code', kind: 'ide', darwin: ['Visual Studio Code.app'], win32: ['Code.exe'], linux: ['code'] },
  { id: 'vscodeinsiders', name: 'VS Code Insiders', kind: 'ide', darwin: ['Visual Studio Code - Insiders.app'], win32: ['Code - Insiders.exe'], linux: ['code-insiders'] },
  { id: 'cursor', name: 'Cursor', kind: 'ide', darwin: ['Cursor.app'], win32: ['Cursor.exe'], linux: ['cursor'] },
  { id: 'windsurf', name: 'Windsurf', kind: 'ide', darwin: ['Windsurf.app'], win32: ['Windsurf.exe'], linux: ['windsurf'] },
  { id: 'zed', name: 'Zed', kind: 'ide', darwin: ['Zed.app', 'Zed Preview.app'], win32: ['Zed.exe'], linux: ['zed'] },
  { id: 'sublimetext', name: 'Sublime Text', kind: 'ide', darwin: ['Sublime Text.app'], win32: ['sublime_text.exe'], linux: ['subl'] },
  { id: 'xcode', name: 'Xcode', kind: 'ide', darwin: ['Xcode.app'] },
  { id: 'androidstudio', name: 'Android Studio', kind: 'ide', darwin: ['Android Studio.app'], win32: ['studio64.exe'], linux: ['android-studio'] },
  { id: 'intellij', name: 'IntelliJ IDEA', kind: 'ide', darwin: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'], linux: ['idea'] },
  { id: 'pycharm', name: 'PyCharm', kind: 'ide', darwin: ['PyCharm.app', 'PyCharm CE.app'], linux: ['pycharm'] },
  { id: 'webstorm', name: 'WebStorm', kind: 'ide', darwin: ['WebStorm.app'], linux: ['webstorm'] },
  { id: 'phpstorm', name: 'PhpStorm', kind: 'ide', darwin: ['PhpStorm.app'], linux: ['phpstorm'] },
  { id: 'goland', name: 'GoLand', kind: 'ide', darwin: ['GoLand.app'], linux: ['goland'] },
  { id: 'rider', name: 'Rider', kind: 'ide', darwin: ['Rider.app'], linux: ['rider'] },
  { id: 'rustrover', name: 'RustRover', kind: 'ide', darwin: ['RustRover.app'], linux: ['rustrover'] },
  { id: 'finder', name: '访达', kind: 'files', darwin: ['/System/Library/CoreServices/Finder.app'] },
  { id: 'terminal', name: '终端', kind: 'terminal', darwin: ['/System/Applications/Utilities/Terminal.app'], win32: ['wt.exe'], linux: ['x-terminal-emulator'] },
  { id: 'iterm', name: 'iTerm2', kind: 'terminal', darwin: ['iTerm.app'] },
  { id: 'ghostty', name: 'Ghostty', kind: 'terminal', darwin: ['Ghostty.app'], linux: ['ghostty'] },
  { id: 'warp', name: 'Warp', kind: 'terminal', darwin: ['Warp.app'], linux: ['warp-terminal'] },
  { id: 'kitty', name: 'kitty', kind: 'terminal', linux: ['kitty'] },
]

/**
 * Directories macOS keeps application bundles in, most specific last.
 *
 * @param env - environment carrying `HOME`.
 * @returns the roots, in lookup order.
 */
export function applicationRoots(env = process.env) {
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : ''
  return [
    '/Applications',
    home === '' ? null : home + '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
  ].filter((root) => root !== null)
}

/**
 * Resolve one candidate spelling to an existing absolute path.
 *
 * @param candidate - absolute path or bare application name.
 * @param platform - `process.platform` of the host.
 * @param input.roots - macOS application roots.
 * @param input.exists - `(path) => boolean`.
 * @param input.env - environment carrying `PATH`.
 * @returns the path, or null when nothing exists.
 */
export function resolveCandidate(candidate, platform, { roots, exists, env }) {
  if (candidate.startsWith('/')) return exists(candidate) ? candidate : null
  if (platform === 'darwin') {
    for (const root of roots) {
      const path = root + '/' + candidate
      if (exists(path)) return path
    }
    return null
  }
  const path = env.PATH ?? ''
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE').split(';') : ['']
  for (const dir of path.split(platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    for (const extension of extensions) {
      const full = dir + '/' + candidate + extension
      if (exists(full)) return full
    }
  }
  return null
}

/**
 * The applications of this catalog that are really installed.
 *
 * @param options - `{platform, roots, exists, env}`, all defaulting to this process.
 * @returns `[{id, name, kind, path}]`, catalog order.
 */
export function installedApps(options = {}) {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const env = options.env ?? process.env
  const roots = options.roots ?? applicationRoots(env)
  const apps = []
  for (const entry of APP_CATALOG) {
    for (const candidate of entry[platform] ?? []) {
      const path = resolveCandidate(candidate, platform, { roots, exists, env })
      if (path === null) continue
      apps.push({ id: entry.id, name: entry.name, kind: entry.kind, path })
      break
    }
  }
  return apps
}

/**
 * Build the request handler for the installed-application list.
 *
 * @param input.rejected - the trust fence's verdict.
 * @param input.apps - `() => [{id, name, kind, path}]`.
 * @returns the request handler.
 */
export function appsRequestHandler({ rejected = () => false, apps = () => installedApps() } = {}) {
  return (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    sendJson(res, 200, { apps: apps().map(({ id, name, kind }) => ({ id, name, kind })) })
  }
}

/**
 * Decide whether one catalog entry may open one path.
 *
 * @param entry - the catalog entry.
 * @param isDirectory - whether the path is a directory.
 * @returns whether the launch is allowed.
 */
export function mayOpen(entry, isDirectory) {
  return entry != null && (isDirectory || entry.kind === 'ide')
}

/**
 * Build the request handler that opens one path in one chosen application.
 *
 * `app` is always a catalog id, `path` is always an absolute path checked to
 * exist, and a file is only ever handed to an `ide` — so a malformed or hostile
 * body cannot reach the opener. `default` and `reveal` are the two OS gestures
 * that need no catalog entry at all.
 *
 * @param input.rejected - the trust fence's verdict.
 * @param input.apps - `() => [{id, name, kind, path}]`.
 * @param input.stat - `(path) => Promise<Stats>`.
 * @param input.launch - `(entry, path) => Promise<boolean>`; `entry` is null for default/reveal.
 * @returns the request handler.
 */
export function openWithRequestHandler({
  rejected = () => false,
  apps = () => installedApps(),
  stat = (path) => statSync(path),
  launch = (entry, path, action) => launchPath(entry, path, action),
} = {}) {
  return async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    let text
    try {
      text = await readBoundedBody(req)
    } catch {
      sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
      return
    }
    if (text === null) {
      sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    const app = typeof body?.app === 'string' ? body.app : ''
    const path = typeof body?.path === 'string' ? body.path : ''
    if (path.length === 0 || path.length > MAX_PATH_LENGTH || !isAbsolute(path)) {
      sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute path' })
      return
    }
    const entry = app === 'default' || app === 'reveal' ? null : apps().find((candidate) => candidate.id === app)
    if (app !== 'default' && app !== 'reveal' && entry === undefined) {
      sendJson(res, 400, { code: 'bad-request', message: 'unknown application: ' + app })
      return
    }
    let stats
    try {
      stats = await stat(path)
    } catch {
      sendJson(res, 404, { code: 'not-found', message: 'path does not exist: ' + path })
      return
    }
    const directory = typeof stats?.isDirectory === 'function' && stats.isDirectory()
    if (entry != null && !mayOpen(entry, directory)) {
      sendJson(res, 403, { code: 'forbidden', message: entry.name + ' does not open files' })
      return
    }
    if (await launch(entry, path, app === 'reveal' ? 'reveal' : 'open')) sendJson(res, 200, { ok: true })
    else sendJson(res, 502, { code: 'open-failed', message: 'the platform opener could not be started' })
  }
}

/**
 * Launch one catalog application, or the OS default gesture, on one path.
 *
 * @param entry - the catalog entry, or null for `default`/`reveal`.
 * @param path - the verified absolute path.
 * @param action - `open` or `reveal`.
 * @param platform - `process.platform` of the host.
 * @returns whether the command could be started.
 */
export function launchPath(entry, path, action, platform = process.platform) {
  let argv
  if (entry === null && action === 'reveal') {
    if (platform === 'darwin') argv = ['open', ['-R', path]]
    else if (platform === 'win32') argv = ['explorer', ['/select,' + path]]
    else argv = ['xdg-open', [dirname(path)]]
  } else if (entry === null) {
    if (platform === 'darwin') argv = ['open', [path]]
    else if (platform === 'win32') argv = ['cmd', ['/c', 'start', '', path]]
    else argv = ['xdg-open', [path]]
  } else if (platform === 'darwin') {
    argv = ['open', ['-a', entry.path, path]]
  } else {
    argv = [entry.path, [path]]
  }
  const [command, args] = argv
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.unref()
      resolve(true)
    } catch {
      resolve(false)
    }
  })
}

/** Schemes this route is willing to hand to the OS opener. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** One URL per request; anything larger than this is not a link. */
const MAX_URL_LENGTH = 8192

/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Answer one request as JSON (no-store: an open outcome is a live fact).
 *
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param payload - the JSON body.
 */
export function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Read the whole request body, or null when it exceeds the bound.
 *
 * @param req - the request to drain.
 * @returns the body as text, or null when it was too large.
 */
export function readBoundedBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Normalize and validate one client-supplied URL.
 *
 * Only the parser's own output is ever handed to the opener, so a click cannot
 * smuggle shell syntax past the scheme check.
 *
 * @param value - the `url` field of the request body.
 * @returns the normalized href, or null when rejected.
 */
export function acceptedUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null
  return parsed.href
}

/**
 * The platform command that opens one URL in the user's default application.
 *
 * @param url - the normalized URL to open.
 * @param platform - `process.platform` of the host.
 * @returns the command and its arguments.
 */
export function openerCommand(url, platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

/**
 * Hand one URL to the platform opener.
 *
 * Detached and unref'd: the opener outlives this process's interest in it, and
 * its stdio is not this plugin's to read.
 *
 * @param url - the URL to open.
 * @param platform - `process.platform` of the host.
 * @returns whether the opener could be started.
 */
export function openExternal(url, platform = process.platform) {
  const { command, args } = openerCommand(url, platform)
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.unref()
      resolve(true)
    } catch {
      resolve(false)
    }
  })
}

/**
 * Build the request handler for the open route.
 *
 * Every answer is one of a fixed set of JSON outcomes; a rejected call never
 * reaches the opener.
 *
 * @param input.rejected - the trust fence's verdict: `(req, res) => boolean`, true when it already answered.
 * @param input.open - hands one URL to the platform opener, answering whether it started.
 * @returns the request handler.
 */
export function openRequestHandler({
  rejected = () => false,
  open = (url) => openExternal(url),
} = {}) {
  return async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    let text
    try {
      text = await readBoundedBody(req)
    } catch {
      sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
      return
    }
    if (text === null) {
      sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
      return
    }
    let url
    try {
      url = acceptedUrl(JSON.parse(text)?.url)
    } catch {
      url = null
    }
    if (url === null) {
      sendJson(res, 400, { code: 'bad-request', message: 'url must be an http, https, mailto or tel URL' })
      return
    }
    if (await open(url)) sendJson(res, 200, { ok: true })
    else sendJson(res, 502, { code: 'open-failed', message: 'the platform opener could not be started' })
  }
}

/**
 * Mount the host half.
 *
 * @param ctx - host cordis context.
 * @param {unknown} ctx.fiber - this plugin's fiber, which the page policy is keyed by.
 * @param {(names: string[], callback: (child: any) => void) => unknown} ctx.inject - optional-service child.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.inject(['webServer', 'connection'], (scope) => {
    /** Answer an untrusted/unauthenticated request; true when it was rejected. */
    const rejected = (req, res) => {
      const rejection = scope.connection.requestRejection(req)
      if (rejection === void 0) return false
      res.statusCode = rejection
      res.end()
      return true
    }
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: openRequestHandler({ rejected }),
    }), 'flow: POST ' + OPEN_PATH)
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: APPS_PATH,
      handler: appsRequestHandler({ rejected }),
    }), 'flow: GET ' + APPS_PATH)
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: OPEN_WITH_PATH,
      handler: openWithRequestHandler({ rejected }),
    }), 'flow: POST ' + OPEN_WITH_PATH)
  })
}
