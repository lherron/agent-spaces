import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx, ProbeCase } from '../ctx.ts'

const C = 'aspc.compileHarnessInvocation'
const I = 'aspc.inspectRuntimePlacement'

const sp = (id: string, extra = '') =>
  `schema = 1\nid = "${id}"\nversion = "1.0.0"\ndescription = "probe space"\n\n[plugin]\nname = "${id}"\n${extra}`
const prof = (refs: string[]) =>
  `version = 4\npriming = "probe priming"\n\n[spaces]\nbase = [${refs.map((r) => JSON.stringify(r)).join(', ')}]\n`

/** Inspect request for `agent`, cloned from inspect:claude:preview. */
const inspectFor = (c: Ctx, agent: string, from = 'inspect:claude:preview') => {
  const p = c.base(from)
  const old = p.context.agentId
  p.context.agentId = agent
  p.context.agentRoot = join(c.stage.agentsRoot, agent)
  const swap = (s: string) => s.split(`agent:${old}:`).join(`agent:${agent}:`)
  if (p.preparationCorrelation?.sessionRef?.scopeRef)
    p.preparationCorrelation.sessionRef.scopeRef = swap(
      p.preparationCorrelation.sessionRef.scopeRef
    )
  if (p.dispatchEnv?.AGENT_SCOPE_REF)
    p.dispatchEnv.AGENT_SCOPE_REF = swap(p.dispatchEnv.AGENT_SCOPE_REF)
  return p
}

/** A fresh per-case ASP_HOME for compiles that must not touch the shared one. */
const ownAspHome = (c: Ctx) => {
  const h = join(c.dir, 'asp-home')
  mkdirSync(h, { recursive: true })
  return h
}

const long = 'a'.repeat(65)

/** Re-runs: give back the owner bits a previous run took away. */
const unlock = (...paths: string[]) => {
  for (const p of paths) {
    try {
      chmodSync(p, 0o755)
    } catch {}
  }
}

