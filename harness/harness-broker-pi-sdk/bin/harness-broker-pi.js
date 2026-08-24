#!/usr/bin/env bun
// Prefer source in a checkout and dist in an isolated/published installation.

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcPath = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const distPath = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const preferDist = process.env.HARNESS_BROKER_USE_DIST === '1'
const entryPath =
  !preferDist && existsSync(srcPath) ? srcPath : existsSync(distPath) ? distPath : srcPath

const { createPiSdkDriver, runBrokerCli } = await import(pathToFileURL(entryPath).href)
await runBrokerCli({ additionalDrivers: [createPiSdkDriver] })
