/**
 * The MSP schema surface the muse-serve driver actually uses (T-09879).
 *
 * This is the single declaration of what the driver sends and reads on the
 * wire. It covers the methods it calls, the notifications it maps and the
 * server requests it answers. schema-compat.ts checks the installed muse's
 * schema export against it at startup. Changes that break this surface refuse
 * startup, and any other drift only warns. Keep it in step with driver.ts,
 * input.ts, permissions.ts and event-map.ts. event-map derives its mapped
 * notification set from `notifications` below, and the schema-compat tests
 * hold the real param builders to the declared sends.
 *
 * Paths are dotted from the message root, and `[]` steps into array items.
 * Declare only fields the schema defines. The driver also reads a few
 * defensive fallbacks the schema lacks: item/delta `turnId`, usage/changed
 * `usage`, and toolCall `toolName`/`name`/`toolCallId`/`input`/`output`. The
 * approval receipt carries `presented`, which is not a RequestReceipt
 * property. None of these is declared, because the gate can only hold the
 * driver to fields the schema publishes.
 */

/** The fingerprint of the newest export verified against the driver by hand. */
export const MSP_LAST_VERIFIED_SCHEMA_FINGERPRINT =
  'sha256:e0e163db6ccf00dbe68402ce55d6319b3edc33c421f31e9583b587b2de8a118f'

/** The muse release whose export carries MSP_LAST_VERIFIED_SCHEMA_FINGERPRINT. */
export const MSP_LAST_VERIFIED_MUSE_VERSION = '1.4.1-R4503.1'

export type MuseWireType = 'string' | 'boolean' | 'integer' | 'number' | 'object' | 'array'

/** One direction of one wire message. */
export interface MuseWireShape {
  /** Field path → the JSON type the driver writes or expects. */
  readonly fields: Readonly<Record<string, MuseWireType>>
  /** Field path → enum values the driver sends or branches on. */
  readonly enumValues?: Readonly<Record<string, readonly string[]>>
}

export interface MuseDriverSchemaSurface {
  /** Client→server requests: the driver sends params and reads the result. */
  readonly methods: Readonly<
    Record<string, { readonly sends: MuseWireShape; readonly reads: MuseWireShape }>
  >
  /** Client→server notifications the driver sends. */
  readonly clientNotifications: readonly string[]
  /** Server→client notifications the driver maps: it reads their params. */
  readonly notifications: Readonly<Record<string, MuseWireShape>>
  /** Server→client requests the driver answers: reads params, sends the result. */
  readonly serverRequests: Readonly<
    Record<string, { readonly reads: MuseWireShape; readonly sends: MuseWireShape }>
  >
}

const NONE: MuseWireShape = { fields: {} }

/** turn/start and turn/steer input parts built by input.ts. */
const INPUT_PART_FIELDS = {
  input: 'array',
  'input[]': 'object',
  'input[].type': 'string',
  'input[].text': 'string',
  'input[].base64Data': 'string',
  'input[].mediaType': 'string',
} as const
const INPUT_PART_ENUMS = { 'input[].type': ['text', 'image'] } as const

/** Turn-item fields event-map reads on item/started|updated|completed. */
const ITEM_READS: MuseWireShape = {
  fields: {
    item: 'object',
    'item.kind': 'string',
    'item.status': 'string',
    'item.turnId': 'string',
    'item.itemId': 'string',
    'item.text': 'string',
    'item.callId': 'string',
    'item.tool': 'string',
    'item.args': 'string',
    'item.visibleOutput': 'string',
    'item.failureReason': 'string',
  },
  enumValues: {
    'item.kind': ['userMessage', 'agentMessage', 'toolCall', 'reasoning'],
    'item.status': ['inProgress', 'completed'],
  },
}

const SESSION_READS: MuseWireShape = {
  fields: { session: 'object', 'session.sessionId': 'string' },
}

const TURN_ID_READS: MuseWireShape = { fields: { turnId: 'string' } }

export const MUSE_DRIVER_SCHEMA_SURFACE: MuseDriverSchemaSurface = {
  methods: {
    initialize: {
      sends: {
        fields: {
          clientInfo: 'object',
          'clientInfo.name': 'string',
          'clientInfo.version': 'string',
        },
      },
      reads: { fields: { schema: 'object', 'schema.fingerprint': 'string' } },
    },
    'session/start': {
      sends: {
        fields: {
          commandId: 'string',
          workspaceRoot: 'string',
          approvalMode: 'string',
          modelId: 'string',
          config: 'object',
          'config.mcpServers': 'object',
        },
      },
      reads: SESSION_READS,
    },
    'session/resume': {
      sends: { fields: { commandId: 'string', sessionId: 'string' } },
      reads: SESSION_READS,
    },
    'turn/start': {
      sends: {
        fields: {
          commandId: 'string',
          sessionId: 'string',
          reasoningEffort: 'string',
          ...INPUT_PART_FIELDS,
        },
        enumValues: INPUT_PART_ENUMS,
      },
      reads: TURN_ID_READS,
    },
    'turn/steer': {
      sends: {
        fields: {
          commandId: 'string',
          sessionId: 'string',
          expectedTurnId: 'string',
          ...INPUT_PART_FIELDS,
        },
        enumValues: INPUT_PART_ENUMS,
      },
      reads: TURN_ID_READS,
    },
    'turn/interrupt': {
      sends: {
        fields: {
          commandId: 'string',
          sessionId: 'string',
          turnId: 'string',
          retract: 'boolean',
        },
      },
      reads: NONE,
    },
    'approval/decide': {
      sends: {
        fields: {
          approvalId: 'string',
          choiceId: 'string',
          commandId: 'string',
          sessionId: 'string',
          requirementId: 'object',
        },
      },
      reads: NONE,
    },
  },
  clientNotifications: ['initialized'],
  notifications: {
    'turn/started': { fields: { turnId: 'string', sessionId: 'string' } },
    'turn/completed': {
      fields: {
        turnId: 'string',
        terminal: 'string',
        reason: 'string',
        usage: 'object',
        error: 'object',
        'error.message': 'string',
        'error.kind': 'string',
        'error.retryable': 'boolean',
      },
      enumValues: { terminal: ['completed', 'cancelled'] },
    },
    'turn/retracted': TURN_ID_READS,
    'item/started': ITEM_READS,
    'item/updated': ITEM_READS,
    'item/completed': ITEM_READS,
    'item/delta': { fields: { itemId: 'string', delta: 'string', field: 'string' } },
    'session/tokenUsage': { fields: { usage: 'object' } },
    'usage/changed': NONE,
    'session/contextUsage': NONE,
    'view/gap': NONE,
  },
  serverRequests: {
    'approval/request': {
      reads: {
        fields: {
          approvalId: 'string',
          sessionId: 'string',
          currentRequirementId: 'object',
          availableChoices: 'array',
          'availableChoices[]': 'object',
          'availableChoices[].choiceId': 'string',
          'availableChoices[].decision': 'string',
          toolName: 'string',
          turnId: 'string',
          rawArgs: 'string',
          subject: 'object',
        },
        enumValues: { 'availableChoices[].decision': ['approved', 'denied'] },
      },
      sends: NONE,
    },
    'userInput/request': { reads: NONE, sends: NONE },
  },
}
