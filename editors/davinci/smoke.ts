import { Context } from '@deepseek-ai/cordis'
import FuscriptDavinci from './src/provider.ts'

const ctx = new Context()
const service = new FuscriptDavinci(ctx, {})
const info = await service.projectInfo()
console.log(JSON.stringify(info, null, 2))
process.exit(0)
