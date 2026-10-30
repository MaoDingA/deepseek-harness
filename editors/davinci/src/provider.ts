/**
 * Local Service Provider for `ctx.davinci`: `McpDavinci` drives the running
 * DaVinci Resolve through the davinci-mcp stdio JSON-RPC server, one spawned
 * node process per call (initialize + initialized + tools/call on stdin, the
 * id-matched response read from stdout, then stdin close lets the wrapper
 * exit). The bridge replaced the bundled `fuscript` Lua host, whose Resolve 21
 * build lost the scripting IPC bridge on this machine. The exchange is
 * deliberately not routed through the sandbox seam: the server reaches the
 * Resolve application over local scripting IPC, confinement would sever it,
 * and mutations are gated by tool-level approval instead.
 * @module @deepseek-ai/dsh-davinci/provider
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { clampTimeout, innerResponseToRaw, scriptTimeoutSeconds } from './protocol.ts'
import { DavinciService } from './service.ts'
import type { DavinciCallRequest, DavinciMarkerColor, DavinciScriptTool, DavinciSpec } from './types.ts'

/** Plugin config; unset fields fall back to documented defaults. */
export interface Config {
  /**
   * Absolute path of the davinci-mcp stdio server entry (`server/index.js`).
   * Omit to use the default `~/.local/share/davinci-mcp/server/index.js`.
   */
  readonly mcpServerPath?: string
  /**
   * Absolute path of the ResolveMCP binary. Omit to auto-discover the newest
   * DaVinci Resolve installed under `/Applications` (passed to the server as
   * `RESOLVE_MCP_PATH`; the server's built-in default lacks the version
   * suffix and misses numbered installs).
   */
  readonly resolveMcpPath?: string
  /**
   * Directory scanned for Resolve installs when `resolveMcpPath` is omitted.
   * Deployment-varying for nonstandard install roots; defaults to
   * `/Applications`.
   */
  readonly applicationsDir?: string
  /** Default execution budget per scripting call. */
  readonly defaultTimeoutMs?: number
  /**
   * Cap for any requested execution budget. The script tool's own hard cap is
   * 60s, so budgets above that are still clamped down at the exchange.
   */
  readonly maxTimeoutMs?: number
  /** Directory (relative to the working directory) receiving screenshots. */
  readonly screenshotDir?: string
  /**
   * Deployment-owned pre-approval for this plugin's mutations: skips the
   * interactive approval gate for resolve_* writes only. The default keeps
   * every mutation fail-closed; enabling it is an explicit deployment
   * decision that trusts this toolset, not a session-policy bypass.
   */
  readonly autoApproveMutations?: boolean
}

/** Schemastery schema for the `davinci-resolve` plugin row. */
export const davinciConfigSchema: z<Config> = z.object({
  mcpServerPath: z.string(),
  resolveMcpPath: z.string(),
  applicationsDir: z.string().default('/Applications'),
  defaultTimeoutMs: z.number().default(30_000),
  maxTimeoutMs: z.number().default(60_000),
  screenshotDir: z.string().default('.resolve-agent'),
  autoApproveMutations: z.boolean().default(false),
})

/** Marker colors accepted by `Timeline:AddMarker` on this host. */
export const DAVINCI_MARKER_COLORS: readonly DavinciMarkerColor[] = [
  'Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple', 'Fuchsia',
  'Rose', 'Lavender', 'Sky', 'Mint', 'Tan', 'Beige', 'Brown', 'Chocolate',
]

const DEFAULT_APPLICATIONS_DIR = '/Applications'

function versionNumberOf(installName: string): number {
  const match = installName.match(/^DaVinci Resolve(\d*)$/)
  if (match === null) return Number.NEGATIVE_INFINITY
  return match[1] === '' ? Number.NEGATIVE_INFINITY : Number(match[1])
}

/**
 * Discover the newest installed Resolve's `ResolveMCP` binary under an
 * applications directory. Install folders appear both as `DaVinci Resolve`
 * and `DaVinci Resolve<major>`; numbered folders rank by descending major.
 * @param applicationsDir - directory holding the install folders.
 * @returns the absolute ResolveMCP path, or `undefined` when none is installed.
 */
export function discoverResolveMcp(applicationsDir: string = DEFAULT_APPLICATIONS_DIR): string | undefined {
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
      'Applications',
      'ResolveMCP',
    )
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Default davinci-mcp server entry under the user's home directory.
 * @returns the absolute `server/index.js` path.
 */
