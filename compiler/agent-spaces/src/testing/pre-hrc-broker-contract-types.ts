export type ContractHarnessFailureCode =
  | 'broker_profile_invalid'
  | 'broker_protocol_invalid'
  | 'broker_driver_missing'
  | 'start_request_identity_mismatch'
  | 'initial_input_identity_mismatch'
  | 'start_request_hash_mismatch'
  | 'shared_command_turn_missing'
  | 'shared_command_turn_invalid'

export type ContractHarnessFailure = {
  code: ContractHarnessFailureCode
  message: string
  path?: string | undefined
  redactedDetails?: unknown
}
