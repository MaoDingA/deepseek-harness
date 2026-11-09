/**
 * gRPC gateway for the DaVinci agent on the 225 server.
 *
 * The Rust backend keeps gRPC; this process owns the DSH SDK JSON-RPC wire.
 * One `dsh --profile davinci-sdk` (or davinci-sdk-20) runtime is spawned per
 * RunTask turn, and its session events are translated into the gRPC stream.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

const ROOT = '/srv/yingxing/dsh-davinci'
const RUNNER = path.join(ROOT, 'deploy/run.sh')
const PROTO = path.join(ROOT, 'gateway/proto/davinci_agent.proto')
const PORT = Number(process.env.DSH_DAVINCI_GRPC_PORT ?? 50051)
const CWD = ROOT
const PROVIDER = 'davinci-225'
const MODEL = 'qwen3.5-9b-agent'

const packageDefinition = protoLoader.loadSync(PROTO, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})
const proto = grpc.loadPackageDefinition(packageDefinition).davinci.agent.v1

function profileFor(version) {
  return version === '20' ? 'davinci-sdk-20' : 'davinci-sdk'
}

function writeEvent(call, event) {
  if (call.cancelled) return
  call.write(event)
}

/**
 * Run one turn and stream its events. Resolves after the runtime reports idle
 * (final written) or a failure (error written).
 * @param {object} call gRPC server stream.
 * @param {object} request RunTaskRequest.
 */
async function runTask(call, request) {
  const sessionId = request.session_id || randomUUID()
  const profile = profileFor(request.resolve_version)
  const child = spawn(RUNNER, ['--profile', profile], {
    cwd: CWD,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  let lastText = ''
  let finished = false

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

  const finish = (type, text) => {
    if (finished) return
    finished = true
    writeEvent(call, { type, session_id: sessionId, text: text ?? '', data_json: '' })
    call.end()
    child.stdin.end()
    child.kill('SIGTERM')
  }

  child.stderr.on('data', (chunk) => process.stderr.write(`[dsh ${profile}] ${chunk}`))
  child.on('exit', (code) => {
    if (!finished) finish('error', `dsh exited with code ${code}`)
  })
  call.on('cancelled', () => {
    finished = true
    child.stdin.end()
    child.kill('SIGTERM')
  })

  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message ?? 'json-rpc error'))
        else waiter.resolve(message.result)
        continue
      }
      if (message.method === 'session.event') {
        const event = message.params?.event
        const sid = message.params?.sessionId
        if (sid !== sessionId) continue
        if (event?.type === 'assistant/message') {
          const blocks = event.data?.message?.content ?? []
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
          if (text) {
            lastText = text
            writeEvent(call, { type: 'message', session_id: sessionId, text, data_json: '' })
          }
        } else if (event?.type === 'tool/call') {
          writeEvent(call, {
            type: 'status',
            session_id: sessionId,
            text: 'tool_call',
            data_json: JSON.stringify(event.data ?? {}),
          })
        }
        continue
      }
      if (message.method === 'session.status') {
        if (message.params?.sessionId === sessionId && message.params?.status === 'idle') {
          finish('final', lastText)
        }
      }
    }
  })

  try {
    writeEvent(call, { type: 'started', session_id: sessionId, text: profile, data_json: '' })
    await send('initialize', {
      cwd: CWD,
      provider: PROVIDER,
      model: MODEL,
      maxTokens: 4096,
    })
    await send('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: request.prompt }],
    })
  } catch (error) {
    finish('error', error instanceof Error ? error.message : String(error))
  }
}

const server = new grpc.Server()
server.addService(proto.DavinciAgent.service, {
  RunTask: (call) => {
    const request = call.request ?? {}
    runTask(call, request).catch((error) => {
      writeEvent(call, {
        type: 'error',
        session_id: request.session_id || '',
        text: error instanceof Error ? error.message : String(error),
        data_json: '',
      })
      call.end()
    })
  },
  Health: (_call, callback) => {
    callback(null, { ok: true, detail: `runner=${RUNNER}` })
  },
})

server.bindAsync(`127.0.0.1:${PORT}`, grpc.ServerCredentials.createInsecure(), (error, port) => {
  if (error) {
    console.error(`gateway bind failed: ${error.message}`)
    process.exit(1)
  }
  console.log(`davinci agent gateway listening on 127.0.0.1:${port}`)
})
