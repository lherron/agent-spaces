/**
 * turn/start parameter builders (T-08589, campaign P-00522).
 *
 * Broker InvocationInput → MSP TurnInputPart[] (spike 4, schema + live
 * probes against muse 1.3.0): text parts pass through 1:1, local_image parts
 * become image parts (file read + base64, mediaType by extension), file_ref
 * parts become `@path` text mentions — the wire has no file part type and
 * rejects unknown part types with invalidParams. skill parts are reserved on
 * the wire; a broker skill-part submission is a driver-side validation
 * failure, never wire bytes.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { InvocationInput } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'

export interface MuseTextPart {
  type: 'text'
  text: string
}

export interface MuseImagePart {
  type: 'image'
  base64Data: string
  mediaType: string
}

export interface MuseSkillPart {
  type: 'skill'
  selector: string
  arguments?: string | undefined
}

export type MuseInputPart = MuseTextPart | MuseImagePart | MuseSkillPart

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function mediaTypeForImage(path: string): string {
  const mediaType = EXTENSION_MEDIA_TYPES[extname(path).toLowerCase()]
  if (!mediaType) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      `muse-serve cannot encode image with unknown extension: ${path}`
    )
  }
  return mediaType
}

/**
 * Build the ordered MSP content parts for one broker input. Pure except for
 * local_image file reads.
 */
export async function buildMuseInputParts(input: InvocationInput): Promise<MuseInputPart[]> {
  const parts: MuseInputPart[] = []
  for (const part of input.content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'local_image') {
      const data = await readFile(part.path)
      parts.push({
        type: 'image',
        base64Data: data.toString('base64'),
        mediaType: mediaTypeForImage(part.path),
      })
    } else if (part.type === 'file_ref') {
      parts.push({ type: 'text', text: `@${part.path}` })
    } else {
      const unknown = part as { type: string }
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `muse-serve has no TurnInputPart mapping for broker content type: ${unknown.type}`
      )
    }
  }
  if (parts.length === 0) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'muse-serve turn/start requires at least one content part'
    )
  }
  return parts
}

export function extractMuseText(input: InvocationInput): string {
  return input.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Build turn/start params. The broker owns queueing — never pass ifBusy, so
 * every own turn is a fresh turn/start and the ack disposition is authoritative.
 */
export async function buildMuseTurnStartParams(options: {
  commandId: string
  sessionId: string
  input: InvocationInput
  reasoningEffort?: string | undefined
}): Promise<Record<string, unknown>> {
  return {
    commandId: options.commandId,
    sessionId: options.sessionId,
    input: await buildMuseInputParts(options.input),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
  }
}
