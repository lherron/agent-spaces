/**
 * Inputs of the scope grammar fixture. Only the inputs live here; every `ok`
 * and `refuse` in scope-cases.json is computed from the package by
 * generate.ts. Add a case here, then run `bun conformance/generate.ts`.
 *
 * Survey numbers (T-12838 grammar-divergence-survey.md §4) are kept in
 * `note` where a case comes from it.
 */

export type ScopeCaseOp =
  | 'scopeRef.parse'
  | 'scopeRef.format'
  | 'scopeHandle.parse'
  | 'scopeHandle.format'
  | 'laneRef.normalize'
  | 'sessionHandle.parse'
  | 'sessionRef.parse'
  | 'sessionRef.format'
  | 'input.resolve'
  | 'identity.project'

export type ResolveOpts = {
  projectId?: string
  taskId?: string
  defaultTaskId?: string
  envDefaultTask?: string
  defaultRoleName?: string
}

export type ScopeParts = {
  agentId: string
  projectId?: string
  taskId?: string
  roleName?: string
}

export type ScopeCaseInput =
  | { id: string; op: 'scopeRef.format'; in: ScopeParts; note?: string }
  | {
      id: string
      op: 'sessionRef.format'
      in: { scopeRef: string; laneRef: string }
      note?: string
    }
  | { id: string; op: 'laneRef.normalize'; in: string | null; note?: string }
  | { id: string; op: 'input.resolve'; in: string; opts: ResolveOpts; note?: string }
  | {
      id: string
      op: Exclude<
        ScopeCaseOp,
        'scopeRef.format' | 'sessionRef.format' | 'laneRef.normalize' | 'input.resolve'
      >
      in: string
      note?: string
    }

const a64 = 'a'.repeat(64)
const a65 = 'a'.repeat(65)
const e33 = 'é'.repeat(33)

