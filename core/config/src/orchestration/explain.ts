/**
 * Debug/explain output for resolved targets.
 *
 * WHY: Provides human-readable and machine-readable explanations
 * of resolved targets, including load order, dependencies, and warnings.
 * Also shows composed content: hooks, MCP servers, settings, and components.
 *
 * This module is a thin barrel; the implementation is split across:
 * - `explain/content-readers.ts` — filesystem content readers
 * - `explain/explain.ts` — build/compose/explainTarget/explain logic
 * - `explain/format-text.ts` — text/JSON presentation
 * - `explain/types.ts` — shared display types
 */

export { explain } from './explain/explain.js'
export { formatExplainJson, formatExplainText } from './explain/format-text.js'
export type {
  ComposedContent,
  ExplainOptions,
  ExplainResult,
  HookInfo,
  SpaceComponentInfo,
  SpaceInfo,
  SpaceSettingsInfo,
  TargetExplanation,
} from './explain/types.js'
