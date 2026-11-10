/**
 * The case context of the T-13008 forward inventory (its probe harness),
 * over a fresh scratch stage: the compare runner's fixture (seedStage), its
 * base requests (buildCases), and helpers to write agents and spaces. The
 * case modules under cases/ are T-13008's, copied (T-13039); each builds its
 * request from this context, so the requests follow the stage wherever it is.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type Stage = {
  base: string
  agentsRoot: string
  projectRoot: string
  aspHome: string
  brokenProjectRoot: string
  claudeHome: string
  codexHomeDev: string
}

export type BaseCase = { id: string; method: string; params: unknown }

export type Ctx = {
  stage: Stage
  /** Deep copy of a compare-runner case's params by id. */
  base: (id: string) => any
  write: (path: string, text: string) => void
  /** Write a minimal agent (profile, SOUL.md, a skill) and return its root. */
  agent: (name: string, profile: string, files?: Record<string, string>) => string
  /** Write a mutable space under agentsRoot/spaces/<id>. */
  space: (id: string, spaceToml: string, files?: Record<string, string>) => string
  /** A compile request for `agent` cloned from base case `from` (default compile:claude-code:dev). */
  compileFor: (agent: string, from?: string) => any
  /** A scratch dir unique to this case. */
  dir: string
  /** Created by the runner once the reply landed (lock holders stop on it). */
  done: string
}

export type ProbeCase = {
  reason: string
  id?: string
  method: string
  condition: string
  setup?: (ctx: Ctx) => void
  /** Undo what setup changed outside the case's own files (after the reply). */
  teardown?: (ctx: Ctx) => void
  params: (ctx: Ctx) => unknown
  rawFrames?: (ctx: Ctx) => string[]
  note?: string
}

export function ctxFor(
  stage: Stage,
  bases: Record<string, BaseCase>,
  scratch: string,
  id: string
): Ctx {
  const dir = join(scratch, 'case-scratch', id.replace(/[^a-zA-Z0-9_.-]/g, '_'))
  mkdirSync(dir, { recursive: true })
  const write = (path: string, text: string) => {
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  const base = (bid: string) => {
    const b = bases[bid]
    if (b === undefined) throw new Error(`no base case ${bid}`)
    return structuredClone(b.params)
  }
  const agent = (name: string, profile: string, files: Record<string, string> = {}) => {
    const root = join(stage.agentsRoot, name)
    write(join(root, 'agent-profile.toml'), profile)
    write(join(root, 'SOUL.md'), `# ${name}\n\nProbe agent.\n`)
    write(
      join(root, 'skills', 'probe-skill', 'SKILL.md'),
      '---\nname: probe-skill\ndescription: probe skill.\n---\n\nLoaded.\n'
    )
    for (const [rel, text] of Object.entries(files)) write(join(root, rel), text)
    return root
  }
  const space = (sid: string, toml: string, files: Record<string, string> = {}) => {
    const root = join(stage.agentsRoot, 'spaces', sid)
    write(join(root, 'space.toml'), toml)
    for (const [rel, text] of Object.entries(files)) write(join(root, rel), text)
    return root
  }
  const compileFor = (agentName: string, from = 'compile:claude-code:dev') => {
    const p = base(from)
    const req = p.compileRequest
    const oldAgent = req.agent.id
    req.agent.id = agentName
    req.placement.agentRoot = join(stage.agentsRoot, agentName)
    if (req.placement.bundle?.agentName !== undefined) req.placement.bundle.agentName = agentName
    const swap = (s: string) => s.split(`agent:${oldAgent}:`).join(`agent:${agentName}:`)
    const sr = req.placement.correlation?.sessionRef
    if (sr?.scopeRef) sr.scopeRef = swap(sr.scopeRef)
    if (req.correlation?.scopeRef) req.correlation.scopeRef = swap(req.correlation.scopeRef)
    const env = req.placement.dispatchEnv
    if (env) {
      for (const k of Object.keys(env)) if (typeof env[k] === 'string') env[k] = swap(env[k])
      if (env.AGENT_ID !== undefined) env.AGENT_ID = agentName
    }
    if (p.dispatchEnv) {
      for (const k of Object.keys(p.dispatchEnv))
        if (typeof p.dispatchEnv[k] === 'string') p.dispatchEnv[k] = swap(p.dispatchEnv[k])
      if (p.dispatchEnv.AGENT_ID !== undefined) p.dispatchEnv.AGENT_ID = agentName
    }
    return p
  }
  const done = join(scratch, 'done', id.replace(/[^a-zA-Z0-9_.-]/g, '_'))
  mkdirSync(resolve(done, '..'), { recursive: true })
  return { stage, base, write, agent, space, compileFor, dir, done }
}
