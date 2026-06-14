import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

type CliArgs = {
  root: string
  docs: string[]
}

type MarkdownLink = {
  destination: string
  index: number
  line: number
}

type ReachabilityFailure = {
  file: string
  line: number
  expected: string
  got: string
  fix: string
}

const markdownLinkPattern = /(?<!!)\[[^\]\n]+\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g
const externalSchemePattern = /^[a-z][a-z0-9+.-]*:/i

function parseArgs(argv: string[]): CliArgs {
  let root = process.cwd()
  const docs: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--root requires a value')
      }
      root = value
      index += 1
      continue
    }

    if (arg === '--doc') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--doc requires a value')
      }
      docs.push(value)
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return {
    root: resolve(root),
    docs: docs.length > 0 ? docs : ['AGENTS.md'],
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const entry = await stat(path)
    return entry.isFile()
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function cleanDestination(destination: string): string {
  if (destination.startsWith('<') && destination.endsWith('>')) {
    return destination.slice(1, -1)
  }
  return destination
}

function isExternalDestination(destination: string): boolean {
  return (
    destination.startsWith('http://') ||
    destination.startsWith('https://') ||
    destination.startsWith('mailto:') ||
    externalSchemePattern.test(destination)
  )
}

function isRoutedAgentDoc(relativePath: string): boolean {
  return relativePath === 'AGENTS.md' || relativePath.endsWith('/AGENTS.md')
}

function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

function extractLinks(content: string): MarkdownLink[] {
  const links: MarkdownLink[] = []
  let inFence = false

  const lines = content.split('\n')
  let offset = 0
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      offset += line.length + 1
      continue
    }

    if (!inFence) {
      for (const match of line.matchAll(markdownLinkPattern)) {
        const destination = match[1]
        if (!destination) {
          continue
        }
        const index = offset + match.index
        links.push({
          destination: cleanDestination(destination),
          index,
          line: lineNumberForIndex(content, index),
        })
      }
    }

    offset += line.length + 1
  }

  return links
}

function decodePathSegment(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor)
  } catch {
    return anchor
  }
}

function splitDestination(destination: string): { pathPart: string; anchor?: string | undefined } {
  const hashIndex = destination.indexOf('#')
  if (hashIndex === -1) {
    return { pathPart: decodePathSegment(destination) }
  }

  return {
    pathPart: decodePathSegment(destination.slice(0, hashIndex)),
    anchor: decodeAnchor(destination.slice(hashIndex + 1)),
  }
}

function resolveTarget(root: string, sourceDoc: string, pathPart: string): string | undefined {
  if (pathPart === '') {
    return sourceDoc
  }

  if (isAbsolute(pathPart)) {
    return undefined
  }

  const absoluteTarget = resolve(root, dirname(sourceDoc), pathPart)
  const relativeTarget = toPosix(relative(root, absoluteTarget))
  if (relativeTarget === '' || relativeTarget.startsWith('../') || relativeTarget === '..') {
    return undefined
  }

  return relativeTarget
}

function normalizeHeadingForSlug(heading: string): string {
  return heading
    .replace(/\s+#+\s*$/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s/g, '-')
}

function headingSlugs(content: string): Set<string> {
  const slugs = new Set<string>()
  const seen = new Map<string, number>()
  let inFence = false

  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }

    if (inFence) {
      continue
    }

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) {
      continue
    }

    const base = normalizeHeadingForSlug(match[2] ?? '')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    slugs.add(count === 0 ? base : `${base}-${count}`)
  }

  return slugs
}

function diagnosticFailure(
  file: string,
  line: number,
  expected: string,
  got: string,
  fix: string
): ReachabilityFailure {
  return { file, line, expected, got, fix }
}

function printFailures(failures: ReachabilityFailure[]): void {
  console.error('Doc reachability check failed: routed markdown links are unreachable.')

  for (const failure of failures) {
    console.error('')
    console.error(`${failure.file}:${failure.line}`)
    console.error(`  expected: ${failure.expected}; got: ${failure.got}.`)
    console.error(`  FIX → ${failure.fix}`)
    console.error(
      '  WHY → routed AGENTS.md links are operator-facing navigation; missing files or anchors strand readers in stale instructions.'
    )
    console.error(
      '  EXCEPTION → update scripts/check-doc-reachability.ts via reviewed change if the router contract itself changes.'
    )
    console.error('  Do not suppress, silence, disable, or route around this; fix the doc link.')
  }
}

async function checkDocs(args: CliArgs): Promise<ReachabilityFailure[]> {
  const failures: ReachabilityFailure[] = []
  const queue = args.docs.map((doc) => toPosix(doc))
  const visited = new Set<string>()

  while (queue.length > 0) {
    const sourceDoc = queue.shift()
    if (!sourceDoc || visited.has(sourceDoc)) {
      continue
    }
    visited.add(sourceDoc)

    const sourcePath = resolve(args.root, sourceDoc)
    const content = await readFile(sourcePath, 'utf8')

    for (const link of extractLinks(content)) {
      if (isExternalDestination(link.destination)) {
        continue
      }

      const { pathPart, anchor } = splitDestination(link.destination)
      const targetDoc = resolveTarget(args.root, sourceDoc, pathPart)
      if (!targetDoc) {
        failures.push(
          diagnosticFailure(
            sourceDoc,
            link.line,
            `relative link '${link.destination}' to stay within ${args.root}`,
            'target outside the doc root',
            'point the link at a markdown file inside the checked root, or remove it from the router docs.'
          )
        )
        continue
      }

      const targetPath = resolve(args.root, targetDoc)
      if (!(await fileExists(targetPath))) {
        failures.push(
          diagnosticFailure(
            sourceDoc,
            link.line,
            `'${link.destination}' to resolve`,
            'missing file',
            `create ${targetDoc} or correct the link in ${sourceDoc}.`
          )
        )
        continue
      }

      if (anchor !== undefined) {
        const targetContent = targetDoc === sourceDoc ? content : await readFile(targetPath, 'utf8')
        const slugs = headingSlugs(targetContent)
        if (!slugs.has(anchor)) {
          failures.push(
            diagnosticFailure(
              sourceDoc,
              link.line,
              `'#${anchor}' to match a heading in ${targetDoc}`,
              'missing anchor',
              `rename the fragment to an existing heading slug in ${targetDoc}, or add that heading.`
            )
          )
        }
      }

      if (isRoutedAgentDoc(targetDoc) && !visited.has(targetDoc) && !queue.includes(targetDoc)) {
        queue.push(targetDoc)
      }
    }
  }

  return failures
}

const failures = await checkDocs(parseArgs(Bun.argv.slice(2)))
if (failures.length > 0) {
  printFailures(failures)
  process.exit(1)
}

console.log('Doc reachability check passed.')
process.exit(0)
