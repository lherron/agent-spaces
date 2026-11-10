#!/usr/bin/env bun
/**
 * Record the Bun replies the native half of the table test compares raspd
 * against (T-13048): each case of native.json sent to a release's Bun aspd
 * (`<release>/libexec/aspd`, the T-13008 oracle) on the native rig, written
 * to bun-replies/<case id>.json. Rerun when a native case or the fixture
 * changes; verify only reads the files.
 *
 * Usage: bun scripts/raspd-sole/record-bun.ts --aspd <release>/libexec/aspd [--only <re>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BUN_REPLIES, ORACLE, captureNative } from './native.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const aspd = arg('--aspd')
if (aspd === undefined) {
  console.error('usage: record-bun.ts --aspd <release>/libexec/aspd [--only <re>]')
  process.exit(2)
}
const only = arg('--only') ? new RegExp(arg('--only') as string) : undefined
const manifest = JSON.parse(readFileSync(join(dirname(dirname(aspd)), 'release.json'), 'utf8'))
const identity = {
  releaseId: manifest.releaseId,
  sourceCommit: manifest.sourceCommit,
  builtAt: manifest.builtAt,
}
const captures = await captureNative(aspd, 'bun', identity, only)
mkdirSync(BUN_REPLIES, { recursive: true })
writeFileSync(ORACLE, `${JSON.stringify(identity, null, 2)}\n`)
for (const [id, capture] of Object.entries(captures))
  writeFileSync(join(BUN_REPLIES, `${id}.json`), `${JSON.stringify(capture, null, 2)}\n`)
console.log(`recorded ${Object.keys(captures).length} cases`)
