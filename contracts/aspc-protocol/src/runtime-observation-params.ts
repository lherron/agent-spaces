/**
 * Params validators for the runtime observation and preparation methods. They
 * share one runtime `context` shape ({@link validateRuntimeObservation}); the
 * placement and preparation requests also share the preparation correlation and
 * HRC task-context shapes.
 */
import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import type { ParamsValidator, SchemaRecord } from './validation-primitives.js'
import {
  path,
  ISSUE_CODE,
  issue,
  optionalEnum,
  optionalNumber,
  optionalRecord,
  optionalString,
  rejectUnknownParams,
  requireEnum,
  requireLiteral,
  requireRecord,
  requireString,
  requireStringArray,
  validateOptionalStringRecord,
} from './validation-primitives.js'

function validateRuntimeObservation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[],
  version: string
): SchemaRecord | undefined {
  const request = requireRecord(value, basePath, issues)
  if (!request) return undefined
  requireLiteral(request['schemaVersion'], version, path(basePath, 'schemaVersion'), issues)
  const context = requireRecord(request['context'], path(basePath, 'context'), issues)
  if (context) {
    requireString(context['agentId'], path(basePath, 'context.agentId'), issues)
    optionalString(context['agentRoot'], path(basePath, 'context.agentRoot'), issues)
    requireString(context['cwd'], path(basePath, 'context.cwd'), issues)
    requireEnum(
      context['runMode'],
      ['query', 'heartbeat', 'task', 'maintenance'],
      path(basePath, 'context.runMode'),
      issues
    )
    optionalString(context['taskId'], path(basePath, 'context.taskId'), issues)
    const project = requireRecord(context['project'], path(basePath, 'context.project'), issues)
    if (project) {
      requireEnum(
        project['mode'],
        ['root', 'infer-from-cwd', 'none'],
        path(basePath, 'context.project.mode'),
        issues
      )
      if (project['mode'] === 'root') {
        requireString(project['projectRoot'], path(basePath, 'context.project.projectRoot'), issues)
        optionalString(project['projectId'], path(basePath, 'context.project.projectId'), issues)
        rejectUnknownParams(
          project,
          new Set(['mode', 'projectRoot', 'projectId']),
          path(basePath, 'context.project'),
          issues
        )
      } else {
        rejectUnknownParams(project, new Set(['mode']), path(basePath, 'context.project'), issues)
      }
    }
    const agentSources = optionalRecord(
      context['agentSources'],
      path(basePath, 'context.agentSources'),
      issues
    )
    if (agentSources) {
      optionalString(
        agentSources['aspHome'],
        path(basePath, 'context.agentSources.aspHome'),
        issues
      )
      optionalString(
        agentSources['agentsRoot'],
        path(basePath, 'context.agentSources.agentsRoot'),
        issues
      )
      rejectUnknownParams(
        agentSources,
        new Set(['aspHome', 'agentsRoot']),
        path(basePath, 'context.agentSources'),
        issues
      )
    }
    validateOptionalProvisionDirectives(
      context['provisionDirectives'],
      path(basePath, 'context.provisionDirectives'),
      issues
    )
    rejectUnknownParams(
      context,
      new Set([
        'agentId',
        'agentRoot',
        'project',
        'cwd',
        'runMode',
        'taskId',
        'agentSources',
        'provisionDirectives',
      ]),
      path(basePath, 'context'),
      issues
    )
  }
  return request
}

function validateOptionalProvisionDirectives(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const directives = optionalRecord(value, basePath, issues)
  if (!directives) return
  for (const [key, item] of Object.entries(directives)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      issues.push(
        issue(
          path(basePath, key),
          ISSUE_CODE.invalidType,
          `${path(basePath, key)} must be a string, number, or boolean`
        )
      )
    }
  }
}

export const validateResolveRuntimeDeclarationParams: ParamsValidator = (value, base, issues) => {
  const request = validateRuntimeObservation(
    value,
    base,
    issues,
    'aspc-resolve-runtime-declaration-request/v1'
  )
  if (request) rejectUnknownParams(request, new Set(['schemaVersion', 'context']), base, issues)
}

export const validateInspectRuntimePlacementParams: ParamsValidator = (value, base, issues) => {
  const request = validateRuntimeObservation(
    value,
    base,
    issues,
    'aspc-inspect-runtime-placement-request/v1'
  )
  if (request) {
    validateOptionalStringRecord(request['dispatchEnv'], path(base, 'dispatchEnv'), issues)
    validatePreparationCorrelation(request['preparationCorrelation'], base, issues, false)
    validateTaskContext(
      request['preparationTaskContext'],
      path(base, 'preparationTaskContext'),
      issues
    )
    rejectUnknownParams(
      request,
      new Set([
        'schemaVersion',
        'context',
        'dispatchEnv',
        'preparationCorrelation',
        'preparationTaskContext',
      ]),
      base,
      issues
    )
  }
}

