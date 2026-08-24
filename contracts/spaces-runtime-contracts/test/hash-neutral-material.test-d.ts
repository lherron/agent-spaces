import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { HashNeutralInvocationSpecMaterial, StartRequestHashMaterial } from '../src/index'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false
type Expect<Value extends true> = Value

type ExpectedNeutralSpec = Omit<HarnessInvocationSpec, 'invocationId' | 'correlation'>
type ExpectedNeutralStartRequest = Omit<InvocationStartRequest, 'spec' | 'initialInput'> & {
  spec: ExpectedNeutralSpec
  initialInput?:
    | {
        inputId: NonNullable<InvocationStartRequest['initialInput']>['inputId']
        responseFormat?: NonNullable<InvocationStartRequest['initialInput']>['responseFormat']
      }
    | undefined
}

type _NeutralSpecPublicShape = Expect<Equal<HashNeutralInvocationSpecMaterial, ExpectedNeutralSpec>>
type _NeutralStartRequestPublicShape = Expect<
  Equal<StartRequestHashMaterial, ExpectedNeutralStartRequest>
>
type _InvocationIdExcluded = Expect<
  Equal<'invocationId' extends keyof HashNeutralInvocationSpecMaterial ? true : false, false>
>
type _CorrelationExcluded = Expect<
  Equal<'correlation' extends keyof HashNeutralInvocationSpecMaterial ? true : false, false>
>
type _InitialInputPublicShape = Expect<
  Equal<
    NonNullable<StartRequestHashMaterial['initialInput']>,
    {
      inputId: NonNullable<InvocationStartRequest['initialInput']>['inputId']
      responseFormat?: NonNullable<InvocationStartRequest['initialInput']>['responseFormat']
    }
  >
>
