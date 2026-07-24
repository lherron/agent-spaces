import type { InvocationId, MessageId, TurnId } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../src/drivers/driver.ts'
import type { InvocationEventSequencer } from '../src/events.ts'

declare const sequencer: InvocationEventSequencer
declare const driverContext: DriverContext
declare const invocationId: InvocationId

sequencer.next(invocationId, 'assistant.message.delta', {
  messageId: 'msg_1' as MessageId,
  text: 'hello',
})
sequencer.next(invocationId, 'assistant.message.delta', {
  // @ts-expect-error EXCEPTION(T-06393): negative assertion pins sequencer payload selection.
  turnId: 'turn_1' as TurnId,
  status: 'completed',
})

driverContext.emit('assistant.message.delta', {
  messageId: 'msg_1' as MessageId,
  text: 'hello',
})
driverContext.emit('assistant.message.delta', {
  // @ts-expect-error EXCEPTION(T-06393): negative assertion pins driver emit payload selection.
  turnId: 'turn_1' as TurnId,
  status: 'completed',
})
