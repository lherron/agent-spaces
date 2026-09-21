export type PlacementRuntimeModelResolution =
  | {
      ok: true
      info: {
        effectiveModel: string
        provider: string
        model: string
        explicit: boolean
      }
    }
  | { ok: false; modelId: string }

/**
 * Structural placement-plan contract. Generic parameters keep this bottom-layer
 * DTO independent from the concrete config-plane harness types while preserving
 * their exact types at both callers.
 */
export interface PlacementRuntimePlan<
  TFrontend extends string,
  THarnessId extends string,
  TProvider extends string,
  TRunOptions extends object,
> {
  frontend: TFrontend
  harnessId: THarnessId
  provider: TProvider
  cwd: string
  defaultRunOptions: TRunOptions
  prompt?: string | undefined
  yolo?: boolean | undefined
  model: PlacementRuntimeModelResolution
  runOptions: TRunOptions
}
