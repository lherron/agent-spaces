import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SpoolEntry = {
  seq: number
  payload: unknown
  path: string
}

export async function spoolCallback(
  spoolDir: string,
  launchId: string,
  payload: object
): Promise<string> {
  const launchSpoolDir = join(spoolDir, launchId)
  await mkdir(launchSpoolDir, { recursive: true })

  const existing = await readExistingSeqs(launchSpoolDir)
  const nextSeq = existing.length > 0 ? Math.max(...existing) + 1 : 1

  const filePath = join(launchSpoolDir, `${String(nextSeq).padStart(6, '0')}.json`)
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  return filePath
}

export async function readSpoolEntries(spoolDir: string, launchId: string): Promise<SpoolEntry[]> {
  const launchSpoolDir = join(spoolDir, launchId)

  let files: string[]
  try {
    files = await readdir(launchSpoolDir)
  } catch {
    return []
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json')).sort()

  const entries: SpoolEntry[] = []
  for (const file of jsonFiles) {
    const seq = Number.parseInt(file.replace('.json', ''), 10)
    if (Number.isNaN(seq)) continue

    const filePath = join(launchSpoolDir, file)
    const raw = await readFile(filePath, 'utf-8')
    entries.push({
      seq,
      payload: JSON.parse(raw),
      path: filePath,
    })
  }

  return entries
}

async function readExistingSeqs(dir: string): Promise<number[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => Number.parseInt(f.replace('.json', ''), 10))
    .filter((n) => !Number.isNaN(n))
}
