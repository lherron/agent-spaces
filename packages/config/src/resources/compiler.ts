export type ResourcesPlanCompileOptions = {
  agentRoot: string
  includePaths?: string[] | undefined
  owner: {
    projectId: string
    agentId: string
    scopeRef: string
  }
}

export type ResourcesPlan = {
  schema: 'agent-authored-runtime-resources.plan/v1'
  sourceOwnerScopeRef: string
  managedBy: 'agent-directory'
  compiler: {
    name: 'spaces-config/resources'
    version: 1
  }
  resources: unknown[]
}

export async function compileResourcesPlan(
  _options: ResourcesPlanCompileOptions
): Promise<ResourcesPlan> {
  throw new Error('resources compiler not implemented')
}
