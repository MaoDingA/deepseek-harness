/**
 * `davinci-resolve` plugin entry: mounts the local fuscript provider as
 * `ctx.davinci` and registers the model-facing `resolve_*` tools plus the
 * editing-conventions prompt section. The Service Definition (abstract class
 * and vocabulary), the Provider, and the Consumer live in this one package on
 * purpose — the roles are separated structurally, and no second provider or
 * consumer exists yet to force a split.
 * @module @deepseek-ai/dsh-davinci
 */

import type { Context } from '@deepseek-ai/cordis'
import { FuscriptDavinci, davinciConfigSchema } from './provider.ts'
import type { Config as DavinciConfig } from './provider.ts'
import { registerDavinciTools } from './tools.ts'

export { captureScreenshot, DAVINCI_MARKER_COLORS, davinciConfigSchema, discoverFuscript, FuscriptDavinci } from './provider.ts'
export { DavinciService, classifySpawnError, errorMessage } from './service.ts'
export { requireWriteApproval } from './tools.ts'
export type { DavinciCallRequest, DavinciRenderPresetsInfo, DavinciRenderStatusInfo, DavinciSpec, DavinciFailureCode, DavinciResult } from './types.ts'

/** Plugin id used in composition rows. */
export const name = 'davinci-resolve'

export const inject = ['tools', 'systemPrompt']

/** Plugin config schema; see {@link Config} for field semantics. */
export const Config = davinciConfigSchema

/**
 * Mount the provider service and the tool surface.
 * @param ctx - plugin context owning the registrations.
 * @param config - validated config row.
 */
export function apply(ctx: Context, config: DavinciConfig = {}): void {
  const davinci = new FuscriptDavinci(ctx, config)
  registerDavinciTools(ctx, davinci.config)
}
