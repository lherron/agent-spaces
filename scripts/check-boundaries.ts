import { readFile } from 'node:fs/promises'

type Violation = {
  file: string
  line: number
  specifier: string
  token: string
}

import {
  type Layer,
  collectTsFiles,
  isForbidden,
  layers,
  packageGroup,
  parseImportReferences,
  repoPath,
} from './lib/import-graph.ts'

async function findViolations(layer: Layer): Promise<Violation[]> {
  const violations: Violation[] = []
  const files = (await Promise.all(layer.roots.map((root) => collectTsFiles(root)))).flat()

  for (const file of files.sort()) {
    const content = await readFile(file, 'utf8')
    for (const reference of parseImportReferences(repoPath(process.cwd(), file), content)) {
      const token = layer.forbidden.find((candidate) => isForbidden(reference.specifier, candidate))
      if (token) {
        violations.push({
          file: reference.file,
          line: reference.line,
          specifier: reference.specifier,
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
