/**
 * Structural MSP schema compatibility gate (T-09879).
 *
 * This gate replaces the whole-export fingerprint pin. A muse release whose
 * export fingerprint equals the last-verified one passes without an export.
 * For any other fingerprint, the driver exports the installed binary's schema
 * (`muse schema generate-json-schema`, offline and about 40ms) and checks it
 * against MUSE_DRIVER_SCHEMA_SURFACE. It refuses only what breaks that
 * surface:
 * - a removed method, notification or server request
 * - a new required field in something the driver sends
 * - a removed or retyped field the driver sends or reads
 * - a removed enum value the driver sends or branches on
 * Every other drift, such as new optional fields, new methods or notifications
 * and description text, produces a single warning naming both fingerprints.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyMuseNotificationMethod } from './event-map'
import {
  MSP_LAST_VERIFIED_MUSE_VERSION,
  MSP_LAST_VERIFIED_SCHEMA_FINGERPRINT,
  MUSE_DRIVER_SCHEMA_SURFACE,
} from './schema-surface'
import type { MuseDriverSchemaSurface, MuseWireShape, MuseWireType } from './schema-surface'

type SchemaNode = Record<string, unknown>

function isRecord(value: unknown): value is SchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class SchemaView {
  private readonly defs: SchemaNode

  constructor(root: SchemaNode) {
    this.defs = isRecord(root['$defs']) ? root['$defs'] : {}
  }

  /** Follow `$ref` chains to the referenced definition. */
  private deref(node: unknown): SchemaNode | undefined {
    let current = node
    for (let hops = 0; hops < 32 && isRecord(current); hops += 1) {
      const ref = current['$ref']
      if (typeof ref !== 'string') return current
      const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined
      current = name === undefined ? undefined : this.defs[name]
    }
    return undefined
  }

  /** The non-null alternatives of a node (anyOf/oneOf flattened). */
  branches(node: unknown): SchemaNode[] {
    const resolved = this.deref(node)
    if (!resolved) return []
    const alternatives = resolved['anyOf'] ?? resolved['oneOf']
    if (Array.isArray(alternatives)) return alternatives.flatMap((alt) => this.branches(alt))
    if (resolved['type'] === 'null') return []
    return [resolved]
  }

  /** JSON types a node admits, excluding null; empty means unconstrained. */
  types(node: unknown): Set<string> {
    const types = new Set<string>()
    for (const branch of this.branches(node)) {
      const type = branch['type']
      for (const t of Array.isArray(type) ? type : [type]) {
        if (typeof t === 'string' && t !== 'null') types.add(t)
      }
      if (type === undefined && isRecord(branch['properties'])) types.add('object')
    }
    return types
  }

  /** Enum values a node admits; undefined when some branch is unconstrained. */
  enumValues(node: unknown): Set<string> | undefined {
    const values = new Set<string>()
    for (const branch of this.branches(node)) {
      if (!Array.isArray(branch['enum'])) return undefined
      for (const value of branch['enum']) if (typeof value === 'string') values.add(value)
    }
    return values
  }

  required(node: unknown): Set<string> {
    const required = new Set<string>()
    for (const branch of this.branches(node)) {
      if (Array.isArray(branch['required'])) {
        for (const name of branch['required']) if (typeof name === 'string') required.add(name)
      }
    }
    return required
  }

  child(node: unknown, segment: string): unknown {
    for (const branch of this.branches(node)) {
      if (segment === '[]') {
        if (branch['items'] !== undefined) return branch['items']
      } else if (isRecord(branch['properties']) && segment in branch['properties']) {
        return branch['properties'][segment]
      }
    }
    return undefined
  }

  resolve(root: unknown, segments: readonly string[]): unknown {
    let node = root
    for (const segment of segments) {
      node = this.child(node, segment)
      if (node === undefined) return undefined
    }
    return node
  }
}

function pathSegments(path: string): string[] {
  if (path === '') return []
  return path.split('.').flatMap((part) => {
    const segments: string[] = []
    let name = part
    let arrays = 0
    while (name.endsWith('[]')) {
      name = name.slice(0, -2)
      arrays += 1
    }
    if (name) segments.push(name)
    for (let i = 0; i < arrays; i += 1) segments.push('[]')
    return segments
  })
}

function typeCompatible(declared: MuseWireType, actual: Set<string>): boolean {
  if (actual.size === 0) return true
  if (declared === 'number') return actual.has('number') || actual.has('integer')
  return actual.has(declared)
}

function displayPath(segments: readonly string[]): string {
  return segments
    .map((segment, i) => (segment === '[]' || i === 0 ? segment : `.${segment}`))
    .join('')
}

