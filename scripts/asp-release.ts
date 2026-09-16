#!/usr/bin/env bun

import { createHash, randomBytes } from 'node:crypto'
import {
  constants,
  accessSync,
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const RELEASE_SCHEMA = 'asp-standalone-release/v1' as const

const EXECUTABLES = {
  'aspc-facade': 'scripts/asp-release/entries/aspc-facade.ts',
  'harness-broker': 'scripts/asp-release/entries/harness-broker.ts',
} as const

type ExecutableName = keyof typeof EXECUTABLES

type ReleaseExecutable = {
  launcher: string
  launcherSha256: string
  payload: string
  payloadSha256: string
  runtimeClosure: 'bun-compiled'
}

export type AspReleaseManifest = {
  schemaVersion: typeof RELEASE_SCHEMA
  releaseId: string
  sourceCommit: string
  builtAt: string
  platform: string
  architecture: string
  executables: Record<ExecutableName, ReleaseExecutable>
}

export type ReleaseInspection = {
  ok: true
  releasePath: string
  releaseId: string
  sourceCommit: string
  builtAt: string
  platform: string
  architecture: string
  immutable: true
  executableResolution: Record<
    ExecutableName,
    { launcher: string; payload: string; observedReleaseId: string; observedSourceCommit: string }
  >
  runtimeClosure: 'bun-compiled'
  mutableCheckoutReferences: false
}

function fail(message: string): never {
  throw new Error(`asp-release: ${message}`)
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]
    if (current === undefined || !current.startsWith('--')) fail(`unexpected argument: ${current}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`missing value for ${current}`)
    flags.set(current.slice(2), value)
    index += 1
  }
  return flags
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim()
  if (value === undefined || value.length === 0) fail(`missing --${name} <value>`)
  return value
}

function run(command: string[], cwd = REPO_ROOT): string {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    fail(`command failed (${command.join(' ')}): ${stderr || `exit ${result.exitCode}`}`)
  }
  return result.stdout.toString().trim()
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) fail(`${label} must be absolute: ${path}`)
  return resolve(path)
}

function assertDirectChild(parent: string, child: string): void {
  if (dirname(child) !== parent) fail(`refusing path outside direct release root: ${child}`)
}

function assertWithin(root: string, path: string): void {
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`path escapes release: ${path}`)
  }
}

function releaseId(sourceCommit: string): string {
  const compactTime = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `asp-${sourceCommit.slice(0, 12)}-${compactTime}-${randomBytes(3).toString('hex')}`
}

function launcherScript(
  name: ExecutableName,
  id: string,
  sourceCommit: string,
  builtAt: string
): string {
  const info = JSON.stringify({
    schemaVersion: RELEASE_SCHEMA,
    releaseId: id,
    sourceCommit,
    builtAt,
    executable: name,
    runtimeClosure: 'bun-compiled',
  })
  return `#!/bin/sh
set -eu
release_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ "\${1-}" = "--release-info" ]; then
  printf '%s\\n' '${info}'
  exit 0
fi
export ASP_RELEASE_ID='${id}'
export ASP_RELEASE_SOURCE_COMMIT='${sourceCommit}'
export ASP_RELEASE_ROOT="$release_root"
exec "$release_root/libexec/${name}" "$@"
`
}

function chmodTreeReadOnly(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail(`release must not contain symlinks: ${path}`)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry))
      chmodSync(path, 0o555)
      return
    }
    const executable = (stat.mode & 0o111) !== 0
    chmodSync(path, executable ? 0o555 : 0o444)
  }
  visit(root)
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: false, mode: 0o755 })
  for (const entry of readdirSync(source)) {
    const sourcePath = join(source, entry)
    const destinationPath = join(destination, entry)
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) fail(`release must not contain symlinks: ${sourcePath}`)
    if (stat.isDirectory()) copyTree(sourcePath, destinationPath)
    else copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL)
  }
}

function readManifest(releasePath: string): AspReleaseManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(releasePath, 'release.json'), 'utf8'))
  } catch (error) {
    fail(`cannot read release manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) fail('release manifest is not an object')
  const manifest = parsed as Partial<AspReleaseManifest>
  if (manifest.schemaVersion !== RELEASE_SCHEMA) fail('unsupported release manifest schema')
  if (typeof manifest.releaseId !== 'string' || !/^asp-[a-zA-Z0-9._-]+$/.test(manifest.releaseId)) {
    fail('invalid release identity')
  }
  if (typeof manifest.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) {
    fail('invalid source commit')
  }
  if (typeof manifest.builtAt !== 'string' || Number.isNaN(Date.parse(manifest.builtAt))) {
    fail('invalid build timestamp')
  }
  if (typeof manifest.executables !== 'object' || manifest.executables === null) {
    fail('missing executable manifest')
  }
  return manifest as AspReleaseManifest
}

