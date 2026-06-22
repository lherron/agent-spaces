// T-05007 acceptance bar: runtime-state/v1 and public runtime-row status
// vocabularies are separate, closed, const-array-derived public contracts.

import type { RuntimeStateBase, RuntimeStateStatus, RuntimeStatus } from '../src/index'
import {
  RUNTIME_STATE_STATUS_VALUES,
  RUNTIME_STATUS_VALUES,
  isRuntimeStateStatus,
  isRuntimeStatus,
} from '../src/index'

declare const arbitraryString: string

// @ts-expect-error EXCEPTION(T-05007): RuntimeStateStatus is closed; arbitrary strings must not assign.
const _badRuntimeStateStatus: RuntimeStateStatus = arbitraryString
void _badRuntimeStateStatus

// @ts-expect-error EXCEPTION(T-05007): RuntimeStatus is closed; arbitrary strings must not assign.
const _badRuntimeStatus: RuntimeStatus = arbitraryString
void _badRuntimeStatus

const _allRuntimeStateValuesAssignToRuntimeStateStatus: RuntimeStateStatus[] = [
  ...RUNTIME_STATE_STATUS_VALUES,
]
void _allRuntimeStateValuesAssignToRuntimeStateStatus

const _allRuntimeValuesAssignToRuntimeStatus: RuntimeStatus[] = [...RUNTIME_STATUS_VALUES]
void _allRuntimeValuesAssignToRuntimeStatus

const _allRuntimeStateValuesAreRuntimeStatuses: RuntimeStatus[] = [...RUNTIME_STATE_STATUS_VALUES]
void _allRuntimeStateValuesAreRuntimeStatuses

const _hrcRuntimeStateJsonValues: RuntimeStateStatus[] = ['awaiting_input', 'stale', 'terminated']
void _hrcRuntimeStateJsonValues

const _runtimeStateBaseUsesRuntimeStateStatus: RuntimeStateBase['status'] = 'awaiting_input'
void _runtimeStateBaseUsesRuntimeStateStatus

const _rowOnlyRuntimeStatuses: RuntimeStatus[] = ['dead', 'adopted']
void _rowOnlyRuntimeStatuses

// @ts-expect-error EXCEPTION(T-05007): adopted is row/public-only unless a runtime-state producer is added.
const _adoptedIsNotRuntimeStateStatus: RuntimeStateStatus = 'adopted'
void _adoptedIsNotRuntimeStateStatus

// @ts-expect-error EXCEPTION(T-05007): dead is row/public-only unless a runtime-state producer is added.
const _deadIsNotRuntimeStateStatus: RuntimeStateStatus = 'dead'
void _deadIsNotRuntimeStateStatus

// @ts-expect-error EXCEPTION(T-05007): zombied is a reconcile result, not a runtime status.
const _zombiedIsNotRuntimeStateStatus: RuntimeStateStatus = 'zombied'
void _zombiedIsNotRuntimeStateStatus

// @ts-expect-error EXCEPTION(T-05007): zombied is a reconcile result, not a runtime status.
const _zombiedIsNotRuntimeStatus: RuntimeStatus = 'zombied'
void _zombiedIsNotRuntimeStatus

const _guards: [
  (value: unknown) => value is RuntimeStateStatus,
  (value: unknown) => value is RuntimeStatus,
] = [isRuntimeStateStatus, isRuntimeStatus]
void _guards
