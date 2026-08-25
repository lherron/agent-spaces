import type {
  AgentHarnessControlAck,
  AgentHarnessControlChannel,
  AgentHarnessControlEventFrame,
  AgentHarnessControlNotification,
  AgentHarnessControlReadyFrame,
  AgentHarnessControlRequest,
  AgentHarnessControlSessionConfigFrame,
  AgentHarnessControlTurnBeginFrame,
} from '../src/index.js'

// T-07565 red acceptance context: the two ack-bearing D2 verbs must be
// requests, never members of the fire-and-forget notification surface. This
// compile-only contract deliberately exercises the public consumer API.

declare const channel: AgentHarnessControlChannel
declare const sessionConfig: AgentHarnessControlSessionConfigFrame
declare const turnBegin: AgentHarnessControlTurnBeginFrame
declare const ready: AgentHarnessControlReadyFrame
declare const event: AgentHarnessControlEventFrame

const sessionConfigRequest: AgentHarnessControlRequest = sessionConfig
const turnBeginRequest: AgentHarnessControlRequest = turnBegin
const readyNotification: AgentHarnessControlNotification = ready
const eventNotification: AgentHarnessControlNotification = event

const sessionConfigAck: Promise<AgentHarnessControlAck> = channel.request(sessionConfigRequest)
const turnBeginAck: Promise<AgentHarnessControlAck> = channel.request(turnBeginRequest)
channel.send(readyNotification)
channel.send(eventNotification)

async function requirePositiveAck() {
  const configResponse = await sessionConfigAck
  const turnResponse = await turnBeginAck
  const configAccepted: true = configResponse.ack
  const turnAccepted: true = turnResponse.ack
  void configAccepted
  void turnAccepted
}

// @ts-expect-error EXCEPTION(T-07565): session.config requires an awaited ack.
channel.send(sessionConfig)
// @ts-expect-error EXCEPTION(T-07565): turn.begin requires an awaited ack.
channel.send(turnBegin)

void sessionConfigAck
void turnBeginAck
void requirePositiveAck