export function inspectRelease(inputPath: string): ReleaseInspection {
  const releasePath = assertAbsolute(inputPath, 'release path')
  const rootStat = lstatSync(releasePath)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail('release path must be a real directory')
  const manifest = readManifest(releasePath)
  if (basename(releasePath) !== manifest.releaseId) {
    fail(`release directory must equal release identity: ${manifest.releaseId}`)
  }

  const canonicalRoot = realpathSync(releasePath)
  const resolution = {} as ReleaseInspection['executableResolution']
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail(`release must not contain symlinks: ${path}`)
    if ((stat.mode & 0o222) !== 0) fail(`release path is writable: ${path}`)
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  visit(releasePath)

  for (const name of Object.keys(EXECUTABLES) as ExecutableName[]) {
    const executable = manifest.executables[name]
    if (executable?.runtimeClosure !== 'bun-compiled') fail(`invalid runtime closure for ${name}`)
    const launcher = resolve(releasePath, executable.launcher)
    const payload = resolve(releasePath, executable.payload)
    assertWithin(releasePath, launcher)
    assertWithin(releasePath, payload)
    if (!realpathSync(launcher).startsWith(`${canonicalRoot}${sep}`))
      fail(`${name} launcher escapes release`)
    if (!realpathSync(payload).startsWith(`${canonicalRoot}${sep}`))
      fail(`${name} payload escapes release`)
    accessSync(launcher, constants.X_OK)
    accessSync(payload, constants.X_OK)
    if (sha256(launcher) !== executable.launcherSha256) fail(`${name} launcher digest mismatch`)
    if (sha256(payload) !== executable.payloadSha256) fail(`${name} payload digest mismatch`)
    const payloadBytes = readFileSync(payload)
    for (const mutableRoot of [REPO_ROOT, resolve(REPO_ROOT, '..', 'hrc-runtime')]) {
      if (payloadBytes.includes(Buffer.from(mutableRoot))) {
        fail(`${name} payload retains mutable checkout reference: ${mutableRoot}`)
      }
    }
    const identityResult = Bun.spawnSync({
      cmd: [launcher, '--release-info'],
      cwd: releasePath,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (identityResult.exitCode !== 0) {
      fail(`${name} release identity probe failed: ${identityResult.stderr.toString().trim()}`)
    }
    let identity: Record<string, unknown>
    try {
      identity = JSON.parse(identityResult.stdout.toString()) as Record<string, unknown>
    } catch {
      fail(`${name} release identity probe returned invalid JSON`)
    }
    if (
      identity['releaseId'] !== manifest.releaseId ||
      identity['sourceCommit'] !== manifest.sourceCommit ||
      identity['executable'] !== name ||
      identity['runtimeClosure'] !== 'bun-compiled'
    ) {
      fail(`${name} release identity does not match the manifest`)
    }
    resolution[name] = {
      launcher,
      payload,
      observedReleaseId: manifest.releaseId,
      observedSourceCommit: manifest.sourceCommit,
    }
  }

  return {
    ok: true,
    releasePath,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    builtAt: manifest.builtAt,
    platform: manifest.platform,
    architecture: manifest.architecture,
    immutable: true,
    executableResolution: resolution,
    runtimeClosure: 'bun-compiled',
    mutableCheckoutReferences: false,
  }
}

function assertCleanSource(): string {
  const sourceCommit = run(['git', 'rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail(`unexpected source commit: ${sourceCommit}`)
  const dirty = run(['git', 'status', '--porcelain', '--untracked-files=all'])
  if (dirty.length > 0) fail('source checkout must be clean before building a release')
  return sourceCommit
}

async function buildRelease(outputRootInput: string): Promise<ReleaseInspection> {
  const outputRoot = assertAbsolute(outputRootInput, 'output root')
  mkdirSync(outputRoot, { recursive: true })
  const sourceCommit = assertCleanSource()
  const builtAt = new Date().toISOString()
  const id = releaseId(sourceCommit)
  const destination = join(outputRoot, id)
  const staging = join(outputRoot, `.${id}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`)
  assertDirectChild(outputRoot, destination)
  assertDirectChild(outputRoot, staging)
  mkdirSync(join(staging, 'libexec'), { recursive: true, mode: 0o755 })

  try {
    const executables = {} as AspReleaseManifest['executables']
    for (const name of Object.keys(EXECUTABLES) as ExecutableName[]) {
      const payload = join(staging, 'libexec', name)
      const entry = join(REPO_ROOT, EXECUTABLES[name])
      run(['bun', 'build', '--compile', '--target=bun', '--outfile', payload, entry])
      chmodSync(payload, 0o755)
      const launcher = join(staging, name)
      writeFileSync(launcher, launcherScript(name, id, sourceCommit, builtAt), { mode: 0o755 })
      executables[name] = {
        launcher: name,
        launcherSha256: sha256(launcher),
        payload: `libexec/${name}`,
        payloadSha256: sha256(payload),
        runtimeClosure: 'bun-compiled',
      }
    }

    const manifest: AspReleaseManifest = {
      schemaVersion: RELEASE_SCHEMA,
      releaseId: id,
      sourceCommit,
      builtAt,
      platform: process.platform,
      architecture: process.arch,
      executables,
    }
    writeFileSync(join(staging, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o644,
    })
    chmodTreeReadOnly(staging)
    renameSync(staging, destination)
    return inspectRelease(destination)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function installRelease(artifactInput: string, rootInput: string): ReleaseInspection {
  const artifact = assertAbsolute(artifactInput, 'artifact path')
  const releaseRoot = assertAbsolute(rootInput, 'release root')
  const sourceInspection = inspectRelease(artifact)
  mkdirSync(releaseRoot, { recursive: true })
  const destination = join(releaseRoot, sourceInspection.releaseId)
  const staging = join(
    releaseRoot,
    `.${sourceInspection.releaseId}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  )
  assertDirectChild(releaseRoot, destination)
  assertDirectChild(releaseRoot, staging)
  let installed = false

  try {
    try {
      const existing = inspectRelease(destination)
      if (existing.sourceCommit !== sourceInspection.sourceCommit) {
        fail(`installed release identity collision: ${sourceInspection.releaseId}`)
      }
      return existing
    } catch (error) {
      if (statExists(destination)) throw error
    }
    copyTree(artifact, staging)
    chmodTreeReadOnly(staging)
    renameSync(staging, destination)
    installed = true
    return inspectRelease(destination)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (installed) rmSync(destination, { recursive: true, force: true })
    throw error
  }
}

function statExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function usage(): never {
  fail(
    'usage: build --output-root <absolute-dir> | install --artifact <absolute-release> --release-root <absolute-dir> | inspect --release <absolute-release>'
  )
}

export async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args
  const flags = parseFlags(rest)
  let inspection: ReleaseInspection
  switch (command) {
    case 'build':
      inspection = await buildRelease(requiredFlag(flags, 'output-root'))
      break
    case 'install':
      inspection = installRelease(
        requiredFlag(flags, 'artifact'),
        requiredFlag(flags, 'release-root')
      )
      break
    case 'inspect':
      inspection = inspectRelease(requiredFlag(flags, 'release'))
      break
    default:
      usage()
  }
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
