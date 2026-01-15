#!/usr/bin/env bun
// WHY: This is the entry point for the CLI binary.
// We need to directly call the main function because import.meta.main
// is false when src/index.ts is imported from here.

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const distPath = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const srcPath = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const entryPath = existsSync(distPath) ? distPath : srcPath

const { main } = await import(pathToFileURL(entryPath).href)
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