/**
 * Containers whose children the driver builds, keyed by display path: the
 * root plus every proper prefix of a declared path. Opaque objects the driver
 * passes through (config.mcpServers, requirementId) declare no children and
 * are not held to their required lists.
 */
function builtContainers(
  fields: Readonly<Record<string, MuseWireType>>
): Map<string, { segments: string[]; children: Set<string> }> {
  const containers = new Map<string, { segments: string[]; children: Set<string> }>()
  containers.set('', { segments: [], children: new Set() })
  for (const path of Object.keys(fields)) {
    const segments = pathSegments(path)
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] as string
      if (segment === '[]') continue
      const parent = segments.slice(0, i)
      const key = displayPath(parent)
      if (!containers.has(key)) containers.set(key, { segments: parent, children: new Set() })
      containers.get(key)?.children.add(segment)
    }
  }
  return containers
}

function checkShape(
  view: SchemaView,
  root: unknown,
  shape: MuseWireShape,
  direction: 'sends' | 'reads',
  label: string,
  refusals: string[]
): void {
  const verb = direction === 'sends' ? 'sends' : 'reads'
  for (const [path, declared] of Object.entries(shape.fields)) {
    const node = view.resolve(root, pathSegments(path))
    if (node === undefined) {
      refusals.push(`${label}: ${path} was removed (the driver ${verb} it)`)
      continue
    }
    const actual = view.types(node)
    if (!typeCompatible(declared, actual)) {
      refusals.push(
        `${label}: ${path} changed type to ${[...actual].join('|')} (the driver ${verb} ${declared})`
      )
    }
  }
  for (const [path, values] of Object.entries(shape.enumValues ?? {})) {
    const node = view.resolve(root, pathSegments(path))
    if (node === undefined) continue
    const allowed = view.enumValues(node)
    if (allowed === undefined) continue
    for (const value of values) {
      if (!allowed.has(value)) {
        refusals.push(
          `${label}: ${path} no longer allows '${value}' (the driver ${direction === 'sends' ? 'sends' : 'branches on'} it)`
        )
      }
    }
  }
  if (direction !== 'sends') return
  for (const [path, { segments, children }] of builtContainers(shape.fields)) {
    const node = view.resolve(root, segments)
    if (node === undefined) continue
    for (const name of view.required(node)) {
      if (!children.has(name)) {
        refusals.push(
          `${label}: new required field ${path ? `${path}.` : ''}${name} (the driver does not send it)`
        )
      }
    }
  }
}

/**
 * Check one schema export against the driver-used surface. Returns the
 * refusal reasons; an empty list means the export is compatible.
 */
export function checkMuseSchemaCompatibility(
  schema: unknown,
  surface: MuseDriverSchemaSurface = MUSE_DRIVER_SCHEMA_SURFACE
): string[] {
  if (
    !isRecord(schema) ||
    !isRecord(schema['methods']) ||
    !isRecord(schema['notifications']) ||
    !isRecord(schema['requests']) ||
    !isRecord(schema['$defs'])
  ) {
    return ['export is not an MSP schema bundle (methods, notifications, requests, $defs)']
  }
  const view = new SchemaView(schema)
  const methods = schema['methods']
  const notifications = schema['notifications']
  const requests = schema['requests']
  const refusals: string[] = []
  for (const [method, shape] of Object.entries(surface.methods)) {
    const entry = methods[method]
    if (!isRecord(entry)) {
      refusals.push(`method ${method} was removed (the driver calls it)`)
      continue
    }
    checkShape(view, entry['params'] ?? {}, shape.sends, 'sends', `${method} params`, refusals)
    checkShape(view, entry['result'] ?? {}, shape.reads, 'reads', `${method} result`, refusals)
  }
  for (const method of surface.clientNotifications) {
    if (!isRecord(notifications[method])) {
      refusals.push(`notification ${method} was removed (the driver sends it)`)
    }
  }
  for (const [method, shape] of Object.entries(surface.notifications)) {
    const entry = notifications[method]
    if (!isRecord(entry)) {
      refusals.push(`notification ${method} was removed (the driver handles it)`)
      continue
    }
    checkShape(view, entry['params'] ?? {}, shape, 'reads', `${method} params`, refusals)
  }
  for (const [method, shape] of Object.entries(surface.serverRequests)) {
    const entry = requests[method]
    if (!isRecord(entry)) {
      refusals.push(`server request ${method} was removed (the driver answers it)`)
      continue
    }
    checkShape(view, entry['params'] ?? {}, shape.reads, 'reads', `${method} params`, refusals)
    checkShape(view, entry['result'] ?? {}, shape.sends, 'sends', `${method} result`, refusals)
  }
  return refusals
}

