#!/usr/bin/env bun
/**
 * T-01681 spike recorder — the target of HRC_LAUNCH_HOOK_CLI.
 *
 * Codex invokes the materialized hook command `bun "$HRC_LAUNCH_HOOK_CLI"` for
 * each wired lifecycle event, passing the raw hook payload JSON on stdin. This
 * recorder tees that RAW, unnormalized stdin into ASP_SPIKE_PAYLOAD_DIR:
 *   - payloads/<hook_event_name>-<seq>.json  (one file per event occurrence)
 *   - payloads/all.jsonl                     (every payload + receivedAt, appended)
 *
 * It is pure capture — it does not normalize, deliver, or block. Exit 0 always so
 * codex's turn is never disrupted by the spike.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

const dir = process.env['ASP_SPIKE_PAYLOAD_DIR']
if (dir === undefined || dir.length === 0) {
  // No sink configured — behave like a no-op so we never disrupt the turn.
  process.exit(0)
}

const raw = await readStdin()
mkdirSync(dir, { recursive: true })

const receivedAt = new Date().toISOString()
let eventName = 'unknown'
let parsed: unknown
try {
  parsed = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && 'hook_event_name' in parsed) {
    const v = (parsed as Record<string, unknown>)['hook_event_name']
    if (typeof v === 'string' && v.length > 0) eventName = v
  }
} catch {
  // keep raw even if it is not JSON
}

// Monotonic-ish sequence via high-res-ish timestamp so multiple same-event
// occurrences in one run don't clobber each other.
const seq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)
  .toString(36)
  .padStart(3, '0')}`
const safeEvent = eventName.replace(/[^A-Za-z0-9_-]/g, '_')

writeFileSync(join(dir, `${safeEvent}-${seq}.json`), raw.endsWith('\n') ? raw : `${raw}\n`)
appendFileSync(
  join(dir, 'all.jsonl'),
  `${JSON.stringify({ receivedAt, hook_event_name: eventName, raw: parsed ?? raw })}\n`
)

process.exit(0)
