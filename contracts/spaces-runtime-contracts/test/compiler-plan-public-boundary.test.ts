import { expect, test } from 'bun:test'
import { join } from 'node:path'
import ts from 'typescript'

test('retired compiler and execution-profile types stay out of the package root', () => {
  const indexPath = join(import.meta.dir, '../src/index.ts')
  const program = ts.createProgram([indexPath], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  })
  const source = program.getSourceFile(indexPath)
  if (!source) throw new Error('Runtime contract index was not loaded')
  const symbol = program.getTypeChecker().getSymbolAtLocation(source)
  if (!symbol) throw new Error('Runtime contract index has no module symbol')
  const exports = new Set(
    program
      .getTypeChecker()
      .getExportsOfModule(symbol)
      .map((item) => item.name)
  )

  expect(exports.has('RuntimeCompileRequest')).toBe(true)
  for (const name of [
    'RuntimeCompileRequestV2',
    'RuntimeRouteCatalogEntry',
    'HarnessFamily',
    'CompiledAgentPolicy',
    'RuntimeRouteDecision',
    'CompileRuntimeFn',
    'RuntimeExecutionProfile',
    'BrokerExecutionProfile',
    'TerminalExecutionProfile',
    'CommandExecutionProfile',
    'LegacyExecutionProfile',
    'RuntimeExecutionProfileKind',
  ]) {
    expect(exports.has(name)).toBe(false)
  }
})
