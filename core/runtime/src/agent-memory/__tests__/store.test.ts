/**
 * Red/green ownership for wrkq T-01482.
 *
 * Defines the Phase B store contract against temp agents roots only. These
 * tests must never read or write the real praesidium agents directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const ENTRY_DELIMITER = '\n§\n'

type MemoryTargetName = 'memory' | 'user' | 'persona'
type StoreResult =
  | { ok: true }
  | {
      ok: false
      error: 'cap_exceeded'
      chars: number
      capChars: number
      bytes: number
    }
  | { ok: false; error: 'delimiter_in_content' }
  | { ok: false; error: 'not_found'; matches: string[] }
  | { ok: false; error: 'ambiguous_match'; matches: string[] }

interface MemoryStore {
  add(input: { target: MemoryTargetName; content: string }): Promise<StoreResult>
  replace(input: { target: MemoryTargetName; old: string; content: string }): Promise<StoreResult>
  remove(input: { target: MemoryTargetName; old: string }): Promise<StoreResult>
  inspect(target: MemoryTargetName): Promise<{
    chars: number
    capChars: number
    bytes: number
    entries: number
    lastWrite: string | null
    path: string
    scope: 'per-agent' | 'shared-editable'
    zone: 'reminder' | 'prompt'
  }>
}

type TestHooks = {
  afterTempWrite?: (target: MemoryTargetName, tempPath: string) => Promise<void> | void
  beforeAtomicRename?: (target: MemoryTargetName, tempPath: string) => Promise<void> | void
}

interface StoreModule {
  MemoryStore: new (options: {
    agentName: string
    agentsRoot: string
    testHooks?: TestHooks | undefined
  }) => MemoryStore
}

describe('agent-memory store', () => {
  let tempAgentsRoot: string
  let store: MemoryStore

  beforeEach(async () => {
    tempAgentsRoot = await mkdtemp(join(tmpdir(), 'agent-memory-store-'))
    store = await createStore(tempAgentsRoot)
  })

  afterEach(async () => {
    await rm(tempAgentsRoot, { recursive: true, force: true })
  })

  test('add appends entries with the section-sign delimiter and no leading delimiter', async () => {
    await expect(store.add({ target: 'memory', content: 'first fact' })).resolves.toEqual({
      ok: true,
    })
    await expect(store.add({ target: 'memory', content: 'second fact' })).resolves.toEqual({
      ok: true,
    })

    expect(readTarget('memory')).toBe(`first fact${ENTRY_DELIMITER}second fact`)
  })

  test('replace swaps exactly one substring-matched entry and preserves position', async () => {
    await seed('memory', ['alpha notes', 'bravo notes', 'charlie notes'])

    await expect(
      store.replace({ target: 'memory', old: 'bravo', content: 'BRAVO updated' })
    ).resolves.toEqual({
      ok: true,
    })

    expect(readTarget('memory')).toBe(
      ['alpha notes', 'BRAVO updated', 'charlie notes'].join(ENTRY_DELIMITER)
    )
  })

  test('replace reports ambiguous and missing substring matches without changing disk', async () => {
    await seed('memory', ['alpha one', 'alpha two', 'bravo'])

    await expect(
      store.replace({ target: 'memory', old: 'alpha', content: 'replacement' })
    ).resolves.toEqual({
      ok: false,
      error: 'ambiguous_match',
      matches: ['alpha one', 'alpha two'],
    })
    await expect(
      store.replace({ target: 'memory', old: 'missing', content: 'replacement' })
    ).resolves.toEqual({
      ok: false,
      error: 'not_found',
      matches: [],
    })
    expect(readTarget('memory')).toBe(['alpha one', 'alpha two', 'bravo'].join(ENTRY_DELIMITER))
  })

  test.each([
    {
      target: 'memory' as const,
      accepted: 'a'.repeat(2198),
      overflow: 'b',
      capChars: 2200,
    },
    {
      target: 'persona' as const,
      accepted: 'x'.repeat(4096),
      overflow: 'y'.repeat(9000),
      capChars: 8192,
    },
  ])(
    'rejects $target cap overflow using content.length including delimiters and reports bytes',
    async ({ target, accepted, overflow, capChars }) => {
      await expect(store.add({ target, content: accepted })).resolves.toEqual({ ok: true })

      const nextContent = `${accepted}${ENTRY_DELIMITER}${overflow}`
      await expect(store.add({ target, content: overflow })).resolves.toEqual({
        ok: false,
        error: 'cap_exceeded',
        chars: nextContent.length,
        capChars,
        bytes: Buffer.byteLength(nextContent, 'utf8'),
      })
      expect(readTarget(target)).toBe(accepted)
    }
  )

  test('add and replace reject content containing the entry delimiter and leave the file unchanged', async () => {
    await seed('memory', ['alpha'])

    await expect(
      store.add({ target: 'memory', content: `bad${ENTRY_DELIMITER}split` })
    ).resolves.toEqual({
      ok: false,
      error: 'delimiter_in_content',
    })
    await expect(
      store.replace({ target: 'memory', old: 'alpha', content: `bad${ENTRY_DELIMITER}split` })
    ).resolves.toEqual({
      ok: false,
      error: 'delimiter_in_content',
    })
    expect(readTarget('memory')).toBe('alpha')
  })

  test('inspect returns chars, capChars, bytes, entries, lastWrite, path, scope, and zone', async () => {
    await seed('memory', ['alpha', 'bravo'])

    const inspected = await store.inspect('memory')

    expect(inspected).toEqual({
      chars: `alpha${ENTRY_DELIMITER}bravo`.length,
      capChars: 2200,
      bytes: Buffer.byteLength(`alpha${ENTRY_DELIMITER}bravo`, 'utf8'),
      entries: 2,
      lastWrite: expect.any(String),
      path: join(tempAgentsRoot, 'smokey', 'memory', 'MEMORY.md'),
      scope: 'per-agent',
      zone: 'reminder',
    })
  })

  test('atomic write leaves the previous MEMORY.md intact if the process crashes before rename', async () => {
    await seed('memory', ['stable'])
    let released = false
    const crashingStore = await createStore(tempAgentsRoot, {
      async afterTempWrite() {
        released = true
        throw new Error('simulated crash after temp write before rename')
      },
    })

    await expect(crashingStore.add({ target: 'memory', content: 'new content' })).rejects.toThrow(
      /simulated crash/
    )

    expect(released).toBe(true)
    expect(readTarget('memory')).toBe('stable')
    expect(
      tempFilesFor('memory').every((path) => basename(path).startsWith('MEMORY.md.tmp.'))
    ).toBe(true)
  })

  test('concurrent writes serialize through the sibling lock and both entries are preserved', async () => {
    let releaseFirst!: () => void
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstReachedRename = false
    const slowStore = await createStore(tempAgentsRoot, {
      async beforeAtomicRename() {
        firstReachedRename = true
        await firstMayContinue
      },
    })
    const fastStore = await createStore(tempAgentsRoot)

    const first = slowStore.add({ target: 'memory', content: 'first lock holder' })
    await eventually(() => firstReachedRename)
    const second = fastStore.add({ target: 'memory', content: 'second waits for lock' })

    await Bun.sleep(25)
    expect(existsSync(memoryPath('memory'))).toBe(false)

    releaseFirst()
    await expect(first).resolves.toEqual({ ok: true })
    await expect(second).resolves.toEqual({ ok: true })
    expect(readTarget('memory')).toBe(
      ['first lock holder', 'second waits for lock'].join(ENTRY_DELIMITER)
    )
  })

  async function seed(target: MemoryTargetName, entries: string[]) {
    const targetPath = memoryPath(target)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, entries.join(ENTRY_DELIMITER))
  }

  function readTarget(target: MemoryTargetName) {
    return readFileSync(memoryPath(target), 'utf8')
  }

  function memoryPath(target: MemoryTargetName) {
    if (target === 'memory') return join(tempAgentsRoot, 'smokey', 'memory', 'MEMORY.md')
    if (target === 'persona') return join(tempAgentsRoot, 'smokey', 'SOUL.md')
    return join(tempAgentsRoot, 'USER.md')
  }

  function tempFilesFor(target: MemoryTargetName) {
    const dir = dirname(memoryPath(target))
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((entry) => entry.includes('.tmp.'))
      .map((entry) => join(dir, entry))
  }
})

async function createStore(agentsRoot: string, testHooks?: TestHooks): Promise<MemoryStore> {
  const { MemoryStore } = await loadStoreModule()
  return new MemoryStore({ agentName: 'smokey', agentsRoot, testHooks })
}

async function loadStoreModule(): Promise<StoreModule> {
  try {
    return (await import('../store.js')) as StoreModule
  } catch {
    throw new Error('Expected core/runtime/src/agent-memory/store.ts to export MemoryStore.')
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for expected async state')
    }
    await Bun.sleep(5)
  }
}
