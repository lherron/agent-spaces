import type {
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventEnvelopeBase,
  InvocationEventEnvelopeFor,
  InvocationEventFor,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationId,
  MessageId,
  ProviderTranscriptEmitContext,
  TurnId,
  validateEventEnvelope,
} from '../src/index.js'

declare function acceptEvent(event: InvocationEventEnvelope): void
declare const emitContext: ProviderTranscriptEmitContext
declare const deltaEnvelope: InvocationEventEnvelope<'assistant.message.delta'>

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false
type Expect<T extends true> = T
type _EventNamesComeFromThePayloadMap = Expect<
  Equal<InvocationEventType, keyof InvocationEventPayloadMap>
>
type _ValidatorPreservesTheSelectedPayload = Expect<
  Equal<ReturnType<typeof validateEventEnvelope<'assistant.message.delta'>>, typeof deltaEnvelope>
>
type _EnvelopeIsDerivedFromTheKeyedMember = Expect<
  Equal<
    InvocationEventEnvelopeFor<'assistant.message.delta'>,
    InvocationEventEnvelopeBase & InvocationEventFor<'assistant.message.delta'>
  >
>
type _DescriptorUnionIsCorrelated = Expect<
  Equal<InvocationEvent, { [K in InvocationEventType]: InvocationEventFor<K> }[InvocationEventType]>
>

// The event name must select its payload. This intentionally pairs a valid
// assistant event name with another event's otherwise-valid payload.
acceptEvent({
  invocationId: 'inv_1' as InvocationId,
  seq: 1,
  time: '2026-07-24T00:00:00.000Z',
  type: 'assistant.message.delta',
  // @ts-expect-error EXCEPTION(T-06393): negative assertion pins event-name/payload coupling.
  payload: { turnId: 'turn_1' as TurnId, status: 'completed' },
})

emitContext.emit('assistant.message.delta', { messageId: 'msg_1' as MessageId, text: 'hello' })
emitContext.emit('assistant.message.delta', {
  // @ts-expect-error EXCEPTION(T-06393): negative assertion pins keyed emitter coupling.
  turnId: 'turn_1' as TurnId,
  status: 'completed',
})