export function defaultMcpServerPath(): string {
  return join(homedir(), '.local', 'share', 'davinci-mcp', 'server', 'index.js')
}

/** JSON-RPC id of the initialize request; its reply is not the call answer. */
const INITIALIZE_ID = 1

/** JSON-RPC id of the tools/call request whose reply settles the exchange. */
const CALL_ID = 2

/**
 * Wall-clock grace added on top of the script budget: process spawn, the
 * wrapper's synchronous `--dump-tools` probe, and the JSON-RPC round trip.
 */
const TRANSPORT_GRACE_MS = 5_000

/** Grace for the wrapper to exit on stdin close before a forced kill. */
const EXIT_GRACE_MS = 2_000

/** One stdout line of the davinci-mcp server, as the client reads it. */
interface McpLine {
  readonly id?: number
  readonly error?: { readonly message?: string }
  readonly result?: { readonly content?: readonly { readonly type?: string; readonly text?: unknown }[] }
}

/**
 * Local davinci-mcp-backed provider for the `ctx.davinci` seam.
 */
export class McpDavinci extends DavinciService {
  constructor(ctx: Context, public readonly config: Config) {
    super(ctx)
  }

  private discoveredServer: string | undefined

  private discoveredResolveMcp: string | undefined

  resolve(request: DavinciCallRequest): DavinciSpec {
    return {
      mcpServerPath: this.config.mcpServerPath ?? this.requireMcpServer(),
      resolveMcpPath: this.config.resolveMcpPath ?? this.requireResolveMcp(),
      timeoutMs: this.clamp(request),
    }
  }

  /**
   * Fail loud on the first call when neither config nor the default location
   * names a server entry: the plugin stays composable on machines without the
   * server while every actual use names the missing piece.
   * @returns the default server path once it exists.
   */
  private requireMcpServer(): string {
    if (this.discoveredServer === undefined) {
      this.discoveredServer = existsSync(defaultMcpServerPath()) ? defaultMcpServerPath() : ''
    }
    if (this.discoveredServer === '') {
      throw new Error(
        `davinci-resolve: MCP server entry not found at ${defaultMcpServerPath()} (expected the davinci-mcp stdio server); `
        + "set the mcpServerPath config to the absolute path of the server's index.js",
      )
    }
    return this.discoveredServer
  }

  /** Fail loud on the first call when no Resolve install ships a ResolveMCP binary. */
  private requireResolveMcp(): string {
    if (this.discoveredResolveMcp === undefined) {
      this.discoveredResolveMcp = discoverResolveMcp(this.config.applicationsDir ?? DEFAULT_APPLICATIONS_DIR) ?? ''
    }
    if (this.discoveredResolveMcp === '') {
      throw new Error(
        `davinci-resolve: no ResolveMCP binary found under ${this.config.applicationsDir ?? DEFAULT_APPLICATIONS_DIR} `
        + '(looked for DaVinci Resolve*/DaVinci Resolve.app/Contents/Applications/ResolveMCP); '
        + 'set the resolveMcpPath config to the absolute path of your install',
      )
    }
    return this.discoveredResolveMcp
  }

  private clamp(request: DavinciCallRequest): number {
    return clampTimeout(
      request.timeoutMs,
      this.config.defaultTimeoutMs ?? 30_000,
      this.config.maxTimeoutMs ?? 60_000,
    )
  }

  protected async evalScript(
    script: string,
    spec: DavinciSpec,
    signal: AbortSignal | undefined,
    tool: DavinciScriptTool,
  ): Promise<string> {
    const seconds = scriptTimeoutSeconds(spec.timeoutMs)
    const text = await this.callMcpTool(spec, tool, script, seconds, signal)
    return innerResponseToRaw(tool, text)
  }

