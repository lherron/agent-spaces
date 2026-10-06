import { isAbsolute } from 'node:path'
import type { ArrisHostDescriptor, HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'

export const ARRIS_RESIDENT_DRIVER_KIND = 'arris-resident'

export interface ArrisResidentDriverSpec {
  kind: typeof ARRIS_RESIDENT_DRIVER_KIND
  descriptorPath: string
  hostIncarnationId: string
  hostLifecycleOwner?: 'external' | 'hrc-managed' | undefined
  launchId?: string | null | undefined
}

export function parseSpec(startSpec: HarnessInvocationSpec): ArrisResidentDriverSpec {
  if (startSpec.driver.kind !== ARRIS_RESIDENT_DRIVER_KIND)
    throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid Arris resident driver spec')
  if (startSpec.continuation !== undefined) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident cannot resume a previous host incarnation'
    )
  }
  const value = startSpec.driver as Record<string, unknown>
  if (typeof value['descriptorPath'] !== 'string' || !isAbsolute(value['descriptorPath'])) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident descriptorPath must be absolute'
    )
  }
  if (typeof value['hostIncarnationId'] !== 'string' || value['hostIncarnationId'].length === 0) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident hostIncarnationId is required'
    )
  }
  if (
    value['hostLifecycleOwner'] !== undefined &&
    value['hostLifecycleOwner'] !== 'external' &&
    value['hostLifecycleOwner'] !== 'hrc-managed'
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident hostLifecycleOwner is invalid'
    )
  }
  if (
    value['launchId'] !== undefined &&
    value['launchId'] !== null &&
    typeof value['launchId'] !== 'string'
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident launchId must be a string or null'
    )
  }
  return value as unknown as ArrisResidentDriverSpec
}

export function assertDescriptorMatchesSpec(
  spec: ArrisResidentDriverSpec,
  descriptor: ArrisHostDescriptor
): void {
  const actual = descriptor.host_incarnation.host_incarnation_id
  if (actual !== spec.hostIncarnationId) {
    throw new BrokerError(
      BrokerErrorCode.IdentityInstallConflict,
      `Arris descriptor belongs to foreign host ${actual}`,
      { expectedHostIncarnationId: spec.hostIncarnationId }
    )
  }
  if (
    spec.hostLifecycleOwner !== undefined &&
    descriptor.lifecycle.host_lifecycle_owner !== spec.hostLifecycleOwner
  ) {
    throw new BrokerError(
      BrokerErrorCode.IdentityInstallConflict,
      'Arris host lifecycle owner does not match prepared binding'
    )
  }
  if (spec.launchId !== undefined && descriptor.lifecycle.launch_id !== spec.launchId) {
    throw new BrokerError(
      BrokerErrorCode.IdentityInstallConflict,
      'Arris host launch id does not match prepared binding'
    )
  }
}
