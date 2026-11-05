/**
 * Release retention at activation (R-00600): every install adds a ~270 MB
 * read-only release dir, so activation prunes old ones. It must keep the
 * active release, the rollback, every release a live process still runs from
 * (seats keep their broker and hook binaries from the release they started on),
 * and the newest few.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneReleases } from './aspd-service/release-retention.ts'

const dirs: string[] = []
const children: { kill(): void }[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of dirs.splice(0)) {
    chmodTree(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

function chmodTree(dir: string): void {
  if (!existsSync(dir)) return
  chmodSync(dir, 0o755)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodTree(join(dir, entry.name))
  }
}

/** A release dir shaped like an installed one: read-only, with a nested read-only dir. */
function installRelease(releases: string, id: string): void {
  const root = join(releases, id)
  mkdirSync(join(root, 'libexec'), { recursive: true })
  writeFileSync(join(root, 'libexec', 'harness-broker'), '#!/bin/sh\n')
  writeFileSync(join(root, 'release.json'), '{}')
  chmodSync(join(root, 'libexec'), 0o555)
  chmodSync(root, 0o555)
}

const IDS = [
  'asp-000000000001-20261020T100000Z-aaaaaa',
  'asp-000000000002-20261022T100000Z-bbbbbb',
  'asp-000000000003-20261024T100000Z-cccccc',
  'asp-000000000004-20261026T100000Z-dddddd',
  'asp-000000000005-20261028T100000Z-eeeeee',
  'asp-000000000006-20261030T100000Z-ffffff',
  'asp-000000000007-20261101T100000Z-111111',
  'asp-000000000008-20261103T100000Z-222222',
]

describe('aspd release retention', () => {
  test('keeps active, rollback, releases a live process runs from, and the newest three', async () => {
    const releases = mkdtempSync(join(tmpdir(), 'aspd-retention-'))
    dirs.push(releases)
    for (const id of IDS) installRelease(releases, id)

    // A real process still running from an old release, as a long-lived seat's
    // broker does after a newer activation.
    const inUse = IDS[1] as string
    const child = Bun.spawn([
      '/bin/sh',
      '-c',
      // `; :` keeps sh alive (no exec into sleep), so its argv names the release.
      'sleep 30; :',
      join(releases, inUse, 'libexec', 'harness-broker'),
    ])
    children.push(child)
    await Bun.sleep(100)

    const result = pruneReleases(releases, {
      activeReleaseId: IDS[6] as string,
      previousReleaseId: IDS[3] as string,
    })

    const remaining = readdirSync(releases).sort()
    // Newest three (6, 7, 8 by timestamp) + active (7) + rollback (4) + in-use (2).
    expect(remaining).toEqual([IDS[1], IDS[3], IDS[5], IDS[6], IDS[7]].sort())
    expect(result.removed.sort()).toEqual([IDS[0], IDS[2], IDS[4]].sort())
    expect(result.inUse).toContain(inUse)
    expect(result.failed).toEqual([])
  })

  test('ignores entries that are not release dirs', () => {
    const releases = mkdtempSync(join(tmpdir(), 'aspd-retention-other-'))
    dirs.push(releases)
    for (const id of IDS.slice(0, 5)) installRelease(releases, id)
    writeFileSync(join(releases, 'README'), 'not a release')
    mkdirSync(join(releases, 'scratch'))

    const result = pruneReleases(releases, {
      activeReleaseId: IDS[4] as string,
      previousReleaseId: IDS[3] as string,
    })

    expect(result.removed.sort()).toEqual([IDS[0], IDS[1]].sort())
    expect(readdirSync(releases).sort()).toEqual(
      ['README', 'scratch', IDS[2], IDS[3], IDS[4]].sort()
    )
  })
})
