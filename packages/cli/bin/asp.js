#!/usr/bin/env node
// WHY: This is the entry point for the CLI binary.
// We need to directly call the main function because import.meta.main
// is false when src/index.ts is imported from here.

import { main } from '../dist/index.js'
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
