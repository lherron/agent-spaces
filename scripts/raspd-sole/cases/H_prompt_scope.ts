/** T-13112: prompt project identity comes only from an assigned agent scope. */
import { join } from 'node:path'
import type { Ctx, ProbeCase } from '../ctx.ts'

const AGENT = 'p-prompt-scope'
const PROFILE = `version = 4
priming = "You are {{agentId}} in {{projectId}} working on {{taskId}}."
[spaces]
base = ["space:pm-dev@dev"]
[instructions]
template = "context-template.toml"
`
const TEMPLATE = `schema_version = 2
mode = "replace"
[[prompt]]
name = "scope"
type = "inline"
content = "- ScopeRef: {{agentProjectScopeRef}}"
`

function scopeCase(id: string, scope: string | undefined, projectRoot: boolean): ProbeCase {
  return {
    reason: 'placement_identity_fallback',
    id: `prompt_scope--${id}`,
    method: 'aspc.compileHarnessInvocation',
    condition: `${scope ?? 'unmanaged'}; ${projectRoot ? 'with' : 'without'} projectRoot, cwd has a different basename`,
    setup: (c) => {
      c.agent(AGENT, PROFILE, {
        'context-template.toml':
          scope === undefined
            ? TEMPLATE.replace(
                '{{agentProjectScopeRef}}',
                'agent:{{agentId}}:project:{{projectId}}'
              )
            : TEMPLATE,
      })
      c.write(join(c.stage.projectRoot, 'different-cwd', '.keep'), '')
    },
    params: (c: Ctx) => {
      const p = c.compileFor(AGENT)
      const pl = p.compileRequest.placement
      pl.cwd = join(c.stage.projectRoot, 'different-cwd')
      if (!projectRoot) {
        delete pl.projectRoot
        delete pl.bundle.projectRoot
      }
      if (scope === undefined) delete pl.correlation.sessionRef
      else pl.correlation.sessionRef.scopeRef = scope
      return p
    },
  }
}

export default [
  scopeCase('projectless-cwd', `agent:${AGENT}`, false),
  scopeCase('projectless-root', `agent:${AGENT}`, true),
  scopeCase('project-cwd', `agent:${AGENT}:project:assigned:task:T-11825:role:worker`, false),
  scopeCase('project-root', `agent:${AGENT}:project:assigned:task:T-11825:role:worker`, true),
  scopeCase('unmanaged-cwd', undefined, false),
  scopeCase('unmanaged-root', undefined, true),
] satisfies ProbeCase[]