export const validateObserveRuntimeCapabilityParams: ParamsValidator = (value, base, issues) => {
  const request = validateRuntimeObservation(
    value,
    base,
    issues,
    'aspc-observe-runtime-capability-request/v1'
  )
  if (request) {
    requireString(request['harness'], path(base, 'harness'), issues)
    rejectUnknownParams(request, new Set(['schemaVersion', 'context', 'harness']), base, issues)
  }
}

export const validateObserveContinuationArtifactParams: ParamsValidator = (
  value,
  basePath,
  issues
) => {
  const request = requireRecord(value, basePath, issues)
  if (!request) return
  requireLiteral(
    request['schemaVersion'],
    'aspc-observe-continuation-artifact-request/v1',
    path(basePath, 'schemaVersion'),
    issues
  )
  const continuation = requireRecord(
    request['continuation'],
    path(basePath, 'continuation'),
    issues
  )
  if (continuation) {
    requireString(continuation['provider'], path(basePath, 'continuation.provider'), issues)
    requireString(continuation['key'], path(basePath, 'continuation.key'), issues)
    optionalEnum(
      continuation['artifactFormat'],
      ['claude', 'codex', 'pi'],
      path(basePath, 'continuation.artifactFormat'),
      issues
    )
    rejectUnknownParams(
      continuation,
      new Set(['provider', 'key', 'artifactFormat']),
      path(basePath, 'continuation'),
      issues
    )
  }
  const historical = optionalRecord(
    request['historicalExecution'],
    path(basePath, 'historicalExecution'),
    issues
  )
  if (historical) {
    validateFrozenStartRequest(
      historical['frozenStartRequest'],
      path(basePath, 'historicalExecution.frozenStartRequest'),
      issues
    )
    validateRecordedPlacement(
      historical['recordedPlacement'],
      path(basePath, 'historicalExecution.recordedPlacement'),
      issues
    )
    rejectUnknownParams(
      historical,
      new Set(['frozenStartRequest', 'recordedPlacement']),
      path(basePath, 'historicalExecution'),
      issues
    )
  }
  rejectUnknownParams(
    request,
    new Set(['schemaVersion', 'continuation', 'historicalExecution']),
    basePath,
    issues
  )
}

function validateFrozenStartRequest(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const frozen = optionalRecord(value, basePath, issues)
  if (!frozen) return
  requireLiteral(frozen['keyBinding'], 'runtime-continuation', path(basePath, 'keyBinding'), issues)
  requireRecord(frozen['placement'], path(basePath, 'placement'), issues)
  requireRecord(frozen['startRequest'], path(basePath, 'startRequest'), issues)
  optionalEnum(
    frozen['brokerDriver'],
    [
      'codex-app-server',
      'claude-code-tmux',
      'codex-cli-tmux',
      'pi-tui-tmux',
      'pi-sdk',
      'agent-harness',
      'agent-harness-tmux',
    ],
    path(basePath, 'brokerDriver'),
    issues
  )
  for (const field of ['compileId', 'planHash', 'selectedProfileHash', 'startRequestHash']) {
    optionalString(frozen[field], path(basePath, field), issues)
  }
  optionalRecord(frozen['executionRelease'], path(basePath, 'executionRelease'), issues)
}

function validateRecordedPlacement(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const recorded = optionalRecord(value, basePath, issues)
  if (!recorded) return
  requireRecord(recorded['placement'], path(basePath, 'placement'), issues)
  requireRecord(recorded['bundle'], path(basePath, 'bundle'), issues)
  optionalString(recorded['aspHome'], path(basePath, 'aspHome'), issues)
  for (const field of ['compileId', 'planHash', 'selectedProfileHash']) {
    optionalString(recorded[field], path(basePath, field), issues)
  }
}

