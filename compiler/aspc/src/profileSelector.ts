import type { AspcCompileHarnessInvocationRequest } from 'spaces-aspc-protocol'
import type {
  BrokerExecutionProfile,
  CompileDiagnostic,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DIAGNOSTIC_CODES, compilerDiagnostic } from './diagnostics.js'

type CompiledPlan = Extract<RuntimeCompileResponse, { ok: true }>['plan']
type ProfileSelector = NonNullable<AspcCompileHarnessInvocationRequest['profileSelector']>

export type BrokerProfileSelection =
  | { ok: true; profile: BrokerExecutionProfile }
  | { ok: false; diagnostic: CompileDiagnostic }

// Selector key ↔ profile field pairs. The keys are intentionally shared so a
// new dimension is one extra entry rather than another `if (...)` block.
const SELECTOR_CRITERIA: ReadonlyArray<{
  field: keyof ProfileSelector & keyof BrokerExecutionProfile
}> = [{ field: 'profileId' }, { field: 'profileHash' }, { field: 'brokerDriver' }]

export function selectBrokerProfile(
  plan: CompiledPlan,
  selector: AspcCompileHarnessInvocationRequest['profileSelector']
): BrokerProfileSelection {
  const brokerProfiles = plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )

  // Driven by a table so a new selector dimension is added by appending one
  // entry (Open/Closed): each criterion narrows the candidate list only when
  // the corresponding selector key is provided.
  const profiles = SELECTOR_CRITERIA.reduce((candidates, { field }) => {
    const expected = selector?.[field]
    if (expected === undefined) {
      return candidates
    }
    return candidates.filter((profile) => profile[field] === expected)
  }, brokerProfiles)

  // A single matched profile is always returned. `profiles[0]` is non-undefined
  // whenever `length === 1`, so rely on the length check directly rather than a
  // redundant `!== undefined` guard that could otherwise let the single-match
  // case fall through to the `broker_profile_missing` diagnostic below.
  if (profiles.length === 1) {
    return { ok: true, profile: profiles[0] as BrokerExecutionProfile }
  }

  if (profiles.length === 0) {
    return {
      ok: false,
      diagnostic: compilerDiagnostic(
        DIAGNOSTIC_CODES.brokerProfileMissing,
        'No harness-broker profile matched the ASPC selector',
        {
          selector,
          profileCount: plan.executionProfiles.length,
        }
      ),
    }
  }

  return {
    ok: false,
    diagnostic: compilerDiagnostic(
      DIAGNOSTIC_CODES.brokerProfileAmbiguous,
      'Multiple harness-broker profiles matched the ASPC selector',
      {
        selector,
        matchedProfiles: profiles.map((profile) => ({
          profileId: profile.profileId,
          profileHash: profile.profileHash,
          brokerDriver: profile.brokerDriver,
        })),
      }
    ),
  }
}
