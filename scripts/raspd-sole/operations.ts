/** Slice 3: discovery, both modes without a reachable upstream, and the shared inspection core. */
import { join } from 'node:path'
import { HELLO_PARAMS } from '../aspd-compare/cases.ts'
import { diffMaps, normalize } from '../aspd-compare/compare-core.ts'
import { evalCtx } from './cases/unserved.ts'
import { ctxFor } from './ctx.ts'
import { type Rig, drive, frame, logLines, startRig } from './rig.ts'

export async function checkOperations(rig: Rig, binary: string) {
  const fronted = await startRig(join(rig.scratch, 'fronted'), binary, [
    '--upstream',
    join(rig.scratch, 'no-upstream.sock'),
  ])
  const problems: string[] = []
  const evidence: Record<string, unknown> = {}
  try {
    for (const [mode, r] of [
      ['sole', rig],
      ['fronted', fronted],
    ] as const) {
      const discovery = await drive(r.socket, [
        frame(1, 'aspc.hello', HELLO_PARAMS),
        frame(2, 'surface', {}),
        frame(3, 'version', {}),
      ])
      evidence[mode] = discovery
      for (const [op, expected] of [
        ['catalogAgents', true],
        ['inspectAgent', true],
        ['catalogAgentInspection', false],
        ['inspectAgentSelection', false],
        ['prepareProcessInvocation', false],
      ] as const) {
        const surface = discovery[1]?.result?.ops?.find(
          (item: { op: string }) => item.op === `aspc.${op}`
        )
        if (
          discovery[0]?.result?.capabilities?.[op] !== expected ||
          surface?.supported !== expected ||
          discovery[2]?.result?.capabilities?.[`aspc.${op}`] !== expected
        )
          problems.push(`${mode}: discovery ${op} must report ${expected}`)
      }
      const evaluationContext = evalCtx(ctxFor(r.stage, r.bases, r.scratch, 'entry-equivalence'))
      evaluationContext.identifiers = {
        agentId: 'pathmark-dev',
        agentName: 'pathmark-dev',
        projectId: 'project',
        mode: 'task',
        scope: 'agent:pathmark-dev:project:project',
        lane: 'primary',
        harness: 'claude',
        presentation: false,
      } as typeof evaluationContext.identifiers
      const request = {
        schemaVersion: 'agent-inspection-request/v2',
        identifiers: evaluationContext.identifiers,
        declaredOverrides: {},
      }
      const [, direct] = await drive(r.socket, [
        frame(1, 'aspc.hello', HELLO_PARAMS),
        frame(2, 'aspc.inspectAgent', { request, evaluationContext }),
      ])
      const [, placed] = await drive(r.socket, [
        frame(1, 'aspc.hello', HELLO_PARAMS),
        frame(2, 'aspc.inspectRuntimePlacement', {
          schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
          context: {
            agentId: 'pathmark-dev',
            agentRoot: evaluationContext.paths.agentRoot,
            cwd: r.stage.projectRoot,
            runMode: 'task',
            provisionDirectives: { harness: 'claude' },
            project: { mode: 'root', projectRoot: r.stage.projectRoot, projectId: 'project' },
          },
        }),
      ])
      if (direct?.result?.ok !== true || placed?.result?.ok !== true)
        problems.push(`${mode}: inspection entries must both succeed`)
      // Only the already measured inspection profile id is volatile. Every other
      // inspection field (including all parts and their diagnostics) must agree.
      const entry = {
        kind: 'call',
        id: 'entry-equivalence',
        method: 'aspc.inspectAgent',
        params: {},
      } as const
      const shape = (reply: typeof direct) => [
        {},
        { result: { inspection: reply?.result?.inspection } },
      ]
      const diffs = diffMaps(
        normalize(entry, shape(direct), new Map()),
        normalize(entry, shape(placed), new Map())
      )
      if (diffs.length) problems.push(`${mode}: inspection entry drift: ${JSON.stringify(diffs)}`)
      evidence[`${mode}-inspection`] = { direct, placed, diffs }
      for (const [method, params, code, reason, appCode] of [
        ['catalogAgents', { evaluationContext }, undefined, undefined, undefined],
        ['catalogAgents', {}, -32602, 'invalid_params', undefined],
        [
          'catalogAgentInspection',
          {},
          -32603,
          'internal_error',
          'AGENT_INSPECTION_PRODUCER_UNAVAILABLE',
        ],
        [
          'catalogAgentInspection',
          { projectId: 'project' },
          -32603,
          'internal_error',
          'AGENT_INSPECTION_PRODUCER_UNAVAILABLE',
        ],
        [
          'inspectAgentSelection',
          {},
          -32603,
          'internal_error',
          'AGENT_INSPECTION_PRODUCER_UNAVAILABLE',
        ],
        ['prepareProcessInvocation', {}, -32601, 'op_unsupported', undefined],
      ] as const) {
        const [, reply] = await drive(r.socket, [
          frame(1, 'aspc.hello', HELLO_PARAMS),
          frame(2, `aspc.${method}`, params),
        ])
        if (
          code === undefined
            ? !Array.isArray(reply?.result?.agents)
            : reply?.error?.code !== code ||
              reply?.error?.data?.reason !== reason ||
              reply?.error?.data?.code !== appCode
        )
          problems.push(`${mode}: ${method} returned ${JSON.stringify(reply)}`)
      }
      // The owner keeps projecting the five changed operations through aspd.op.
      let document:
        | {
            nodes?: { type: string; payload: { op?: string; native?: number; relayed?: number } }[]
          }
        | undefined
      for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
        const [readback] = await drive(
          join(r.scratch, 'kernel.sock'),
          [JSON.stringify({ id: 'slice3', op: 'document.inspect', args: { document_id: 'aspd' } })],
          5_000
        )
        document = readback?.result
        const ops = document?.nodes?.filter((n) => n.type === 'aspd.op').map((n) => n.payload) ?? []
        if (
          [
            'catalogAgents',
            'inspectAgent',
            'catalogAgentInspection',
            'inspectAgentSelection',
            'prepareProcessInvocation',
          ].every((op) =>
            ops.some((n) => n.op === `aspc.${op}` && (n.native ?? 0) > 0 && n.relayed === 0)
          )
        )
          break
        await Bun.sleep(100)
      }
      evidence[`${mode}-kernel`] = document
      const projected =
        document?.nodes?.filter((n) => n.type === 'aspd.op').map((n) => n.payload) ?? []
      if (
        ![
          'catalogAgents',
          'inspectAgent',
          'catalogAgentInspection',
          'inspectAgentSelection',
          'prepareProcessInvocation',
        ].every((op) =>
          projected.some((n) => n.op === `aspc.${op}` && (n.native ?? 0) > 0 && n.relayed === 0)
        )
      )
        problems.push(`${mode}: kernel must project all five operations as native, zero relayed`)
    }
  } finally {
    await fronted.stop()
  }
  const log = logLines(fronted.log, 0).lines
  const relays = log.filter((l) => l.event === 'rpc.request' && l.data?.servedBy !== 'native')
  if (relays.length) problems.push(`fronted operations relayed ${relays.length} calls`)
  evidence['fronted-relay-count'] = relays.length
  return { problems, evidence }
}