export interface MuseVerifiedSchema {
  fingerprint: string
  museVersion: string
}

export const MUSE_LAST_VERIFIED_SCHEMA: MuseVerifiedSchema = {
  fingerprint: MSP_LAST_VERIFIED_SCHEMA_FINGERPRINT,
  museVersion: MSP_LAST_VERIFIED_MUSE_VERSION,
}

/** The single drift warning for a compatible export that is not last-verified. */
export function describeMuseSchemaDrift(
  schema: unknown,
  installedFingerprint: string,
  lastVerified: MuseVerifiedSchema = MUSE_LAST_VERIFIED_SCHEMA
): string {
  const notifications =
    isRecord(schema) && isRecord(schema['notifications']) ? schema['notifications'] : {}
  const unclassified = Object.keys(notifications)
    .filter((method) => classifyMuseNotificationMethod(method) === 'unknown')
    .sort()
  const unclassifiedNote =
    unclassified.length > 0
      ? ` Notifications the driver does not classify: ${unclassified.join(', ')}.`
      : ''
  return `muse-serve MSP schema drift: installed export ${installedFingerprint} differs from last-verified ${lastVerified.fingerprint} (muse ${lastVerified.museVersion}); the driver-used surface is compatible, so startup continues. Review the release for prose-only semantic changes and re-verify.${unclassifiedNote}`
}

export interface MuseSchemaExport {
  fingerprint: string | undefined
  schema: unknown
}

/**
 * Export the installed binary's stable MSP schema. The export reuses the
 * serve command line up to its `serve` subcommand, so wrapper prefixes
 * (interpreter + script) carry over.
 */
export async function exportMuseSchema(options: {
  command: string
  serveArgs: readonly string[]
  env: NodeJS.ProcessEnv
  timeoutMs?: number | undefined
}): Promise<MuseSchemaExport> {
  const serveIndex = options.serveArgs.indexOf('serve')
  if (serveIndex < 0) {
    throw new Error('muse-serve args carry no `serve` subcommand to derive the schema export from')
  }
  const outDir = await mkdtemp(join(tmpdir(), 'muse-schema-'))
  try {
    const args = [
      ...options.serveArgs.slice(0, serveIndex),
      'schema',
      'generate-json-schema',
      '--out',
      outDir,
    ]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.command, args, {
        env: options.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`schema export timed out after ${options.timeoutMs ?? 10_000}ms`))
      }, options.timeoutMs ?? 10_000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else
          reject(
            new Error(
              `schema export exited ${signal ?? code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`
            )
          )
      })
    })
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')) as unknown
    const schema = JSON.parse(await readFile(join(outDir, 'msp.schema.json'), 'utf8')) as unknown
    const fingerprint =
      isRecord(manifest) && typeof manifest['fingerprint'] === 'string'
        ? manifest['fingerprint']
        : undefined
    return { fingerprint, schema }
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

export type MuseSchemaGateOutcome =
  | { kind: 'last-verified' }
  | { kind: 'compatible-drift'; warning: string }

/**
 * Gate a served schema fingerprint. Throws an Error with every refusal
 * reason when the installed schema breaks the driver-used surface or cannot
 * be verified.
 */
export async function gateMuseSchema(
  servedFingerprint: string | undefined,
  loadExport: () => Promise<MuseSchemaExport>,
  lastVerified: MuseVerifiedSchema = MUSE_LAST_VERIFIED_SCHEMA
): Promise<MuseSchemaGateOutcome> {
  if (servedFingerprint === undefined) {
    throw new Error('muse-serve initialize result carries no schema fingerprint')
  }
  if (servedFingerprint === lastVerified.fingerprint) return { kind: 'last-verified' }
  let exported: MuseSchemaExport
  try {
    exported = await loadExport()
  } catch (error) {
    throw new Error(
      `muse-serve cannot verify schema ${servedFingerprint}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (exported.fingerprint !== servedFingerprint) {
    throw new Error(
      `muse-serve schema export fingerprint ${exported.fingerprint ?? 'absent'} does not match the served ${servedFingerprint}`
    )
  }
  const refusals = checkMuseSchemaCompatibility(exported.schema)
  if (refusals.length > 0) {
    throw new Error(
      `muse-serve schema ${servedFingerprint} is incompatible with the driver: ${refusals.join('; ')}`
    )
  }
  return {
    kind: 'compatible-drift',
    warning: describeMuseSchemaDrift(exported.schema, servedFingerprint, lastVerified),
  }
}
