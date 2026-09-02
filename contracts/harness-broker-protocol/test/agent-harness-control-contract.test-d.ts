import type {
  AgentHarnessControlAck,
  AgentHarnessControlChannel,
  AgentHarnessControlEventFrame,
  AgentHarnessControlNackCode,
  AgentHarnessControlNegativeAck,
  AgentHarnessControlNotification,
  AgentHarnessControlPositiveAck,
  AgentHarnessControlReadyFrame,
  AgentHarnessControlRequest,
  AgentHarnessControlSessionConfigFrame,
  AgentHarnessControlTurnBeginFrame,
  AgentHarnessControlTurnInterruptFrame,
} from '../src/index.js'

// Ack-bearing control verbs must be
// requests, never members of the fire-and-forget notification surface. This
// compile-only contract deliberately exercises the public consumer API.

declare const channel: AgentHarnessControlChannel
declare const sessionConfig: AgentHarnessControlSessionConfigFrame
declare const turnBegin: AgentHarnessControlTurnBeginFrame
declare const turnInterrupt: AgentHarnessControlTurnInterruptFrame
declare const ready: AgentHarnessControlReadyFrame
declare const event: AgentHarnessControlEventFrame

const sessionConfigRequest: AgentHarnessControlRequest = sessionConfig
const turnBeginRequest: AgentHarnessControlRequest = turnBegin
const turnInterruptRequest: AgentHarnessControlRequest = turnInterrupt
const readyNotification: AgentHarnessControlNotification = ready
const eventNotification: AgentHarnessControlNotification = event

const sessionConfigAck: Promise<AgentHarnessControlAck> = channel.request(sessionConfigRequest)
const turnBeginAck: Promise<AgentHarnessControlAck> = channel.request(turnBeginRequest)
const turnInterruptAck: Promise<AgentHarnessControlAck> = channel.request(turnInterruptRequest)
channel.send(readyNotification)
channel.send(eventNotification)

// T-07584: the ack result is a discriminated union, so a consumer cannot read a
// refusal's code without first narrowing on `ack` — the negative branch can
// never be silently treated as success.
async function narrowAck() {
  const configResponse = await sessionConfigAck
  const turnResponse = await turnBeginAck
  if (configResponse.ack) {
    const configAccepted: true = configResponse.ack
    void configAccepted
  }
  if (!turnResponse.ack) {
    const code: AgentHarnessControlNackCode = turnResponse.code
    const message: string = turnResponse.message
    void code
    void message
    return
  }
  const turnAccepted: true = turnResponse.ack
  void turnAccepted
}

declare const negativeAck: AgentHarnessControlNegativeAck
declare const positiveAck: AgentHarnessControlPositiveAck
const anyAck: AgentHarnessControlAck[] = [negativeAck, positiveAck]
void anyAck

// @ts-expect-error EXCEPTION(T-07584): the refusal code set is closed.
const unknownCode: AgentHarnessControlNackCode = 'session_config_failed'
void unknownCode

function readCodeWithoutNarrowing(ack: AgentHarnessControlAck) {
  // @ts-expect-error EXCEPTION(T-07584): `code` is unreachable until `ack` narrows.
  return ack.code
}
void readCodeWithoutNarrowing

// @ts-expect-error EXCEPTION(T-07565): session.config requires an awaited ack.
channel.send(sessionConfig)
// @ts-expect-error EXCEPTION(T-07565): turn.begin requires an awaited ack.
channel.send(turnBegin)
// @ts-expect-error EXCEPTION(T-07869): turn.interrupt requires an awaited ack.
channel.send(turnInterrupt)

void sessionConfigAck
void turnBeginAck
void turnInterruptAck
void narrowAck
