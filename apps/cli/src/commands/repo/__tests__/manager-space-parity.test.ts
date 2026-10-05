/**
 * Parity between the embedded manager space and spaces/agent-spaces-manager/.
 *
 * WHY: `asp repo init` writes the embedded copy (the CLI publishes dist/ only,
 * so it cannot read spaces/ at runtime). The two copies drifted silently
 * (T-10291); this test makes any future drift fail loudly.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { getManagerSpaceFiles } from '../manager-space-content'

const SPACE_DIR = resolve(import.meta.dir, '../../../../../../spaces/agent-spaces-manager')

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(SPACE_DIR, join(entry.parentPath, entry.name)))
    .sort()
}

describe('embedded manager space parity', () => {
  const embedded = getManagerSpaceFiles()

  test('embedded and spaces/ copies list the same files', () => {
    const embeddedPaths = embedded.map((file) => file.path).sort()
    expect(embeddedPaths).toEqual(listFiles(SPACE_DIR))
  })

  for (const file of embedded) {
    test(`${file.path} is byte-identical to spaces/agent-spaces-manager/${file.path}`, () => {
      const onDisk = readFileSync(join(SPACE_DIR, file.path))
      expect(Buffer.from(file.content, 'utf8').equals(onDisk)).toBe(true)
      expect(file.content).toBe(onDisk.toString('utf8'))
    })
  }
})
