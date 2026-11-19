import { createReadStream } from 'node:fs'
import { throwIfSignalAborted } from '../../../../shared/concurrency/abort-signal-reason'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { sliceAtCodeUnitLimit } from '../../../../shared/text/surrogate-safe-text-slice'
import { extractString } from '../../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { extractAntigravityUserRequest } from '../../../ai-vault/scanners/antigravity/session-scanner-antigravity-parser'
import { antigravityConversationIdFromTranscriptPath } from '../../../ai-vault/scanners/antigravity/session-scanner-antigravity-paths'
import { decodeTranscriptStream } from '../../transcript-streaming/transcript-stream-lines'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import {
  assertAdoptedSourceIdentity,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import { createNewestItemWindow } from './journal-newest-item-window'
import { replacementItem } from './journal-replacement-items'

const BLOCK_TEXT_LIMIT = 64 * 1024

type AntigravityToolCall = {
  callId: string
  name: string
  input: unknown
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseAntigravityToolCalls(raw: unknown, baseId: string): AntigravityToolCall[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const calls: AntigravityToolCall[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const name = extractString(record?.name)
    if (!record || !name) {
      continue
    }
    calls.push({
      callId: `${baseId}:call:${calls.length}`,
      name,
      input: asRecord(record.args) ?? record.args ?? {}
    })
  }
  return calls
}

function decodeAntigravityRecord(
  record: Record<string, unknown>,
  baseId: string,
  pendingToolCallIds: string[]
): NativeChatMessage[] {
  const source = extractString(record.source)
  const type = extractString(record.type)
  const timestamp = parseTimestampMs(record.created_at)

  if (
    (source === 'USER_EXPLICIT' || source === 'USER') &&
    (type === 'USER_INPUT' || type === 'REQUEST')
  ) {
    pendingToolCallIds.length = 0
    const text = extractAntigravityUserRequest(
      typeof record.content === 'string' ? record.content : ''
    )
    return text
      ? [
          {
            id: baseId,
            role: 'user',
            blocks: [{ type: 'text', text: sliceAtCodeUnitLimit(text, BLOCK_TEXT_LIMIT) }],
            timestamp,
            source: 'transcript'
          }
        ]
      : []
  }

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    pendingToolCallIds.length = 0
    const thinking =
      typeof record.thinking === 'string' && record.thinking.trim()
        ? sliceAtCodeUnitLimit(record.thinking, BLOCK_TEXT_LIMIT)
        : null
    const text =
      typeof record.content === 'string' && record.content.trim()
        ? sliceAtCodeUnitLimit(record.content, BLOCK_TEXT_LIMIT)
        : null
    const model = extractString(record.model) ?? undefined
    const calls = parseAntigravityToolCalls(record.tool_calls, baseId)
    for (const call of calls) {
      pendingToolCallIds.push(call.callId)
    }
    const parts = (thinking ? 1 : 0) + (text ? 1 : 0) + calls.length
    const messages: NativeChatMessage[] = []
    if (thinking) {
      messages.push({
        id: `${baseId}:reasoning`,
        role: 'reasoning',
        blocks: [{ type: 'text', text: thinking }],
        timestamp,
        source: 'transcript'
      })
    }
    if (text) {
      messages.push({
        id: parts > 1 ? `${baseId}:text` : baseId,
        role: 'assistant',
        blocks: [{ type: 'text', text }],
        timestamp,
        source: 'transcript',
        ...(model ? { model } : {})
      })
    }
    for (const call of calls) {
      messages.push({
        id: call.callId,
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: call.name, input: call.input, callId: call.callId }],
        timestamp,
        source: 'transcript',
        ...(model ? { model } : {})
      })
    }
    return messages
  }

  if (source === 'MODEL' && type === 'GENERIC') {
    const callId = pendingToolCallIds.shift()
    const rawOutput =
      typeof record.content === 'string'
        ? record.content
        : typeof record.error === 'string'
          ? record.error
          : ''
    if (!callId && !rawOutput.trim()) {
      return []
    }
    return [
      {
        id: baseId,
        role: 'tool',
        blocks: [
          {
            type: 'tool-result',
            output: sliceAtCodeUnitLimit(rawOutput, BLOCK_TEXT_LIMIT),
            ...(callId ? { callId } : {}),
            ...(record.status === 'ERROR' ? { isError: true } : {})
          }
        ],
        timestamp,
        source: 'transcript'
      }
    ]
  }

  if (source === 'SYSTEM' && type === 'ERROR_MESSAGE') {
    const errorText = extractString(record.content) ?? extractString(record.error)
    return errorText
      ? [
          {
            id: baseId,
            role: 'system',
            blocks: [{ type: 'text', text: sliceAtCodeUnitLimit(errorText, BLOCK_TEXT_LIMIT) }],
            timestamp,
            source: 'transcript'
          }
        ]
      : []
  }

  return []
}

/** An Antigravity conversation's newest history decoded from `transcript_full.jsonl` or `transcript.jsonl`. */
export async function prepareAntigravityImport(
  sessionId: string,
  options: { filePath?: string; source?: AdoptedTranscriptSource; signal?: AbortSignal },
  limits: JournalPayloadLimits,
  retainedBytes: number,
  maxRecordBytes: number
): Promise<
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean }
  | { ok: false; error: string; cause?: unknown }
> {
  if (!options.filePath) {
    return { ok: false, error: `No transcript found for antigravity session ${sessionId}` }
  }
  const filePath = options.filePath
  try {
    throwIfSignalAborted(options.signal)
    if (options.source) {
      await assertAdoptedSourceIdentity(
        options.source,
        { sessionId: antigravityConversationIdFromTranscriptPath(filePath), cwd: null },
        false,
        options.signal,
        'antigravity'
      )
    }

    const retained = createNewestItemWindow(retainedBytes)
    const pendingToolCallIds: string[] = []
    const seenKeys = new Map<string, number>()
    let lineIndex = 0
    let hasConversation = false

    const nextBaseId = (rawKey: string): string => {
      const count = seenKeys.get(rawKey) ?? 0
      seenKeys.set(rawKey, count + 1)
      return count === 0 ? rawKey : `${rawKey}:${count}`
    }

    const { consumedBytes } = await decodeTranscriptStream(
      createReadStream(filePath),
      filePath,
      0,
      (line) => {
        throwIfSignalAborted(options.signal)
        const currentLineIndex = lineIndex++
        const record = parseJsonObject(line)
        if (!record) {
          return null
        }
        const rawKey =
          typeof record.step_index === 'number' &&
          Number.isInteger(record.step_index) &&
          record.step_index >= 0
            ? `step:${record.step_index}`
            : `line:${currentLineIndex}`
        const messages = decodeAntigravityRecord(record, nextBaseId(rawKey), pendingToolCallIds)
        if (messages.length > 0) {
          hasConversation = true
          for (const message of messages) {
            retained.push(
              replacementItem(
                message,
                { provider: 'legacy', agent: 'antigravity', sessionId, recordId: message.id },
                limits
              )
            )
          }
        }
        return null
      },
      true,
      maxRecordBytes
    )
    throwIfSignalAborted(options.signal)
    return {
      ok: true,
      items: retained.items(),
      sourceEmpty: consumedBytes === 0 || !hasConversation
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error
    }
  }
}
