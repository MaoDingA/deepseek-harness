/**
 * Mac-side MCP bridge: listen on 127.0.0.1:18000, and for every connection
 * spawn one davinci-mcp stdio server that talks to the local Resolve, piping
 * both directions. The Linux DSH host reaches this port through a reverse SSH
 * tunnel, so the remote agent can drive Resolve without running it locally.
 */
import net from 'node:net'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.DSH_DAVINCI_BRIDGE_PORT ?? 18000)
const host = process.env.DSH_DAVINCI_BRIDGE_HOST ?? '127.0.0.1'
const serverPath = process.env.DSH_DAVINCI_MCP_SERVER
  ?? join(homedir(), '.local/share/davinci-mcp/server/index.js')
const resolveMcpPath = process.env.RESOLVE_MCP_PATH
  ?? '/Applications/DaVinci Resolve21/DaVinci Resolve.app/Contents/Applications/ResolveMCP'
// Resolve 20 has no official MCP server; a second bridge can spawn the Python
// API shim instead of Node's davinci-mcp by setting these two variables.
const serverCommand = process.env.DSH_DAVINCI_SERVER_CMD ?? process.execPath
const serverArgs = process.env.DSH_DAVINCI_SERVER_ARGS
  ? JSON.parse(process.env.DSH_DAVINCI_SERVER_ARGS)
  : [serverPath]

const server = net.createServer((socket) => {
  const child = spawn(serverCommand, serverArgs, {
    env: { ...process.env, RESOLVE_MCP_PATH: resolveMcpPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  socket.pipe(child.stdin)
  child.stdout.pipe(socket)
  child.stderr.on('data', (chunk) => process.stderr.write(`[davinci-mcp] ${chunk}`))
  const close = () => {
    socket.destroy()
    child.kill('SIGTERM')
  }
  socket.on('close', close)
  socket.on('error', close)
  child.on('exit', close)
  child.on('error', close)
})
server.listen(port, host, () => {
  console.log(`davinci bridge listening on ${host}:${port}`)
})