/** HRC task context (T-09860): typed task prompt facts only. */
function validateTaskContext(value: unknown, base: string, issues: ValidationIssue[]): void {
  const context = optionalRecord(value, base, issues)
  if (!context) return
  requireString(context['taskId'], path(base, 'taskId'), issues)
  if (!Object.hasOwn(context, 'phase')) {
    issues.push(
      issue(path(base, 'phase'), ISSUE_CODE.required, 'phase is required (string or null)')
    )
  } else if (context['phase'] !== null) {
    requireString(context['phase'], path(base, 'phase'), issues)
  }
  requireString(context['role'], path(base, 'role'), issues)
  requireStringArray(context['requiredEvidenceKinds'], path(base, 'requiredEvidenceKinds'), issues)
  requireString(context['hintsText'], path(base, 'hintsText'), issues)
  rejectUnknownParams(
    context,
    new Set(['taskId', 'phase', 'role', 'requiredEvidenceKinds', 'hintsText']),
    base,
    issues
  )
}

function validatePreparationCorrelation(
  value: unknown,
  base: string,
  issues: ValidationIssue[],
  required: boolean
): void {
  if (!required && value === undefined) return
  const correlationPath = path(base, 'preparationCorrelation')
  const correlation = requireRecord(value, correlationPath, issues)
  if (!correlation) return
  for (const key of ['hostSessionId', 'runId', 'runtimeId', 'invocationId', 'initialInputId']) {
    optionalString(correlation[key], path(correlationPath, key), issues)
  }
  optionalNumber(correlation['generation'], path(correlationPath, 'generation'), issues)
  const sessionRefPath = path(correlationPath, 'sessionRef')
  const sessionRef = optionalRecord(correlation['sessionRef'], sessionRefPath, issues)
  if (sessionRef) {
    requireString(sessionRef['scopeRef'], path(sessionRefPath, 'scopeRef'), issues)
    requireString(sessionRef['laneRef'], path(sessionRefPath, 'laneRef'), issues)
    rejectUnknownParams(sessionRef, new Set(['scopeRef', 'laneRef']), sessionRefPath, issues)
  }
  rejectUnknownParams(
    correlation,
    new Set([
      'hostSessionId',
      'runId',
      'runtimeId',
      'invocationId',
      'initialInputId',
      'generation',
      'sessionRef',
    ]),
    correlationPath,
    issues
  )
}

function validatePreparationEnvelope(
  value: unknown,
  base: string,
  issues: ValidationIssue[],
  schemaVersion: string,
  allowed: readonly string[],
  required: readonly string[]
): SchemaRecord | undefined {
  const request = requireRecord(value, base, issues)
  if (!request) return undefined
  requireLiteral(request['schemaVersion'], schemaVersion, path(base, 'schemaVersion'), issues)
  for (const field of required) {
    if (request[field] === undefined)
      issues.push(issue(path(base, field), ISSUE_CODE.required, `${field} is required`))
  }
  rejectUnknownParams(request, new Set(allowed), base, issues)
  return request
}

export const validatePrepareProcessParams: ParamsValidator = (value, base, issues) => {
  const request = validatePreparationEnvelope(
    value,
    base,
    issues,
    'aspc-prepare-process-invocation-request/v1',
    [
      'schemaVersion',
      'context',
      'preparationCorrelation',
      'expected',
      'launch',
      'dispatchEnv',
      'lockedEnv',
      'artifactDir',
      'taskContext',
    ],
    ['context', 'preparationCorrelation', 'expected', 'launch']
  )
  if (!request) return
  validateRuntimeObservation(value, base, issues, 'aspc-prepare-process-invocation-request/v1')
  validatePreparationCorrelation(request['preparationCorrelation'], base, issues, true)
  validateTaskContext(request['taskContext'], path(base, 'taskContext'), issues)
  const expected = requireRecord(request['expected'], path(base, 'expected'), issues)
  if (expected) {
    requireEnum(
      expected['provider'],
      ['anthropic', 'openai'],
      path(base, 'expected.provider'),
      issues
    )
    requireString(expected['frontend'], path(base, 'expected.frontend'), issues)
    rejectUnknownParams(expected, new Set(['provider', 'frontend']), path(base, 'expected'), issues)
  }
  const launch = requireRecord(request['launch'], path(base, 'launch'), issues)
  if (launch) {
    requireEnum(
      launch['interactionMode'],
      ['interactive', 'headless'],
      path(base, 'launch.interactionMode'),
      issues
    )
    requireEnum(launch['ioMode'], ['pty', 'inherit', 'pipes'], path(base, 'launch.ioMode'), issues)
    rejectUnknownParams(
      launch,
      new Set([
        'interactionMode',
        'ioMode',
        'model',
        'modelReasoningEffort',
        'continuation',
        'prompt',
        'omitPriming',
        'attachments',
        'yolo',
      ]),
      path(base, 'launch'),
      issues
    )
  }
}
