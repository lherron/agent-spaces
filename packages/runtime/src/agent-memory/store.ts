import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type MemoryTargetConfig, type MemoryTargetName, resolveMemoryPaths } from './paths.js'
import { type ScanResult, scan } from './scan.js'

export const ENTRY_DELIMITER = '\n§\n'

export type StoreResult =
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
  | Extract<ScanResult, { ok: false }>

export interface MemoryStoreOptions {
  agentName: string
  agentsRoot?: string | undefined
  testHooks?: MemoryStoreTestHooks | undefined
}

export interface MemoryStoreTestHooks {
  afterTempWrite?: (target: MemoryTargetName, tempPath: string) => Promise<void> | void
  beforeAtomicRename?: (target: MemoryTargetName, tempPath: string) => Promise<void> | void
}

export interface MemoryInspection {
  chars: number
  capChars: number
  bytes: number
  entries: number
  lastWrite: string | null
  path: string
  scope: MemoryTargetConfig['scope']
  zone: MemoryTargetConfig['zone']
}

type LockRelease = () => Promise<void>

const lockQueues = new Map<string, Promise<void>>()
let tempCounter = 0

export class MemoryStore {
  readonly name = 'agent-memory'

  private readonly targets: Record<MemoryTargetName, MemoryTargetConfig>
  private readonly testHooks?: MemoryStoreTestHooks | undefined

  constructor(options: MemoryStoreOptions) {
    this.targets = resolveMemoryPaths(options.agentName, options.agentsRoot)
    this.testHooks = options.testHooks
  }

  isAvailable(): boolean {
    return true
  }

  async prefetch(): Promise<void> {
    await Promise.all(
      Object.keys(this.targets).map((target) => this.inspect(target as MemoryTargetName))
    )
  }

  async systemPromptBlock(target: MemoryTargetName = 'memory'): Promise<string> {
    return this.read(target)
  }

  async inspect(target: MemoryTargetName): Promise<MemoryInspection> {
    const config = this.targetConfig(target)
    const content = await this.read(target)
    const lastWrite = existsSync(config.path) ? (await stat(config.path)).mtime.toISOString() : null

    return {
      chars: content.length,
      capChars: config.capChars,
      bytes: Buffer.byteLength(content, 'utf8'),
      entries: splitEntries(content).length,
      lastWrite,
      path: config.path,
      scope: config.scope,
      zone: config.zone,
    }
  }

