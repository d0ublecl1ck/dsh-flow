/**
 * dsh-flow — host half.
 *
 * Owns three facts:
 *
 *  - the plugin's preference surface. `locateButton`, `copySessionId` and
 *    `externalLink` are volatile Config fields, which is what makes the settings
 *    provider project them into the namespace named by this row's id (`flow`);
 *    the browser half reads and writes that namespace through `ctx.configForms`.
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
 */
export const Config = z.object({
  locateButton: z.boolean().default(true).volatile(),
  copySessionId: z.boolean().default(true).volatile(),
  externalLink: z.boolean().default(true).volatile(),
})

/** Exact route the browser half posts an off-origin link to. */
export const OPEN_PATH = '/flow/open-external'

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
  })
}
