#!/usr/bin/env bun
/**
 * A deliberately altered aspd subject for the compare runner (T-11833 close
 * condition 2): proves the runner fails, naming the case, when a subject
 * differs in one reply field or one materialized byte.
 *
 *   bun scripts/aspd-compare/altered-subject.ts <alteration> serve --socket <s> --log <l>
 *
 * It starts the release's real aspd ($ASPD_COMPARE_RELEASE/aspd) on `<socket dir>/aspd-real.sock` and fronts it on
 * <s>, relaying frames verbatim except for the one alteration:
 *   reply:<method>:<dotted.path>=<json>  set that field in replies to <method>
 *   tree:<ASP_HOME-relative file>        after each compile reply, append one
 *                                        byte to that file once it exists
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { type Socket, connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'

const [alteration, command, ...rest] = process.argv.slice(2)
const aspd = join(process.env['ASPD_COMPARE_RELEASE'] ?? '', 'aspd')
const flag = (name: string) => rest[rest.indexOf(name) + 1] as string
if (alteration === undefined || command !== 'serve') {
  process.stderr.write('usage: altered-subject.ts <alteration> serve --socket <s> --log <l>\n')
  process.exit(2)
}
const cut = (value: string) => {
  const index = value.indexOf(':')
  return [value.slice(0, index), value.slice(index + 1)] as const
}
const [kind, target] = cut(alteration)
const [method, spec] = kind === 'reply' ? cut(target) : [undefined, undefined]
const [fieldPath, fieldJson] = spec?.split(/=(.*)/s) ?? []
if (!(kind === 'tree' || (kind === 'reply' && fieldPath && fieldJson !== undefined))) {
  process.stderr.write(`unknown alteration ${alteration}\n`)
  process.exit(2)
}
const socketPath = flag('--socket')
const upstreamPath = join(dirname(socketPath), 'aspd-real.sock')

const real = spawn(aspd, ['serve', '--socket', upstreamPath, '--log', flag('--log')], {
  stdio: 'inherit',
})
const shutdown = () => {
  real.kill('SIGTERM')
  real.once('exit', () => process.exit(0))
}
process.on('SIGTERM', shutdown)
real.once('exit', () => process.exit(1))

function alter(line: string, methods: Map<unknown, string>): string {
  let reply: Record<string, unknown>
  try {
    reply = JSON.parse(line) as Record<string, unknown>
  } catch {
    return line
  }
  const repliedTo = methods.get(reply['id'])
  if (kind === 'reply' && repliedTo === method) {
    const keys = (fieldPath as string).split('.')
    let cursor: Record<string, unknown> | undefined = reply
    for (const key of keys.slice(0, -1)) cursor = cursor?.[key] as Record<string, unknown>
    // Replies without the field (refusals) pass through unaltered.
    if (cursor === undefined || !((keys.at(-1) as string) in cursor)) return line
    cursor[keys.at(-1) as string] = JSON.parse(fieldJson as string)
    return JSON.stringify(reply)
  }
  const file = join(process.env['ASP_HOME'] as string, target)
  if (kind === 'tree' && repliedTo === 'aspc.compileHarnessInvocation' && existsSync(file)) {
    appendFileSync(file, '\n')
  }
  return line
}

function relay(client: Socket): void {
  const upstream = connect(upstreamPath)
  const methods = new Map<unknown, string>()
  let fromClient = ''
  let fromUpstream = ''
  // One decoder per stream: a multibyte character split across reads
  // must not decode as U+FFFD (e14d0fb9).
  const fromClientDecoder = new TextDecoder()
  client.on('data', (chunk) => {
    fromClient += fromClientDecoder.decode(chunk, { stream: true })
    const lines = fromClient.split('\n')
    fromClient = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const frame = JSON.parse(line) as { id?: unknown; method?: string }
        if (frame.method !== undefined) methods.set(frame.id, frame.method)
      } catch {
        // relayed verbatim; aspd answers it
      }
      upstream.write(`${line}\n`)
    }
  })
  // One decoder per stream: a multibyte character split across reads
  // must not decode as U+FFFD (e14d0fb9).
  const fromUpstreamDecoder = new TextDecoder()
  upstream.on('data', (chunk) => {
    fromUpstream += fromUpstreamDecoder.decode(chunk, { stream: true })
    const lines = fromUpstream.split('\n')
    fromUpstream = lines.pop() ?? ''
    for (const line of lines) client.write(`${alter(line, methods)}\n`)
  })
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
}

while (!existsSync(upstreamPath)) await Bun.sleep(50)
rmSync(socketPath, { force: true })
createServer(relay).listen(socketPath)
