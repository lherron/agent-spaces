import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sweepAspTempArtifacts, writeRuntimeSystemPromptArtifact } from './temp-lifecycle.js'

const tempRoots: string[] = []

afterEach(async () => {
  const roots = tempRoots.splice(0)
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function tempAspHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asp-temp-lifecycle-'))
  tempRoots.push(root)
  return root
}

async function mkdirWithAge(path: string, ageMs: number, nowMs: number): Promise<void> {
  await mkdir(path, { recursive: true })
  const date = new Date(nowMs - ageMs)
  await utimes(path, date, date)
}

describe('ASP temp lifecycle', () => {
  test('sweeps stale launch overlays and preserves fresh overlays', async () => {
    const aspHome = await tempAspHome()
    const nowMs = Date.now()
    const stale = join(aspHome, 'tmp', 'launch-overlays', 'stale')
    const fresh = join(aspHome, 'tmp', 'launch-overlays', 'fresh')
    await mkdirWithAge(stale, 20_000, nowMs)
    await mkdirWithAge(fresh, 1_000, nowMs)

    const result = await sweepAspTempArtifacts({
      aspHome,
      nowMs,
      launchOverlayMaxAgeMs: 10_000,
    })

    expect(result.launchOverlays.removed).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test('sweeps stale staging debris but keeps fresh and live-pid staging dirs', async () => {
    const aspHome = await tempAspHome()
    const nowMs = Date.now()
    const dead = join(
      aspHome,
      'tmp',
      '.staging',
      'bundle-target-99999999-00000000-0000-4000-8000-000000000000'
    )
    const live = join(
      aspHome,
      'tmp',
      '.staging',
      `bundle-target-${process.pid}-00000000-0000-4000-8000-000000000001`
    )
    const fresh = join(
      aspHome,
      'tmp',
      '.staging',
      'bundle-target-99999998-00000000-0000-4000-8000-000000000002'
    )
    await mkdirWithAge(dead, 20_000, nowMs)
    await mkdirWithAge(live, 20_000, nowMs)
    await mkdirWithAge(fresh, 1_000, nowMs)

    const result = await sweepAspTempArtifacts({
      aspHome,
      nowMs,
      stagingMaxAgeMs: 10_000,
    })

    expect(result.staging.removed).toBe(1)
    expect(result.staging.skippedLive).toBe(1)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
  })

  test('writes system prompt artifacts outside tmp', async () => {
    const aspHome = await tempAspHome()
    const artifact = await writeRuntimeSystemPromptArtifact({
      aspHome,
      content: 'stable prompt',
    })

    expect(artifact.systemPromptPath).toContain(join(aspHome, 'runtime-artifacts'))
    expect(artifact.systemPromptPath).not.toContain(join('tmp', 'launch-overlays'))
    expect(await Bun.file(artifact.systemPromptPath).text()).toBe('stable prompt')
  })
})