  /**
   * One-shot stdio JSON-RPC exchange: spawn the server with a fixed argv (no
   * shell), write initialize, initialized, and the tools/call request, resolve
   * on the id-matched reply (notifications and the initialize reply are
   * skipped), then close stdin so the wrapper kills its ResolveMCP child and
   * exits. The outer wall clock is the script budget plus transport grace so
   * the inner timeout text wins.
   * @param spec - resolved spec naming the server and binary paths.
   * @param tool - script tool to call.
   * @param script - complete Python script source.
   * @param timeoutSeconds - script budget for the tool's `timeout` argument.
   * @param signal - cooperative cancellation; aborts kill the server process.
   * @returns the `content[0].text` payload of the call reply.
   */
  private callMcpTool(
    spec: DavinciSpec,
    tool: DavinciScriptTool,
    script: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const wallMs = spec.timeoutMs + TRANSPORT_GRACE_MS
    return new Promise<string>((resolve, reject) => {
      // An already-aborted signal never fires listeners registered after the
      // abort, so without this precheck a cancelled call would still spawn the
      // server, run the script inside Resolve, and end as a wall-clock
      // "timeout" instead of the caller's cancellation.
      if (signal?.aborted) {
        reject(Object.assign(new Error('davinci MCP exchange aborted by the caller before it started'), { name: 'AbortError' }))
        return
      }
      const serverArgv: readonly string[] = [spec.mcpServerPath]
      const serverEnv: NodeJS.ProcessEnv = { ...process.env, RESOLVE_MCP_PATH: spec.resolveMcpPath }
      const child = spawn(process.execPath, serverArgv, {
        env: serverEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let settled = false
      let buffer = ''
      const stderrChunks: string[] = []

      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(wallTimer)
        signal?.removeEventListener('abort', onAbort)
        action()
      }

      // Terminate through the wrapper's only child-cleanup channel: closing
      // stdin makes it kill its ResolveMCP child and exit. A bare SIGTERM on
      // the wrapper would orphan that grandchild holding Resolve's scripting
      // IPC — the wedge this migration exists to eliminate. SIGKILL covers a
      // wrapper that lingers.
      const terminateChild = (): void => {
        child.stdin.end()
        const killTimer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS)
        killTimer.unref()
      }

      const wallTimer = setTimeout(() => {
        terminateChild()
        settle(() => reject(Object.assign(
          new Error(`davinci MCP ${tool} exchange did not complete within ${wallMs}ms (script budget ${timeoutSeconds}s plus transport grace)`),
          { killed: true },
        )))
      }, wallMs)

      const onAbort = (): void => {
        terminateChild()
        settle(() => reject(Object.assign(new Error(`davinci MCP ${tool} exchange aborted by the caller`), { name: 'AbortError' })))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.on('error', (error) => settle(() => reject(error)))
      child.on('exit', (code, exitSignal) => settle(() => reject(new Error(
        `davinci MCP ${tool} server exited before answering (code=${code ?? 'null'} signal=${exitSignal ?? 'null'})`
        + (stderrChunks.length > 0 ? `; stderr: ${stderrChunks.join('').trim().slice(-300)}` : ''),
      ))))
      child.stdin.on('error', () => {
        // EPIPE when the server dies mid-write; the exit or wall-clock paths settle the exchange.
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line !== '') handleLine(line)
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderrChunks.push(chunk)
      })

      function handleLine(line: string): void {
        let message: McpLine
        try {
          message = JSON.parse(line) as McpLine
        } catch {
          return // stray non-JSON stdout noise; every protocol line is JSON-RPC
        }
        if (message.id !== CALL_ID) return // initialize reply and notifications/message lines
        if (message.error !== undefined) {
          settle(() => reject(new Error(`davinci MCP ${tool} request failed: ${message.error?.message ?? 'unknown RPC error'}`)))
          return
        }
        const text = message.result?.content?.find((piece) => piece?.type === 'text')?.text
        if (typeof text !== 'string') {
          settle(() => reject(new Error(`davinci MCP ${tool} response carried no text content: ${JSON.stringify(message.result).slice(0, 200)}`)))
          return
        }
        settle(() => {
          child.stdin.end()
          resolve(text)
          // stdin close makes the wrapper exit; force-kill if it lingers.
          const killTimer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS)
          killTimer.unref()
        })
      }

      const requests = [
        {
          jsonrpc: '2.0' as const,
          id: INITIALIZE_ID,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'dsh-davinci', version: '0' },
          },
        },
        { jsonrpc: '2.0' as const, method: 'notifications/initialized' },
        {
          jsonrpc: '2.0' as const,
          id: CALL_ID,
          method: 'tools/call',
          params: { name: tool, arguments: { script, timeout: timeoutSeconds } },
        },
      ]
      child.stdin.write(requests.map((request) => JSON.stringify(request) + '\n').join(''))
    })
  }
}

export default McpDavinci
