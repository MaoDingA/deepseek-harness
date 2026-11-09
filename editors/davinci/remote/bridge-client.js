/**
 * Linux-side MCP bridge client: connect to the reverse-tunneled Mac bridge and
 * pipe stdin/stdout, so the davinci-mcp stdio protocol works across the SSH
 * tunnel exactly as if the server were local.
 */
import net from 'node:net'

const port = Number(process.env.DSH_DAVINCI_BRIDGE_PORT ?? 18000)
const host = process.env.DSH_DAVINCI_BRIDGE_HOST ?? '127.0.0.1'

const socket = net.connect(port, host)
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('error', (error) => {
  process.stderr.write(`davinci bridge client: ${error.message}\n`)
  process.exit(1)
})
socket.on('close', () => process.exit(0))
