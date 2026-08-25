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
  AgentHarnessControlProtocolVersion,
  AgentHarnessControlSdk,
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
void validationError
