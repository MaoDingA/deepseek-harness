import { Context } from '@deepseek-ai/cordis'
import McpDavinci from './src/provider.ts'
import type { DavinciScriptTool } from './src/types.ts'

/** Live smoke: read-only operations plus failure-path probes against the real MCP server. */
class ProbeDavinci extends McpDavinci {
  /** Run one raw script through the real transport (failure-path probes only). */
  async raw(script: string, tool: DavinciScriptTool = 'run_script'): Promise<string> {
    return await this.evalScript(script, this.resolve({ timeoutMs: 2_000 }), undefined, tool)
  }
}

const service = new ProbeDavinci(new Context(), {})
for (const [label, run] of [
  ['projectInfo', () => service.projectInfo()],
  ['mediaPool(root)', () => service.mediaPool('')],
  ['timelineItems(V1)', () => service.timelineItems(1, undefined, undefined)],
  ['findClip(EP01)', () => service.findClip('EP01')],
  ['renderStatus', () => service.renderStatus()],
  ['renderPresets', () => service.renderPresets()],
] as const) {
  console.log(`== ${label} ==`)
  console.log(JSON.stringify(await run(), null, 2))
}

console.log('== timeout probe (busy loop, 2s budget) ==')
console.log(JSON.stringify(await service.raw('x = 0\nwhile True:\n    x = x + 1\n')))

console.log('== sandbox import probe (import os in run_script) ==')
console.log(JSON.stringify(await service.raw('import os\nprint("should not run")\n')))

console.log('== unsafe probe (os.path.exists through run_script_unsafe) ==')
console.log(JSON.stringify(await service.raw('import os\nprint("exists=" + str(os.path.exists("/Applications")))\n', 'run_script_unsafe')))

console.log('== screenshot probe (activate: false) ==')
try {
  console.log(await service.screenshot({ activate: false, screenshotDir: '.resolve-agent' }))
} catch (error) {
  console.log(`refused: ${(error as Error).message}`)
}
process.exit(0)
