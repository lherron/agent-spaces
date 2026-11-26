# Agent-authored runtime resources

## Ownership

Agent directories declare the desired event hooks and external channel
bindings. ASP reads and validates those files and compiles a deterministic
plan with `core/config/src/resources/compiler.ts#compileResourcesPlan`.
The plan describes desired projections and carries their source identity.
Compilation leaves ACP's operational stores untouched.

ACP owns the operational rows, decides whether a plan can be applied, and
provides the apply, status, and reconcile surfaces. Runtime changes in those
stores leave the authored files untouched. This lets the owner enforce store
constraints, update provenance transactionally, and preserve execution history.

An authored event hook lives in `event-hooks/` and projects to an ACP job with
an event trigger. Bare `hooks/` is reserved for harness and shell hook
concepts. Keeping the directories distinct lets resource discovery tell an
ACP subscription from a harness hook without running either one. The compiler
enforces the distinction in
`core/config/src/resources/compiler.ts#discoverResourceFiles`.

## Provenance

`managedBy: agent-directory` identifies a managed plan and its projections.
A source owner scope, resource kind, and resource name identify the declaration.
The projection also carries the source path and the intended operational row.

`core/config/src/resources/compiler.ts#resourceProjection` computes two hashes.

- `sourceHash` hashes the normalized parsed source. Formatting-only edits leave
  it unchanged.
- `desiredProjectionHash` hashes the canonical desired row shape. ACP can
  compare that shape with the operational row without rediscovering source
  files or interpreting their syntax.

ACP stores provenance beside the row it manages, in the owning jobs or
interface store. Each store commits the operational row and provenance in one
transaction. A plan can span both stores, so apply gives a result for each
resource. Callers can retry the same desired plan after a partial result.

Manual rows have no managed provenance. Taking over a manual row is an
explicit adoption with evidence of which row is being adopted. Reconcile
acts on the source owner's managed projections. A source removed from a plan
is reconciled through ACP's stale-resource policy, which can disable the
projection while preserving its history.

## Where checks run

- ASP rejects malformed source, unsupported paths, and cross-owner targets
  during plan compilation. The refusal identifies the offending source.
  Event target ownership is checked by
  `core/config/src/resources/compiler.ts#assertSameOwnerEventTarget`.
- ACP validates the compiled plan at its mutation boundary. Runtime checks
  such as the availability of a named gateway belong to ACP, because ASP
  compiles declarations independently of the deployed gateway inventory.
- ACP's managed binding or job store checks collisions before changing the
  conflicting row. Generic binding upsert cannot establish ownership.
- ACP status reads operational drift. Reapplying the same source keeps the
  declared desired shape authoritative even if an operator edited the row.
- A source owner rename requires an explicit migration of its projections.
  ACP keys provenance by source owner, so an ordinary apply for a new owner
  cannot silently take over the old owner's rows.