export const SCOPE_CASE_INPUTS: readonly ScopeCaseInput[] = [
  // scopeRef.parse
  { id: 'ref-001', op: 'scopeRef.parse', in: 'agent:alice', note: 'survey 1' },
  { id: 'ref-002', op: 'scopeRef.parse', in: 'agent:alice:project:demo' },
  { id: 'ref-003', op: 'scopeRef.parse', in: 'agent:alice:project:demo:task:t1' },
  {
    id: 'ref-004',
    op: 'scopeRef.parse',
    in: 'agent:alice:project:demo:task:t1:role:rev',
    note: 'survey 2',
  },
  {
    id: 'ref-005',
    op: 'scopeRef.parse',
    in: 'agent:alice:project:demo:role:rev',
    note: 'survey 3',
  },
  { id: 'ref-006', op: 'scopeRef.parse', in: 'agent:', note: 'survey 4' },
  { id: 'ref-007', op: 'scopeRef.parse', in: 'agent:alice:task:t1', note: 'survey 5' },
  { id: 'ref-008', op: 'scopeRef.parse', in: 'agent:alice:project:', note: 'survey 6' },
  {
    id: 'ref-009',
    op: 'scopeRef.parse',
    in: 'agent:alice:project:demo:role:r:task:t',
    note: 'survey 7',
  },
  {
    id: 'ref-010',
    op: 'scopeRef.parse',
    in: 'agent:alice:project:demo:task:t1:lane:x',
    note: 'survey 8',
  },
  {
    id: 'ref-011',
    op: 'scopeRef.parse',
    in: 'agent:alice:project:demo:channel:x',
    note: 'survey 9',
  },
  { id: 'ref-012', op: 'scopeRef.parse', in: 'Agent:alice', note: 'survey 10' },
  { id: 'ref-013', op: 'scopeRef.parse', in: `agent:${a64}`, note: 'survey 11: 64 characters' },
  { id: 'ref-014', op: 'scopeRef.parse', in: `agent:${a65}`, note: 'survey 11: 65 characters' },
  { id: 'ref-015', op: 'scopeRef.parse', in: 'agent:al ice', note: 'survey 12' },
  {
    id: 'ref-016',
    op: 'scopeRef.parse',
    in: `agent:${e33}`,
    note: 'survey 13: 33 UTF-16 units, 66 bytes; one code either way',
  },
  { id: 'ref-017', op: 'scopeRef.parse', in: ' agent:alice', note: 'survey 14' },
  { id: 'ref-018', op: 'scopeRef.parse', in: 'agent:alice\n', note: 'survey 15' },
  { id: 'ref-019', op: 'scopeRef.parse', in: '' },
  { id: 'ref-020', op: 'scopeRef.parse', in: 'agent' },
  { id: 'ref-021', op: 'scopeRef.parse', in: 'agent:alice+model=x' },
  { id: 'ref-022', op: 'scopeRef.parse', in: 'agent:alice/lane:main' },
  { id: 'ref-023', op: 'scopeRef.parse', in: 'agent:alice:project:demo:task:' },
  { id: 'ref-024', op: 'scopeRef.parse', in: 'agent:alice:project:demo:task:t1:role:' },
  { id: 'ref-025', op: 'scopeRef.parse', in: 'agent:alice:project:demo:task:t1:role:rev:x' },

  // scopeRef.format: the five kinds, round-tripping ref-001..ref-005
  { id: 'reff-001', op: 'scopeRef.format', in: { agentId: 'alice' } },
  { id: 'reff-002', op: 'scopeRef.format', in: { agentId: 'alice', projectId: 'demo' } },
  {
    id: 'reff-003',
    op: 'scopeRef.format',
    in: { agentId: 'alice', projectId: 'demo', taskId: 't1' },
  },
  {
    id: 'reff-004',
    op: 'scopeRef.format',
    in: { agentId: 'alice', projectId: 'demo', taskId: 't1', roleName: 'rev' },
  },
  {
    id: 'reff-005',
    op: 'scopeRef.format',
    in: { agentId: 'alice', projectId: 'demo', roleName: 'rev' },
  },

  // scopeHandle.parse
  { id: 'hdl-001', op: 'scopeHandle.parse', in: 'alice', note: 'survey 16' },
  {
    id: 'hdl-002',
    op: 'scopeHandle.parse',
    in: 'alice@demo',
    note: 'ruling 1: parse does not default',
  },
  { id: 'hdl-003', op: 'scopeHandle.parse', in: 'alice@demo:t1' },
  { id: 'hdl-004', op: 'scopeHandle.parse', in: 'alice@demo:t1/rev', note: 'survey 17' },
  { id: 'hdl-005', op: 'scopeHandle.parse', in: 'alice@demo/rev', note: 'survey 18' },
  { id: 'hdl-006', op: 'scopeHandle.parse', in: 'alice:t1', note: 'survey 19, ruling 2' },
  { id: 'hdl-007', op: 'scopeHandle.parse', in: 'alice@', note: 'survey 20' },
  { id: 'hdl-008', op: 'scopeHandle.parse', in: 'alice@demo/', note: 'survey 21' },
  { id: 'hdl-009', op: 'scopeHandle.parse', in: 'alice/rev', note: 'survey 22' },
  { id: 'hdl-010', op: 'scopeHandle.parse', in: 'alice@demo+model=x', note: 'survey 23' },
  { id: 'hdl-011', op: 'scopeHandle.parse', in: 'alice@b@c', note: 'survey 24' },
  { id: 'hdl-012', op: 'scopeHandle.parse', in: 'alice@demo:t1:t2', note: 'survey 25' },
  { id: 'hdl-013', op: 'scopeHandle.parse', in: 'al!ce@demo', note: 'survey 26' },
  { id: 'hdl-014', op: 'scopeHandle.parse', in: 'agent:alice', note: 'survey 27' },
  { id: 'hdl-015', op: 'scopeHandle.parse', in: '', note: 'survey 28' },
  { id: 'hdl-016', op: 'scopeHandle.parse', in: 'alice+model=x' },
  {
    id: 'hdl-017',
    op: 'scopeHandle.parse',
    in: 'alice@demo~x',
    note: 'a lane is not part of a scope handle',
  },
  { id: 'hdl-018', op: 'scopeHandle.parse', in: 'alice@demo:t1/rev/x' },

  // scopeHandle.format: round-trips hdl-001..hdl-005 from the canonical ref
  { id: 'hdlf-001', op: 'scopeHandle.format', in: 'agent:alice' },
  { id: 'hdlf-002', op: 'scopeHandle.format', in: 'agent:alice:project:demo' },
  { id: 'hdlf-003', op: 'scopeHandle.format', in: 'agent:alice:project:demo:task:t1' },
  { id: 'hdlf-004', op: 'scopeHandle.format', in: 'agent:alice:project:demo:task:t1:role:rev' },
  { id: 'hdlf-005', op: 'scopeHandle.format', in: 'agent:alice:project:demo:role:rev' },
  { id: 'hdlf-006', op: 'scopeHandle.format', in: 'agent:alice:task:t1' },

  // laneRef.normalize (null = argument absent)
  { id: 'lane-001', op: 'laneRef.normalize', in: null },
  { id: 'lane-002', op: 'laneRef.normalize', in: 'main' },
  { id: 'lane-003', op: 'laneRef.normalize', in: 'lane:main', note: 'survey 45: stays lane:main' },
  { id: 'lane-004', op: 'laneRef.normalize', in: 'lane:repair' },
  { id: 'lane-005', op: 'laneRef.normalize', in: 'deploy', note: 'survey 46' },
  { id: 'lane-006', op: 'laneRef.normalize', in: 'lane:' },
  { id: 'lane-007', op: 'laneRef.normalize', in: 'lane:bad lane' },
  { id: 'lane-008', op: 'laneRef.normalize', in: '' },
  {
    id: 'lane-009',
    op: 'laneRef.normalize',
    in: 'lane:default',
    note: 'ruling 5: a lane named default',
  },
  {
    id: 'lane-010',
    op: 'laneRef.normalize',
    in: 'default',
    note: 'ruling 5: no default → main rewrite',
  },

  // sessionHandle.parse
  { id: 'sh-001', op: 'sessionHandle.parse', in: 'alice@demo~repair', note: 'survey 29' },
  { id: 'sh-002', op: 'sessionHandle.parse', in: 'alice@demo~main', note: 'survey 30' },
  { id: 'sh-003', op: 'sessionHandle.parse', in: 'alice@demo' },
  { id: 'sh-004', op: 'sessionHandle.parse', in: 'alice@demo~', note: 'survey 31, ruling 3' },
  { id: 'sh-005', op: 'sessionHandle.parse', in: 'alice@demo~lane:x', note: 'survey 32, ruling 3' },
  { id: 'sh-006', op: 'sessionHandle.parse', in: 'alice@demo~x~y', note: 'survey 33, ruling 3' },
  { id: 'sh-007', op: 'sessionHandle.parse', in: 'alice:t1~x', note: 'survey 34' },
  { id: 'sh-008', op: 'sessionHandle.parse', in: 'agent:alice:project:demo~x', note: 'survey 35' },
  { id: 'sh-009', op: 'sessionHandle.parse', in: 'alice@demo:t1/rev~x' },
  { id: 'sh-010', op: 'sessionHandle.parse', in: '' },
  { id: 'sh-011', op: 'sessionHandle.parse', in: 'alice@demo+model=x~x' },
  { id: 'sh-012', op: 'sessionHandle.parse', in: 'alice@demo~bad lane' },

  // sessionRef.parse
  {
    id: 'sr-001',
    op: 'sessionRef.parse',
    in: 'agent:alice:project:demo/lane:main',
    note: 'survey 36',
  },
  {
    id: 'sr-002',
    op: 'sessionRef.parse',
    in: '  agent:alice/lane: repair  ',
    note: 'survey 37: trims',
  },
  { id: 'sr-003', op: 'sessionRef.parse', in: 'agent:alice/ lane:x', note: 'survey 38' },
  { id: 'sr-004', op: 'sessionRef.parse', in: 'agent:alice/lane:', note: 'survey 39' },
  { id: 'sr-005', op: 'sessionRef.parse', in: 'agent:alice', note: 'survey 40' },
  { id: 'sr-006', op: 'sessionRef.parse', in: 'alice@demo/lane:main', note: 'survey 41, ruling 4' },
  {
    id: 'sr-007',
    op: 'sessionRef.parse',
    in: 'agent:alice/lane:bad lane',
    note: 'survey 42, ruling 3',
  },
  {
    id: 'sr-008',
    op: 'sessionRef.parse',
    in: 'agent:alice/project/demo/lane:main',
    note: 'survey 43',
  },
  {
    id: 'sr-009',
    op: 'sessionRef.parse',
    in: 'agent:alice/lane:default',
    note: 'survey 44, ruling 5',
  },
  { id: 'sr-010', op: 'sessionRef.parse', in: 'cody@wrkq/lane:main', note: 'ruling 4' },
  { id: 'sr-011', op: 'sessionRef.parse', in: '' },
  { id: 'sr-012', op: 'sessionRef.parse', in: '/lane:main' },
  {
    id: 'sr-013',
    op: 'sessionRef.parse',
    in: 'agent:alice:project:demo:task:t1:role:rev/lane:repair',
  },
  { id: 'sr-014', op: 'sessionRef.parse', in: 'agent:alice:task:t1/lane:main' },

  // sessionRef.format
  {
    id: 'srf-001',
    op: 'sessionRef.format',
    in: { scopeRef: 'agent:alice:project:demo', laneRef: 'main' },
  },
  {
    id: 'srf-002',
    op: 'sessionRef.format',
    in: { scopeRef: 'agent:alice', laneRef: 'lane:repair' },
  },
  {
    id: 'srf-003',
    op: 'sessionRef.format',
    in: { scopeRef: 'agent:alice', laneRef: 'lane:main' },
    note: 'lane:main formats as lane:main',
  },
  { id: 'srf-004', op: 'sessionRef.format', in: { scopeRef: 'alice@demo', laneRef: 'main' } },
  { id: 'srf-005', op: 'sessionRef.format', in: { scopeRef: 'agent:alice', laneRef: 'deploy' } },

  // input.resolve
  { id: 'res-001', op: 'input.resolve', in: 'alice@demo', opts: {}, note: 'survey 47, ruling 1' },
  { id: 'res-002', op: 'input.resolve', in: 'alice@demo/rev', opts: {}, note: 'survey 48' },
  {
    id: 'res-003',
    op: 'input.resolve',
    in: 'alice:t1',
    opts: { projectId: 'demo' },
    note: 'survey 49, ruling 2',
  },
  { id: 'res-004', op: 'input.resolve', in: 'alice:t1', opts: {}, note: 'survey 49, ruling 2' },
  {
    id: 'res-005',
    op: 'input.resolve',
    in: 'agent:alice',
    opts: { projectId: 'demo' },
    note: 'survey 50',
  },
  {
    id: 'res-006',
    op: 'input.resolve',
    in: 'Agent:alice',
    opts: { projectId: 'demo' },
    note: 'survey 51',
  },
  {
    id: 'res-007',
    op: 'input.resolve',
    in: 'alice@demo',
    opts: { defaultRoleName: 'rev' },
    note: 'survey 52: no parsed task, no default role',
  },
  {
    id: 'res-008',
    op: 'input.resolve',
    in: 'alice@demo:t1',
    opts: { defaultRoleName: 'rev' },
    note: 'survey 52',
  },
  { id: 'res-009', op: 'input.resolve', in: 'alice', opts: {} },
  { id: 'res-010', op: 'input.resolve', in: 'alice', opts: { projectId: 'demo' } },
  {
    id: 'res-011',
    op: 'input.resolve',
    in: 'alice@demo',
    opts: { taskId: 'tA', defaultTaskId: 'tB' },
  },
  {
    id: 'res-012',
    op: 'input.resolve',
    in: 'alice@demo',
    opts: { defaultTaskId: 'tB', envDefaultTask: 'tC' },
  },
  { id: 'res-013', op: 'input.resolve', in: 'alice@demo', opts: { envDefaultTask: 'tC' } },
  { id: 'res-014', op: 'input.resolve', in: 'alice@demo', opts: { envDefaultTask: '  ' } },
  { id: 'res-015', op: 'input.resolve', in: 'alice@demo~repair', opts: {} },
  { id: 'res-016', op: 'input.resolve', in: 'alice:t1~x', opts: { projectId: 'demo' } },
  {
    id: 'res-017',
    op: 'input.resolve',
    in: 'alice@demo:t1+model=x',
    opts: {},
    note: 'directives never enter identity',
  },
  {
    id: 'res-018',
    op: 'input.resolve',
    in: 'alice@demo:t1/rev',
    opts: { defaultRoleName: 'other' },
  },
  { id: 'res-019', op: 'input.resolve', in: '', opts: {} },
  { id: 'res-020', op: 'input.resolve', in: 'agent:alice:task:t1', opts: {} },
  { id: 'res-021', op: 'input.resolve', in: 'alice@', opts: {} },
  { id: 'res-022', op: 'input.resolve', in: 'alice:t1', opts: { projectId: '' } },
  { id: 'res-023', op: 'input.resolve', in: 'alice@demo~', opts: {} },
  { id: 'res-024', op: 'input.resolve', in: 'agent:alice:project:demo', opts: {} },
  { id: 'res-025', op: 'input.resolve', in: 'agent:alice:project:demo:role:rev', opts: {} },
  { id: 'res-026', op: 'input.resolve', in: 'alice@other', opts: { projectId: 'demo' } },

  // identity.project: hrc-common legacy_derive_identity as of 2026-11-09
  { id: 'idp-001', op: 'identity.project', in: 'agent:alice' },
  { id: 'idp-002', op: 'identity.project', in: 'agent:alice:project:demo' },
  { id: 'idp-003', op: 'identity.project', in: 'agent:alice:project:demo:task:t1' },
  { id: 'idp-004', op: 'identity.project', in: 'agent:alice:project:demo:task:t1:role:rev' },
  { id: 'idp-005', op: 'identity.project', in: 'agent:alice:project:demo:role:rev' },
  { id: 'idp-006', op: 'identity.project', in: 'agent:a:project:', note: 'survey 11' },
  {
    id: 'idp-007',
    op: 'identity.project',
    in: 'agent:a:project:p:task:bad token',
    note: 'survey 11',
  },
  { id: 'idp-008', op: 'identity.project', in: 'agent:a:task:t', note: 'survey 11' },
  { id: 'idp-009', op: 'identity.project', in: 'agent:al ice', note: 'survey 11' },
  { id: 'idp-010', op: 'identity.project', in: 'agent:task:project:p:task:t', note: 'survey 12' },
  { id: 'idp-011', op: 'identity.project', in: 'agent:' },
  { id: 'idp-012', op: 'identity.project', in: '' },
  { id: 'idp-013', op: 'identity.project', in: 'cody@wrkq' },
  { id: 'idp-014', op: 'identity.project', in: 'agent:alice/lane:main' },
  { id: 'idp-015', op: 'identity.project', in: 'agent:alice:project:demo:task:t1:role:rev:x' },
  { id: 'idp-016', op: 'identity.project', in: 'Agent:alice' },
  { id: 'idp-017', op: 'identity.project', in: 'agent:alice:project:demo~x' },
  { id: 'idp-018', op: 'identity.project', in: 'agent:alice:project:demo:channel:x' },
  { id: 'idp-019', op: 'identity.project', in: 'agent:alice:project:demo:role:r:task:t' },
]
