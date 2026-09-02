import {
  AGENT_HARNESS_CONTROL_PROTOCOL_VERSION,
  AgentHarnessControlFrameError,
  AgentHarnessControlValidationError,
} from '../src/index.js'
import type {
  AgentHarnessControlAuth,
  AgentHarnessControlFrame,
  AgentHarnessControlFrameResult,
  AgentHarnessControlHelloFrame,
  AgentHarnessControlNackCode,
  AgentHarnessControlNegativeAck,
  AgentHarnessControlPositiveAck,
  AgentHarnessControlProtocolVersion,
  AgentHarnessControlSdk,
  AgentHarnessControlTurnInterruptFrame,
  AgentHarnessSessionConfig,
} from '../src/index.js'

// T-07565 public contract coverage for the auxiliary control-channel types.
// The behavioral and request/response surfaces are covered by the frozen reds.

const protocolVersion: AgentHarnessControlProtocolVersion = AGENT_HARNESS_CONTROL_PROTOCOL_VERSION

declare const auth: AgentHarnessControlAuth
declare const sdk: AgentHarnessControlSdk
declare const config: AgentHarnessSessionConfig
declare const hello: AgentHarnessControlHelloFrame
declare const frame: AgentHarnessControlFrame
declare const frameResult: AgentHarnessControlFrameResult
declare const nackCode: AgentHarnessControlNackCode
declare const negativeAck: AgentHarnessControlNegativeAck
declare const positiveAck: AgentHarnessControlPositiveAck
declare const turnInterrupt: AgentHarnessControlTurnInterruptFrame

const authProjection: AgentHarnessControlAuth = auth
const sdkProjection: AgentHarnessControlSdk = sdk
const configProjection: AgentHarnessSessionConfig = config
const helloFrame: AgentHarnessControlFrame = hello
const controlFrame: AgentHarnessControlFrame = frame
const controlResult: AgentHarnessControlFrameResult = frameResult
const frameError = new AgentHarnessControlFrameError('invalid frame')
const validationError = new AgentHarnessControlValidationError([])

void protocolVersion
void authProjection
void sdkProjection
void configProjection
void helloFrame
void controlFrame
void controlResult
void frameError
const refusalCode: AgentHarnessControlNackCode = nackCode
const refusal: AgentHarnessControlNegativeAck = negativeAck
const acceptance: AgentHarnessControlPositiveAck = positiveAck
const interruptFrame: AgentHarnessControlFrame = turnInterrupt

void validationError
void refusalCode
void refusal
void acceptance
void interruptFrame
