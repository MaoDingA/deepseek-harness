import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as Davinci from '../src/index.ts'

const TOOL_NAMES = [
  'resolve_project_info',
  'resolve_media_pool',
  'resolve_timeline_items',
  'resolve_find_by_tc',
  'resolve_seek',
  'resolve_screenshot',
  'resolve_switch_timeline',
  'resolve_place_clip',
  'resolve_delete_item',
  'resolve_add_marker',
]

describe('davinci-resolve composition', () => {
  it('mounts the service and registers every resolve tool on a real registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Davinci, { fuscriptPath: '/nonexistent/fuscript' })
    expect(ctx.get('davinci')).toBeDefined()
    for (const name of TOOL_NAMES) {
      expect(ctx.tools.get(name), name).toBeDefined()
    }
  })
})
