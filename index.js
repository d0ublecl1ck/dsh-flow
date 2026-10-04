/**
 * dsh-flow — host half.
 *
 * Owns one fact: the plugin's preference surface. `locateButton` is a volatile
 * Config field, which is what makes the settings provider project it into the
 * namespace named by this row's id (`flow`); the browser half reads and writes
 * that namespace through `ctx.configForms`. Nothing else about the plugin is
 * host-side — locating a Session is pure browser work over snapshots the shell
 * already publishes.
 *
 * The second fact is a presentation policy: this bundle ships its own settings
 * page (the 心流 section the browser half registers), so the settings provider
 * must not also auto-generate one from the schema. The policy is registered on
 * an optional `settings` child so a deployment without that service still loads
 * this bundle.
 *
 * @module dsh-flow
 */
import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name (the bundle row's id is `flow`). */
export const name = 'flow'

/**
 * Row config. `volatile` is what makes a field live-editable from the settings
 * page: the settings domain only projects volatile fields into a namespace.
 *
 * @typedef {object} Config
 * @property {boolean} locateButton - whether the sidebar foot shows the locate-current-Session button.
 */
export const Config = z.object({
  locateButton: z.boolean().default(true).volatile(),
})

/**
 * Mount the host half.
 *
 * @param {object} ctx - host cordis context.
 * @param {unknown} ctx.fiber - this plugin's fiber, which the page policy is keyed by.
 * @param {(names: string[], callback: (child: any) => void) => unknown} ctx.inject - optional-service child.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