  async read(target: MemoryTargetName): Promise<string> {
    const config = this.targetConfig(target)
    try {
      return await readFile(config.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return ''
      throw error
    }
  }

  async add(input: { target: MemoryTargetName; content: string }): Promise<StoreResult> {
    const scanResult = this.scanForTarget(input.target, input.content)
    if (!scanResult.ok) return this.storeScanFailure(scanResult)

    return this.withTargetLock(input.target, async (config) => {
      const existing = await readTargetContent(config)
      const next =
        existing.length === 0 ? input.content : `${existing}${ENTRY_DELIMITER}${input.content}`
      const capResult = checkCap(config, next)
      if (capResult) return capResult

      await this.atomicWrite(input.target, config, next)
      return { ok: true }
    })
  }

  async replace(input: {
    target: MemoryTargetName
    old: string
    content: string
  }): Promise<StoreResult> {
    const scanResult = this.scanForTarget(input.target, input.content)
    if (!scanResult.ok) return this.storeScanFailure(scanResult)

    return this.withTargetLock(input.target, async (config) => {
      const existing = await readTargetContent(config)
      const entries = splitEntries(existing)
      const matchResult = findMatches(entries, input.old)
      if (!matchResult.ok) return matchResult

      entries[matchResult.index] = input.content
      const next = entries.join(ENTRY_DELIMITER)
      const capResult = checkCap(config, next)
      if (capResult) return capResult

      await this.atomicWrite(input.target, config, next)
      return { ok: true }
    })
  }

  async remove(input: { target: MemoryTargetName; old: string }): Promise<StoreResult> {
    return this.withTargetLock(input.target, async (config) => {
      const existing = await readTargetContent(config)
      const entries = splitEntries(existing)
      const matchResult = findMatches(entries, input.old)
      if (!matchResult.ok) return matchResult

      entries.splice(matchResult.index, 1)
      await this.atomicWrite(input.target, config, entries.join(ENTRY_DELIMITER))
      return { ok: true }
    })
  }

  private targetConfig(target: MemoryTargetName): MemoryTargetConfig {
    return this.targets[target]
  }

  private scanForTarget(target: MemoryTargetName, content: string): ScanResult {
    const config = this.targetConfig(target)
    return scan(content, { categoriesToSkip: config.scannerCategoriesToSkip })
  }

  private storeScanFailure(result: Extract<ScanResult, { ok: false }>): StoreResult {
    if (result.category === 'delimiter') {
      return { ok: false, error: 'delimiter_in_content' }
    }
    return result
  }

  private async withTargetLock<T>(
    target: MemoryTargetName,
    action: (config: MemoryTargetConfig) => Promise<T>
  ): Promise<T> {
    const config = this.targetConfig(target)
    await mkdir(dirname(config.lockPath), { recursive: true })
    const release = await acquireAdvisoryLock(config.lockPath)

    try {
      return await action(config)
    } finally {
      await release()
    }
  }

  private async atomicWrite(
    target: MemoryTargetName,
    config: MemoryTargetConfig,
    content: string
  ): Promise<void> {
    await mkdir(dirname(config.path), { recursive: true })
    const tempPath = `${config.path}.tmp.${process.pid}.${++tempCounter}`
    const handle = await open(tempPath, 'w')

    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await this.testHooks?.afterTempWrite?.(target, tempPath)
    await this.testHooks?.beforeAtomicRename?.(target, tempPath)
    await rename(tempPath, config.path)
  }
}

async function readTargetContent(config: MemoryTargetConfig): Promise<string> {
  try {
    return await readFile(config.path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return ''
    throw error
  }
}

function splitEntries(content: string): string[] {
  if (content.length === 0) return []
  return content.split(ENTRY_DELIMITER)
}

function checkCap(
  config: MemoryTargetConfig,
  content: string
): Extract<StoreResult, { error: 'cap_exceeded' }> | null {
  if (content.length <= config.capChars) return null

  return {
    ok: false,
    error: 'cap_exceeded',
    chars: content.length,
    capChars: config.capChars,
    bytes: Buffer.byteLength(content, 'utf8'),
  }
}

function findMatches(
  entries: string[],
  oldSubstr: string
): { ok: true; index: number } | Extract<StoreResult, { error: 'not_found' | 'ambiguous_match' }> {
  const matches = entries.filter((entry) => entry.includes(oldSubstr))
  if (matches.length === 0) return { ok: false, error: 'not_found', matches: [] }
  if (matches.length > 1) return { ok: false, error: 'ambiguous_match', matches }
  return { ok: true, index: entries.findIndex((entry) => entry.includes(oldSubstr)) }
}

async function acquireAdvisoryLock(lockPath: string): Promise<LockRelease> {
  const proc = Bun.spawn(
    [
      'python3',
      '-c',
      [
        'import fcntl, os, sys',
        'fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o666)',
        'fcntl.lockf(fd, fcntl.LOCK_EX)',
        'sys.stdout.write("locked\\n")',
        'sys.stdout.flush()',
        'sys.stdin.buffer.read()',
      ].join('\n'),
      lockPath,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  const reader = proc.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()

  if (!ready.done && new TextDecoder().decode(ready.value).includes('locked')) {
    return async () => {
      proc.stdin.end()
      await proc.exited
    }
  }

  await proc.exited.catch(() => undefined)
  return acquireProcessLock(lockPath)
}

async function acquireProcessLock(lockPath: string): Promise<LockRelease> {
  const previous = lockQueues.get(lockPath) ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const tail = previous.then(() => current)
  lockQueues.set(lockPath, tail)

  await previous

  return async () => {
    if (lockQueues.get(lockPath) === tail) {
      lockQueues.delete(lockPath)
    }
    releaseCurrent()
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}