const cases: ProbeCase[] = [
  // -- registry (git-pinned) spaces --------------------------------------------
  {
    reason: 'registry_space',
    id: 'registry_space--git-pin-compile',
    method: C,
    condition: 'profile composes space:pm-pinned@git:<sha> (seeded pathmark agent)',
    params: (c) => c.base('compile:claude-code'),
  },
  {
    reason: 'registry_space',
    id: 'registry_space--git-pin-inspect',
    method: I,
    condition: 'inspect of an agent composing a git-pinned space',
    params: (c) => c.base('inspect:claude:pinned'),
  },
  {
    reason: 'registry_space',
    id: 'registry_space--dist-tag',
    method: C,
    condition: 'profile composes space:pm-dev@stable (dist-tag selector, needs registry git)',
    setup: (c) => {
      c.agent('p-rs-tag', prof(['space:pm-dev@stable']))
    },
    params: (c) => c.compileFor('p-rs-tag'),
  },
  {
    reason: 'registry_space',
    id: 'registry_space--head-unknown',
    method: C,
    condition: 'profile composes space:p-rs-nosuch@HEAD (space absent from the registry repo)',
    setup: (c) => {
      c.agent('p-rs-head', prof(['space:p-rs-nosuch@HEAD']))
    },
    params: (c) => c.compileFor('p-rs-head'),
  },

  // -- path refs -----------------------------------------------------------------
  {
    reason: 'space_path_ref',
    id: 'space_path_ref--abs-dev',
    method: C,
    condition: 'profile composes space:path:<absolute dir>@dev pointing at a valid space',
    setup: (c) => {
      const dir = join(c.dir, 'p-spr-space')
      c.write(join(dir, 'space.toml'), sp('p-spr-space'))
      c.write(
        join(dir, 'skills', 'spr-skill', 'SKILL.md'),
        '---\nname: spr-skill\ndescription: path ref skill.\n---\n\nLoaded.\n'
      )
      c.agent('p-spr-agent', prof([`space:path:${dir}@dev`]))
    },
    params: (c) => c.compileFor('p-spr-agent'),
  },
  {
    reason: 'space_path_ref',
    id: 'space_path_ref--abs-head',
    method: C,
    condition: 'profile composes space:path:<absolute dir>@HEAD (non-dev selector)',
    setup: (c) => {
      const dir = join(c.dir, 'p-sprh-space')
      c.write(join(dir, 'space.toml'), sp('p-sprh-space'))
      c.agent('p-sprh-agent', prof([`space:path:${dir}@HEAD`]))
    },
    params: (c) => c.compileFor('p-sprh-agent'),
  },

  // -- ids -----------------------------------------------------------------------
  {
    reason: 'space_id_invalid',
    id: 'space_id_invalid--registry',
    method: C,
    condition: 'profile composes space:<65-char id>@dev (pattern ok, over the 64-char bound)',
    setup: (c) => {
      c.agent('p-sii-reg', prof([`space:${long}@dev`]))
    },
    params: (c) => c.compileFor('p-sii-reg'),
  },
  {
    reason: 'space_id_invalid',
    id: 'space_id_invalid--agent',
    method: C,
    condition: 'profile composes space:agent:<65-char id>',
    setup: (c) => {
      c.agent('p-sii-agent', prof([`space:agent:${long}`]))
    },
    params: (c) => c.compileFor('p-sii-agent'),
  },

  // -- ref grammar (expected unreachable: profile validation rejects first) ------
  {
    reason: 'space_ref_invalid',
    id: 'space_ref_invalid--profile-guard',
    method: C,
    condition:
      'profile composes space:agent:foo@ (empty selector), which only the profile schema can see first',
    setup: (c) => {
      c.agent('p-sri-agent', prof(['space:agent:foo@']))
    },
    params: (c) => c.compileFor('p-sri-agent'),
  },

  // -- roots -----------------------------------------------------------------------
  {
    reason: 'project_root_required',
    method: C,
    condition: 'profile composes space:project:<id> and placement carries no projectRoot',
    setup: (c) => {
      c.agent('p-prr-agent', prof(['space:project:p-prr-space']))
    },
    params: (c) => {
      const p = c.compileFor('p-prr-agent')
      p.compileRequest.placement.projectRoot = undefined
      return p
    },
  },

  // -- graph -----------------------------------------------------------------------
  {
    reason: 'cyclic_dependency',
    method: C,
    condition: 'two @dev registry spaces depend on each other',
    setup: (c) => {
      c.space('p-cyc-a', sp('p-cyc-a', '\n[deps]\nspaces = ["space:p-cyc-b@dev"]\n'))
      c.space('p-cyc-b', sp('p-cyc-b', '\n[deps]\nspaces = ["space:p-cyc-a@dev"]\n'))
      c.agent('p-cyc-agent', prof(['space:p-cyc-a@dev']))
    },
    params: (c) => c.compileFor('p-cyc-agent'),
  },
  {
    reason: 'disallowed_dependency_edge',
    method: C,
    condition: 'a @dev registry space depends on space:agent:<id>',
    setup: (c) => {
      c.space('p-dde-reg', sp('p-dde-reg', '\n[deps]\nspaces = ["space:agent:p-dde-local"]\n'))
      c.agent('p-dde-agent', prof(['space:p-dde-reg@dev']), {
        'spaces/p-dde-local/space.toml': sp('p-dde-local'),
      })
    },
    params: (c) => c.compileFor('p-dde-agent'),
  },

  // -- manifests -------------------------------------------------------------------
  {
    reason: 'space_manifest_unreadable',
    id: 'space_manifest_unreadable--missing',
    method: C,
    condition: 'profile composes space:<id>@dev with no spaces/<id>/space.toml under the registry',
    setup: (c) => {
      c.agent('p-smu-agent', prof(['space:p-smu-nosuch@dev']))
    },
    params: (c) => c.compileFor('p-smu-agent'),
  },
  {
    reason: 'space_manifest_unreadable',
    id: 'space_manifest_unreadable--eacces',
    method: C,
    condition: 'space.toml of a composed agent space exists but is mode 000',
    setup: (c) => {
      unlock(join(c.stage.agentsRoot, 'p-smue-agent', 'spaces', 'p-smue-local', 'space.toml'))
      const root = c.agent('p-smue-agent', prof(['space:agent:p-smue-local']), {
        'spaces/p-smue-local/space.toml': sp('p-smue-local'),
      })
      chmodSync(join(root, 'spaces', 'p-smue-local', 'space.toml'), 0o000)
    },
    params: (c) => c.compileFor('p-smue-agent'),
  },
  {
    reason: 'space_manifest_toml',
    method: C,
    condition: 'space.toml of a composed @dev space is not valid TOML',
    setup: (c) => {
      c.space('p-smt', 'schema = [\n')
      c.agent('p-smt-agent', prof(['space:p-smt@dev']))
    },
    params: (c) => c.compileFor('p-smt-agent'),
  },
  {
    reason: 'space_manifest_invalid',
    id: 'space_manifest_invalid--unknown-key',
    method: C,
    condition: 'space.toml parses but carries a key the schema forbids',
    setup: (c) => {
      c.space('p-smi-key', sp('p-smi-key', '\n[bogus]\nx = 1\n'))
      c.agent('p-smi-key-agent', prof(['space:p-smi-key@dev']))
    },
    params: (c) => c.compileFor('p-smi-key-agent'),
  },
  {
    reason: 'space_manifest_invalid',
    id: 'space_manifest_invalid--plugin-author',
    method: C,
    condition:
      'space.toml has a schema-valid [plugin.author] (raspd will not judge email/uri formats)',
    setup: (c) => {
      c.space(
        'p-smi-author',
        sp(
          'p-smi-author',
          'homepage = "https://example.com/p"\n\n[plugin.author]\nname = "Probe"\nemail = "probe@example.com"\n'
        )
      )
      c.agent('p-smi-author-agent', prof(['space:p-smi-author@dev']))
    },
    params: (c) => c.compileFor('p-smi-author-agent'),
  },
  {
    reason: 'space_manifest_invalid',
    id: 'space_manifest_invalid--bad-email',
    method: C,
    condition: 'space.toml [plugin.author].email is not an email (ajv-formats rejects it)',
    setup: (c) => {
      c.space(
        'p-smi-email',
        sp('p-smi-email', '\n[plugin.author]\nname = "Probe"\nemail = "not an email"\n')
      )
      c.agent('p-smi-email-agent', prof(['space:p-smi-email@dev']))
    },
    params: (c) => c.compileFor('p-smi-email-agent'),
  },
  {
    reason: 'space_dep_invalid',
    id: 'space_dep_invalid--schema-guard',
    method: C,
    condition:
      'deps.spaces holds a non-string; the manifest schema sees it before the dependency walk',
    setup: (c) => {
      c.space('p-sdi', sp('p-sdi', '\n[deps]\nspaces = [1]\n'))
      c.agent('p-sdi-agent', prof(['space:p-sdi@dev']))
    },
    params: (c) => c.compileFor('p-sdi-agent'),
  },

  // -- integrity -------------------------------------------------------------------
  {
    reason: 'integrity_read',
    method: C,
    condition: 'a file inside a composed agent space is mode 000 (unreadable)',
    setup: (c) => {
      unlock(join(c.stage.agentsRoot, 'p-ir-agent', 'spaces', 'p-ir-local', 'secret.txt'))
      const root = c.agent('p-ir-agent', prof(['space:agent:p-ir-local']), {
        'spaces/p-ir-local/space.toml': sp('p-ir-local'),
        'spaces/p-ir-local/secret.txt': 'secret\n',
      })
      chmodSync(join(root, 'spaces', 'p-ir-local', 'secret.txt'), 0o000)
    },
    params: (c) => ({ ...c.compileFor('p-ir-agent'), aspHome: ownAspHome(c) }),
  },
  {
    reason: 'integrity_readdir',
    id: 'integrity_readdir--unreadable-subdir',
    method: C,
    condition:
      'a subdirectory of a composed agent space is mode 000 (opendir fails; per-entry readdir error is not arrangeable)',
    setup: (c) => {
      unlock(join(c.stage.agentsRoot, 'p-ird-agent', 'spaces', 'p-ird-local', 'locked'))
      const root = c.agent('p-ird-agent', prof(['space:agent:p-ird-local']), {
        'spaces/p-ird-local/space.toml': sp('p-ird-local'),
        'spaces/p-ird-local/locked/a.txt': 'a\n',
      })
      chmodSync(join(root, 'spaces', 'p-ird-local', 'locked'), 0o000)
    },
    params: (c) => ({ ...c.compileFor('p-ird-agent'), aspHome: ownAspHome(c) }),
  },

  // -- the same inputs through inspectRuntimePlacement --------------------------
  {
    reason: 'space_manifest_toml',
    id: 'space_manifest_toml--inspect',
    method: I,
    condition: 'inspect of an agent composing a @dev space whose space.toml is not valid TOML',
    params: (c) => inspectFor(c, 'p-smt-agent'),
  },
  {
    reason: 'cyclic_dependency',
    id: 'cyclic_dependency--inspect',
    method: I,
    condition: 'inspect of an agent whose @dev spaces depend on each other',
    params: (c) => inspectFor(c, 'p-cyc-agent'),
  },
  {
    reason: 'space_path_ref',
    id: 'space_path_ref--inspect',
    method: I,
    condition: 'inspect of an agent composing space:path:<absolute dir>@dev',
    params: (c) => inspectFor(c, 'p-spr-agent'),
  },

  // -- path filter -----------------------------------------------------------------
  {
    reason: 'path_filter_mkdir',
    method: C,
    condition:
      'a composed space has [path].exclude and <aspHome>/codex-homes/<project>_<agent>/zdotdir is a regular file',
    setup: (c) => {
      c.agent('p-pfm-agent', prof(['space:pm-path@dev']))
      const home = join(c.dir, 'asp-home')
      const scope = join(home, 'codex-homes', 'project_p-pfm-agent')
      mkdirSync(scope, { recursive: true })
      writeFileSync(join(scope, 'zdotdir'), 'not a dir\n')
    },
    params: (c) => ({ ...c.compileFor('p-pfm-agent'), aspHome: join(c.dir, 'asp-home') }),
  },
  {
    reason: 'path_filter_reset',
    id: 'path_filter_reset--farm-is-file',
    method: C,
    condition:
      'a composed space has [path].exclude and the zdotdir/farm left by an earlier birth is a regular file',
    setup: (c) => {
      c.agent('p-pfr-agent', prof(['space:pm-path@dev']))
      const home = join(c.dir, 'asp-home')
      const zd = join(home, 'codex-homes', 'project_p-pfr-agent', 'zdotdir')
      mkdirSync(zd, { recursive: true })
      writeFileSync(join(zd, 'farm'), 'not a dir\n')
    },
    params: (c) => ({ ...c.compileFor('p-pfr-agent'), aspHome: join(c.dir, 'asp-home') }),
  },
  {
    reason: 'path_filter_reset',
    id: 'path_filter_reset--farm-unremovable',
    method: C,
    condition:
      'the zdotdir/farm holds a mode-555 generation dir with an entry (rm -rf cannot unlink it)',
    setup: (c) => {
      c.agent('p-pfu-agent', prof(['space:pm-path@dev']))
      const home = join(c.dir, 'asp-home')
      const gen = join(home, 'codex-homes', 'project_p-pfu-agent', 'zdotdir', 'farm', '.build.x')
      unlock(gen)
      mkdirSync(gen, { recursive: true })
      writeFileSync(join(gen, 'entry'), 'x\n')
      chmodSync(gen, 0o555)
    },
    params: (c) => ({ ...c.compileFor('p-pfu-agent'), aspHome: join(c.dir, 'asp-home') }),
  },
]

export default cases
