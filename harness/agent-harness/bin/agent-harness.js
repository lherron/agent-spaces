#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const entry = process.env.HARNESS_BROKER_USE_DIST === '1' || !existsSync(source) ? dist : source
const { runAgentHarness } = await import(pathToFileURL(entry).href)
await runAgentHarness()
