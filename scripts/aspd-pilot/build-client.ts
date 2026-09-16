#!/usr/bin/env bun
/**
 * Build the aspd pilot client (T-08539) into one standalone executable and
 * prove its module closure contains only wire contracts, framing and transport.
 * The closure is read from Bun's own build metafile — what was actually bundled
 * — so an ASP configuration, compiler or execution module anywhere in the graph
 * fails the build.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = 'scripts/aspd-pilot/client.ts'

/** Workspace directories the client may bundle source from. */
export const ALLOWED_CLIENT_SOURCE_ROOTS = [
  'scripts/aspd-pilot/client.ts',
  'contracts/aspc-protocol/src/',
  'contracts/harness-broker-client/src/',
  'contracts/harness-broker-protocol/src/',
  'contracts/spaces-runtime-contracts/src/',
] as const

export function forbiddenClientInputs(inputs: string[]): string[] {
  return inputs.filter(
    (input) =>
      !input.startsWith('node:') &&
      !ALLOWED_CLIENT_SOURCE_ROOTS.some((allowed) => input === allowed || input.startsWith(allowed))
  )
}

function run(cmd: string[]): string {
  const result = Bun.spawnSync({ cmd, cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().trim()
}

async function main(outputRootInput: string | undefined): Promise<void> {
  if (outputRootInput === undefined || !isAbsolute(outputRootInput)) {
    throw new Error('usage: build-client.ts <absolute-output-root>')
  }
  const sourceCommit = run(['git', 'rev-parse', 'HEAD'])
  if (run(['git', 'status', '--porcelain', '--untracked-files=all']).length > 0) {
    throw new Error('source checkout must be clean before building the pilot client')
  }
  const id = `aspd-pilot-client-${sourceCommit.slice(0, 12)}`
  const outDir = join(resolve(outputRootInput), id)
  mkdirSync(outDir, { recursive: true })
  const executable = join(outDir, 'aspd-pilot-client')
  const metafile = join(outDir, 'metafile.json')
  run([
    'bun',
    'build',
    '--compile',
    '--target=bun',
    `--metafile=${metafile}`,
    '--outfile',
    executable,
    ENTRY,
  ])
  const meta = JSON.parse(readFileSync(metafile, 'utf8')) as { inputs: Record<string, unknown> }
  const inputs = Object.keys(meta.inputs).map((input) =>
    isAbsolute(input) ? relative(REPO_ROOT, input) : input
  )
  const forbidden = forbiddenClientInputs(inputs)
  if (forbidden.length > 0) {
    throw new Error(`pilot client closure contains non-contract modules:\n${forbidden.join('\n')}`)
  }
  chmodSync(executable, 0o555)
  const manifest = {
    schemaVersion: 'aspd-pilot-client/v1',
    id,
    sourceCommit,
    builtAt: new Date().toISOString(),
    executable,
    sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    closure: {
      allowedRoots: ALLOWED_CLIENT_SOURCE_ROOTS,
      inputCount: inputs.length,
      packages: [...new Set(inputs.map((input) => input.split('/src/')[0]))].sort(),
    },
  }
  writeFileSync(join(outDir, 'client.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

if (import.meta.main) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
