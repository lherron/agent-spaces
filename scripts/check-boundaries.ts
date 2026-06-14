import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

type Layer = {
  name: string
  roots: string[]
  forbidden: string[]
}

type Violation = {
  file: string
  line: number
  specifier: string
  token: string
}

const aspPackages = [
  'agent-scope',
  'cli-kit',
  'config',
  'runtime',
  'execution',
  'harness-claude',
  'harness-codex',
  'harness-pi',
  'harness-pi-sdk',
  'harness-broker-protocol',
  'spaces-runtime-contracts',
  'aspc-protocol',
  'harness-broker-client',
  'agent-spaces',
  'aspc',
  'cli',
]

const hrcPackages = [
  'agent-action-render',
  'hrc-core',
  'hrc-events',
  'hrc-store-sqlite',
  'hrc-server',
  'hrc-sdk',
  'hrc-cli',
  'hrcchat-cli',
  'hrc-frame-render',
]

const layers: Layer[] = [
  {
    name: 'Harness Broker Protocol',
    roots: ['packages/harness-broker-protocol/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      // protocol is the lowest layer: runtime-contracts depends on it, so it
      // must never import back into runtime-contracts (would create a cycle).
      'spaces-runtime-contracts',
      'spaces-execution',
      'spaces-harness-',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'Runtime Contracts',
    roots: ['packages/spaces-runtime-contracts/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-harness-broker',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'agent-spaces',
      '@lherron/agent-spaces',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'ASPC Protocol',
    roots: ['packages/aspc-protocol/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-harness-broker-client',
      'spaces-harness-broker',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'Harness Broker Client',
    roots: ['packages/harness-broker-client/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-harness-broker',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'agent-spaces',
      '@lherron/agent-spaces',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'Harness Broker',
    roots: ['packages/harness-broker/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'ASP',
    roots: [...aspPackages.map((name) => `packages/${name}`), 'integration-tests'],
    forbidden: ['hrc-', 'acp-', 'gateway-', 'coordination-substrate', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC',
    roots: hrcPackages.map((name) => `packages/${name}`),
    forbidden: [
      'acp-',
      'gateway-discord',
      'gateway-ios',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
]

const ignoredDirectories = new Set([
  '.git',
  'asp_modules',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
])

const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

async function collectTsFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(path)
        }
        continue
      }

      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(path)
      }
    }
  }

  await walk(root)
  return files
}

function isForbidden(specifier: string, token: string): boolean {
  if (token.endsWith('-')) {
    return specifier.startsWith(token)
  }
  return specifier === token || specifier.startsWith(`${token}/`)
}

function packageGroup(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'packages' && parts[1]) {
    return `packages/${parts[1]}`
  }
  return parts[0] ?? dirname(file)
}

function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

async function findViolations(layer: Layer): Promise<Violation[]> {
  const violations: Violation[] = []
  const files = (await Promise.all(layer.roots.map((root) => collectTsFiles(root)))).flat()

  for (const file of files.sort()) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) {
        continue
      }

      const token = layer.forbidden.find((candidate) => isForbidden(specifier, candidate))
      if (token) {
        violations.push({
          file: relative(process.cwd(), file),
          line: lineNumberForIndex(content, match.index),
          specifier,
          token,
        })
      }
    }
  }

  return violations
}

const violationsByLayer = new Map<string, Violation[]>()

for (const layer of layers) {
  const violations = await findViolations(layer)
  if (violations.length > 0) {
    violationsByLayer.set(layer.name, violations)
  }
}

if (violationsByLayer.size === 0) {
  console.log('Boundary check passed.')
  process.exit(0)
}

console.error('Boundary check failed: forbidden layer imports found.')

for (const [layerName, violations] of violationsByLayer) {
  console.error('')
  console.error(`${layerName} layer violations:`)

  const grouped = Map.groupBy(violations, (violation) => packageGroup(violation.file))
  for (const [group, groupViolations] of grouped) {
    console.error(`  ${group}`)
    for (const violation of groupViolations) {
      console.error('    ✗ ARCH-L2 layer violation')
      console.error(`      ${violation.file}:${violation.line}`)
      console.error(
        `      expected: ${layerName} layer must not import modules matching '${violation.token}'; got: import '${violation.specifier}'`
      )
      console.error(
        `      FIX → move the shared type/API to a lower allowed layer, or invert the dependency; remove the '${violation.token}' edge from ${layerName}.`
      )
      console.error(
        `      WHY → ${layerName} is a protected architecture layer; importing '${violation.token}' points it at an outer or forbidden layer.`
      )
      console.error(
        '      EXCEPTION → edit the rule set in scripts/check-boundaries.ts via reviewed change with rationale — NOT an inline silence.'
      )
      console.error(
        '      Do not suppress, silence, disable, or re-export to hide this; fix the edge.'
      )
    }
  }
}

process.exit(1)
