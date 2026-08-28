import { defineGuard, runGuard } from './lib/boundary-guard/engine.ts'
import type { Guard, ImportFinding } from './lib/boundary-guard/engine.ts'
import { type Layer, collectTsFiles, isForbidden, layers } from './lib/import-graph.ts'
import { scanTestCloneCommands } from './lib/test-no-git-clone.ts'

function layerGuard(layer: Layer): Guard {
  return defineGuard({
    surface: {
      dirs: layer.roots,
      ignore: ['.git', 'asp_modules', 'coverage', 'dist', 'node_modules', 'tmp'],
    },
    rules: [
      {
        id: `ARCH-L2:${layer.name}`,
        kind: 'forbid-import',
        match(specifier: string): string | undefined {
          return layer.forbidden.find((candidate) => isForbidden(specifier, candidate))
        },
        expected: (finding: ImportFinding) =>
          `${layer.name} layer must not import modules matching '${finding.token}'`,
        got: (finding: ImportFinding) => `import '${finding.specifier}'`,
        fix: (finding: ImportFinding) =>
          `move the shared type/API to a lower allowed layer, or invert the dependency; remove the '${finding.token}' edge from ${layer.name}.`,
        why: (finding: ImportFinding) =>
          `${layer.name} is a protected architecture layer; importing '${finding.token}' points it at an outer or forbidden layer.`,
        exception:
          'edit the rule set in scripts/check-boundaries.ts via reviewed change with rationale — NOT an inline silence.',
        doNotSuppress:
          'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
      },
    ],
  })
}

let exitCode = 0

for (const layer of layers) {
  const files = (await Promise.all(layer.roots.map((root) => collectTsFiles(root)))).flat()
  if (files.length === 0) {
    continue
  }

  exitCode ||= await runGuard(layerGuard(layer))
}

const testCloneFindings = await scanTestCloneCommands(process.cwd())
for (const finding of testCloneFindings) {
  console.error(
    `${finding.path}:${finding.line}: repository cloning is forbidden in tests and test execution paths`
  )
}
if (testCloneFindings.length > 0) exitCode = 1

if (exitCode === 0) {
  console.log('Boundary check passed.')
}

process.exit(exitCode)
