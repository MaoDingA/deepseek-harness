/**
 * Local Service Provider for `ctx.davinci`: `FuscriptDavinci` drives the
 * running DaVinci Resolve through its bundled `fuscript` Lua host, one spawned
 * process per call. The bridge is deliberately not routed through the sandbox
 * seam: fuscript reaches the Resolve application over local scripting IPC,
 * confinement would sever it, and mutations are gated by tool-level approval
 * instead.
 * @module @deepseek-ai/dsh-davinci/provider
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LUA_PRELUDE } from './lua.ts'
import { clampTimeout, stripBanner } from './protocol.ts'
import { DavinciService } from './service.ts'
import type { DavinciCallRequest, DavinciMarkerColor, DavinciSpec } from './types.ts'

const execFileAsync = promisify(execFile)

/** Plugin config; unset fields fall back to documented defaults. */
export interface Config {
  /**
   * Absolute path of the `fuscript` host. Omit to auto-discover the newest
   * DaVinci Resolve installed under `/Applications`.
   */
  readonly fuscriptPath?: string
  /** Default execution budget per scripting call. */
  readonly defaultTimeoutMs?: number
  /** Cap for any requested execution budget. */
  readonly maxTimeoutMs?: number
  /** Directory (relative to the working directory) receiving screenshots. */
  readonly screenshotDir?: string
}

/** Schemastery schema for the `davinci-resolve` plugin row. */
export const davinciConfigSchema: z<Config> = z.object({
  fuscriptPath: z.string(),
  defaultTimeoutMs: z.number().default(30_000),
  maxTimeoutMs: z.number().default(120_000),
  screenshotDir: z.string().default('.resolve-agent'),
})

/** Marker colors accepted by `Timeline:AddMarker` on this host. */
export const DAVINCI_MARKER_COLORS: readonly DavinciMarkerColor[] = [
  'Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple', 'Fuchsia',
  'Rose', 'Lavender', 'Sky', 'Mint', 'Tan', 'Beige', 'Brown', 'Chocolate',
]

const DEFAULT_APPLICATIONS_DIR = '/Applications'

function versionNumberOf(installName: string): number {
  const match = /^DaVinci Resolve(\d*)$/.exec(installName)
  if (match === null) return Number.NEGATIVE_INFINITY
  return match[1] === '' ? Number.NEGATIVE_INFINITY : Number(match[1])
}

/**
 * Discover the newest installed Resolve's `fuscript` under an applications
 * directory. Install folders appear both as `DaVinci Resolve` and
 * `DaVinci Resolve<major>`; numbered folders rank by descending major.
 * @param applicationsDir - directory holding the install folders.
 * @returns the absolute fuscript path, or `undefined` when none is installed.
 */
export function discoverFuscript(applicationsDir: string = DEFAULT_APPLICATIONS_DIR): string | undefined {
  let entries: readonly string[]
  try {
    entries = readdirSync(applicationsDir)
  } catch {
    return undefined
  }
  const installs = entries
    .filter((name) => versionNumberOf(name) !== Number.NEGATIVE_INFINITY || name === 'DaVinci Resolve')
    .sort((a, b) => versionNumberOf(b) - versionNumberOf(a))
  for (const name of installs) {
    const candidate = join(
      applicationsDir,
      name,
      'DaVinci Resolve.app',
      'Contents',
      'Libraries',
      'Fusion',
      'fuscript',
    )
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Local fuscript-backed provider for the `ctx.davinci` seam.
 */
export class FuscriptDavinci extends DavinciService {
  constructor(ctx: Context, public readonly config: Config) {
    super(ctx)
  }

  private discovered: string | undefined

  resolve(request: DavinciCallRequest): DavinciSpec {
    if (this.config.fuscriptPath !== undefined) {
      return {
        fuscriptPath: this.config.fuscriptPath,
        timeoutMs: this.clamp(request),
      }
    }
    if (this.discovered === undefined) {
      this.discovered = discoverFuscript()
    }
    if (this.discovered === undefined) {
      throw new Error(
        `davinci-resolve: no fuscript found under ${DEFAULT_APPLICATIONS_DIR} `
        + '(looked for DaVinci Resolve*/DaVinci Resolve.app/Contents/Libraries/Fusion/fuscript); '
        + 'set the fuscriptPath config to the absolute path of your install',
      )
    }
    return { fuscriptPath: this.discovered, timeoutMs: this.clamp(request) }
  }

  private clamp(request: DavinciCallRequest): number {
    return clampTimeout(
      request.timeoutMs,
      this.config.defaultTimeoutMs ?? 30_000,
      this.config.maxTimeoutMs ?? 120_000,
    )
  }

  protected async evalScript(
    body: string,
    spec: DavinciSpec,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const scriptPath = join(tmpdir(), `dsh-davinci-${randomUUID()}.lua`)
    await writeFile(scriptPath, LUA_PRELUDE + body, 'utf8')
    try {
      const { stdout } = await execFileAsync(spec.fuscriptPath, [scriptPath], {
        timeout: spec.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        signal,
      })
      return stripBanner(stdout)
    } finally {
      await rm(scriptPath, { force: true })
    }
  }
}

export default FuscriptDavinci

/**
 * Capture the screen to a fresh PNG under the configured screenshot directory.
 * @param screenshotDir - configured directory, resolved against the working
 *   directory by the caller.
 * @returns the absolute path of the written PNG.
 */
export async function captureScreenshot(screenshotDir: string): Promise<string> {
  const dir = resolve(screenshotDir)
  await mkdir(dir, { recursive: true })
  const png = join(dir, `screen-${randomUUID()}.png`)
  await execFileAsync('screencapture', ['-x', png], { timeout: 10_000 })
  return png
}
