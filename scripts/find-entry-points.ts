import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { collectTsFiles, repoPath } from './lib/import-graph.ts'

type Hit = {
  file: string
  line: number
  role: string
  score: number
}

const topic = process.argv[2]?.trim()

if (!topic) {
  console.error('usage: bun scripts/find-entry-points.ts <topic>')
  process.exit(1)
}

const repoRoot = process.cwd()
const topicLower = topic.toLowerCase()

function isEntryPointCandidate(file: string): boolean {
  if (file === 'packages/cli/src/command-registry.ts') {
    return true
  }
  if (file.startsWith('packages/cli/src/commands/')) {
    return true
  }
  if (/^packages\/[^/]+\/src\/index\.ts$/.test(file)) {
    return true
  }
  if (/(route|routes|handler|handlers)/i.test(file)) {
    return true
  }
  return /(\.test|\.red|\.spec)\.tsx?$/.test(file) || file.includes('/__tests__/')
}

function roleFor(file: string, lineText: string): string {
  if (file === 'packages/cli/src/command-registry.ts') {
    return `CLI command registry: ${lineText}`
  }
  if (file.startsWith('packages/cli/src/commands/')) {
    return `CLI command entry: ${lineText}`
  }
  if (/^packages\/[^/]+\/src\/index\.ts$/.test(file)) {
    return `exported package surface: ${lineText}`
  }
  if (/(route|routes|handler|handlers)/i.test(file)) {
    return `route/handler entry: ${lineText}`
  }
  return `acceptance/spec coverage: ${lineText}`
}

function scoreHit(file: string, lineText: string): number {
  let score = 0
  const lowerFile = file.toLowerCase()
  const lowerLine = lineText.toLowerCase()
  if (lowerFile.includes(topicLower)) score += 80
  if (basename(file).toLowerCase().includes(topicLower)) score += 20
  if (lowerLine.includes(topicLower)) score += 60
  if (file.startsWith('packages/cli/src/commands/')) score += 20
  if (file === 'packages/cli/src/command-registry.ts') score += 15
  if (/^packages\/[^/]+\/src\/index\.ts$/.test(file)) score += 10
  if (/(\.test|\.red|\.spec)\.tsx?$/.test(file) || file.includes('/__tests__/')) score += 5
  return score
}

function firstMeaningfulLine(content: string): { line: number; text: string } {
  const lines = content.split('\n')
  const index = lines.findIndex((line) => line.trim().length > 0)
  return {
    line: index === -1 ? 1 : index + 1,
    text: (lines[index] ?? '').trim(),
  }
}

const allFiles = (
  await Promise.all(['packages', 'integration-tests'].map((root) => collectTsFiles(root)))
).flat()
const hits: Hit[] = []

for (const absoluteFile of allFiles.sort()) {
  const file = repoPath(repoRoot, absoluteFile)
  if (!isEntryPointCandidate(file)) {
    continue
  }

  const content = await readFile(absoluteFile, 'utf8')
  const lowerContent = content.toLowerCase()
  const fileMatches = file.toLowerCase().includes(topicLower)
  if (!fileMatches && !lowerContent.includes(topicLower)) {
    continue
  }

  const lines = content.split('\n')
  const matchingLineIndex = lines.findIndex((line) => line.toLowerCase().includes(topicLower))
  const locus =
    matchingLineIndex === -1
      ? firstMeaningfulLine(content)
      : { line: matchingLineIndex + 1, text: lines[matchingLineIndex]?.trim() ?? '' }
  const roleLine = locus.text.replace(/\s+/g, ' ').slice(0, 120)
  const score = scoreHit(file, roleLine)
  hits.push({
    file,
    line: locus.line,
    role: roleFor(file, roleLine),
    score,
  })
}

const uniqueHits = new Map<string, Hit>()
for (const hit of hits.sort(
  (a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line
)) {
  const key = `${hit.file}:${hit.line}`
  if (!uniqueHits.has(key)) {
    uniqueHits.set(key, hit)
  }
}

for (const hit of [...uniqueHits.values()].slice(0, 50)) {
  console.log(`${hit.file}:${hit.line}\t${hit.role}`)
}
