import { BoundedMap } from '../../shared/collections/bounded-map'
import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type { SessionNotification } from '../acp/generated/acp-protocol.generated'

const MAX_SUPPRESSED_TOOL_CALL_IDS = 512
const LIVE_WAKEUP_UPDATES = new Set<string>([
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan'
])

type AntigravityWakeupStep = {
  stepIndex?: number
  thinking?: string
  content?: string
  toolCalls: readonly { name: string; args: Record<string, unknown> }[]
}

const stripWhitespace = (value: string): string => value.replace(/\s+/g, '')

export const nonWhitespaceLength = (value: string | undefined): number =>
  value ? stripWhitespace(value).length : 0

function sliceAfterNonWhitespace(text: string, nonWsCodeUnits: number): string {
  let remaining = nonWsCodeUnits
  let cut = 0
  for (const ch of text) {
    if (remaining <= 0) {
      break
    }
    if (!/\s/.test(ch)) {
      remaining -= ch.length
    }
    cut += ch.length
  }
  return text.slice(cut).trimStart()
}

type PrefixConsumption =
  | { outcome: 'drop'; nextPending: string }
  | { outcome: 'trimmed'; nextText: string }
  | { outcome: 'mismatch' }

function consumeOwedPrefix(text: string, pending: string): PrefixConsumption {
  const incoming = stripWhitespace(text)
  if (incoming.length === 0) {
    return { outcome: 'drop', nextPending: pending }
  }
  if (pending.startsWith(incoming)) {
    return { outcome: 'drop', nextPending: pending.slice(incoming.length) }
  }
  if (incoming.startsWith(pending)) {
    return { outcome: 'trimmed', nextText: sliceAfterNonWhitespace(text, pending.length) }
  }
  return { outcome: 'mismatch' }
}

/**
 * Host `agy acp` <= 1.5.9 buffers wakeup `session/update` frames while idle and flushes them on the
 * next `session/prompt`; 1.5.12+ streams them live while idle. Coordinates synthesis vs live routing.
 */
export function createAntigravityWakeupReplayFilter(options: {
  isWakeupOpen: () => boolean
  isIdleWakeupWindow: () => boolean
  ensureWakeupTurn: () => string
}) {
  let pendingThoughts = ''
  let owedToolCalls = 0
  let pendingMessages = ''
  let liveWakeups = false
  const suppressedToolCallIds = new BoundedMap<string, true>({
    maxEntries: MAX_SUPPRESSED_TOOL_CALL_IDS
  })

  const clearDebt = (): void => {
    pendingThoughts = ''
    owedToolCalls = 0
    pendingMessages = ''
  }

  const recordWakeupStep = (step: AntigravityWakeupStep): void => {
    if (step.thinking) {
      pendingThoughts += stripWhitespace(step.thinking)
    }
    owedToolCalls += step.toolCalls.length
    if (step.content) {
      pendingMessages += stripWhitespace(step.content)
    }
  }

  const applyReplayDebt = (notification: SessionNotification): SessionNotification | null => {
    const { update } = notification
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      if (pendingThoughts.length === 0) {
        if (!options.isWakeupOpen() && nonWhitespaceLength(update.content.text) > 0) {
          clearDebt()
        }
        return notification
      }
      const consumed = consumeOwedPrefix(update.content.text, pendingThoughts)
      if (consumed.outcome === 'drop') {
        pendingThoughts = consumed.nextPending
        return null
      }
      if (consumed.outcome === 'trimmed') {
        pendingThoughts = ''
        return {
          ...notification,
          update: { ...update, content: { ...update.content, text: consumed.nextText } }
        }
      }
      clearDebt()
      return notification
    }
    if (update.sessionUpdate === 'tool_call') {
      if (suppressedToolCallIds.has(update.toolCallId)) {
        return null
      }
      if (owedToolCalls > 0) {
        owedToolCalls -= 1
        suppressedToolCallIds.set(update.toolCallId, true)
        return null
      }
      return notification
    }
    if (update.sessionUpdate === 'tool_call_update') {
      return suppressedToolCallIds.has(update.toolCallId) ? null : notification
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      if (pendingMessages.length === 0) {
        if (!options.isWakeupOpen() && nonWhitespaceLength(update.content.text) > 0) {
          owedToolCalls = 0
        }
        return notification
      }
      const consumed = consumeOwedPrefix(update.content.text, pendingMessages)
      if (consumed.outcome === 'drop') {
        pendingMessages = consumed.nextPending
        return null
      }
      if (consumed.outcome === 'trimmed') {
        pendingMessages = ''
        return {
          ...notification,
          update: { ...update, content: { ...update.content, text: consumed.nextText } }
        }
      }
      clearDebt()
      return notification
    }
    return notification
  }

  return {
    synthesizeWakeupStep(
      step: AntigravityWakeupStep,
      wakeupTurn: string,
      allocSeq: () => number
    ): { updates: Record<string, unknown>[]; toolCallIds: string[] } {
      if (liveWakeups) {
        return { updates: [], toolCallIds: [] }
      }
      recordWakeupStep(step)
      const updates: Record<string, unknown>[] = []
      const toolCallIds: string[] = []
      if (step.thinking) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: step.thinking }
        })
      }
      for (const call of step.toolCalls) {
        const toolCallId = `agy-wakeup-call:${step.stepIndex ?? wakeupTurn}:${allocSeq()}`
        toolCallIds.push(toolCallId)
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: call.name,
          kind: call.name === 'run_command' ? 'execute' : 'other',
          status: 'in_progress',
          rawInput: call.args
        })
      }
      if (step.content) {
        updates.push({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: step.content }
        })
      }
      return { updates, toolCallIds }
    },

    filterSessionNotification(notification: SessionNotification): SessionNotification | null {
      const meta = isRecord(notification._meta) ? notification._meta : undefined
      if (meta && typeof meta.antigravityTurn === 'string') {
        return notification
      }
      const filtered = applyReplayDebt(notification)
      const isLiveWakeup =
        meta?.isReplay !== true &&
        LIVE_WAKEUP_UPDATES.has(notification.update.sessionUpdate) &&
        options.isIdleWakeupWindow()
      if (!isLiveWakeup) {
        return filtered
      }
      liveWakeups = true
      if (!filtered) {
        return null
      }
      const turn = options.ensureWakeupTurn()
      return { ...filtered, _meta: { ...meta, antigravityTurn: turn } }
    },

    dispose(): void {
      clearDebt()
      suppressedToolCallIds.clear()
      liveWakeups = false
    }
  }
}
