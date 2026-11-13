import { isRecord } from '../../agent-status/child-work/agent-status-child-work-value-guards'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'
import {
  AGENT_SUBAGENT_ID_MAX_LENGTH,
  type AgentSubagentSnapshot
} from '../../agent-status/contracts/agent-status-subagent-snapshot'
import {
  isAntigravityParentSubagentTool,
  matchesAntigravitySwarmKillId,
  parseAntigravitySubagentToolInput
} from '../../antigravity-subagent-tool-inputs'
import { sliceAtCodeUnitLimit } from '../../surrogate-safe-text-slice'
import type { HookListenerState } from '../listener-state'
import { readAntigravityToolCall } from './antigravity-tool-fields'
import { isAntigravityStopStillBusy } from './antigravity-event-rules'

type AntigravityPendingSpawn = {
  key: string
  callKey?: string
}

export type AntigravityPaneChildWork = {
  subagentParent?: string
  parentStoppedAt?: number
  commands?: Set<string>
  pendingSpawns?: AntigravityPendingSpawn[]
  nextPendingSeq?: number
  subagents?: Map<string, AgentSubagentSnapshot>
}

export function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

export function isAntigravityStepEvent(eventName: unknown): boolean {
  return (
    eventName === 'PreInvocation' ||
    eventName === 'PostInvocation' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  )
}

function boundedSubagentId(raw: string): string {
  return sliceAtCodeUnitLimit(raw.trim(), AGENT_SUBAGENT_ID_MAX_LENGTH)
}

export function activeAntigravitySubagents(
  work: AntigravityPaneChildWork | undefined
): AgentSubagentSnapshot[] | undefined {
  return work?.subagents && work.subagents.size > 0 ? [...work.subagents.values()] : undefined
}

function antigravityChildWork(state: HookListenerState, paneKey: string): AntigravityPaneChildWork {
  let work = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!work) {
    work = {}
    state.antigravityChildWorkByPaneKey.set(paneKey, work)
  }
  return work
}

function pendingCallKey(
  toolCall: ReturnType<typeof readAntigravityToolCall>,
  stepIdx: unknown
): string | undefined {
  if (toolCall.toolCallId) {
    return `id:${toolCall.toolCallId}`
  }
  return typeof stepIdx === 'number' ? `step:${stepIdx}` : undefined
}

/** agy sends a backgrounded run_command's PostToolUse only when the command ends; daemons are never expected to. */
export function trackAntigravityBackgroundCommand(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  conversationId: string | undefined,
  stepIdx: unknown,
  toolCall: ReturnType<typeof readAntigravityToolCall>
): void {
  if (
    toolCall.toolName !== 'run_command' ||
    !conversationId ||
    typeof stepIdx !== 'number' ||
    (eventName !== 'PreToolUse' && eventName !== 'PostToolUse')
  ) {
    return
  }
  const key = `${conversationId}:${stepIdx}`
  if (eventName === 'PostToolUse') {
    state.antigravityChildWorkByPaneKey.get(paneKey)?.commands?.delete(key)
    return
  }
  if (isRecord(toolCall.toolInputSource) && toolCall.toolInputSource.IsDaemon === true) {
    return
  }
  const work = antigravityChildWork(state, paneKey)
  work.commands = (work.commands ?? new Set()).add(key)
}

export function trackAntigravityParentSubagentTools(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  conversationId: string | undefined,
  hasUserInput: boolean,
  stepIdx: unknown,
  toolCall: ReturnType<typeof readAntigravityToolCall>,
  hasToolError: boolean,
  now: number
): void {
  if (eventName !== 'PreToolUse' && eventName !== 'PostToolUse') {
    return
  }
  const existingWork = state.antigravityChildWorkByPaneKey.get(paneKey)
  const isParentConversation =
    Boolean(conversationId) &&
    (hasUserInput ||
      (existingWork?.subagentParent !== undefined &&
        existingWork.subagentParent === conversationId))
  if (hasUserInput && conversationId && isAntigravityParentSubagentTool(toolCall.toolName)) {
    antigravityChildWork(state, paneKey).subagentParent = conversationId
  }
  const parsed = parseAntigravitySubagentToolInput(toolCall.toolName, toolCall.toolInputSource)
  if (!parsed) {
    return
  }
  if (parsed.kind === 'invoke_subagent' && eventName === 'PreToolUse' && isParentConversation) {
    const work = antigravityChildWork(state, paneKey)
    const step = typeof stepIdx === 'number' ? stepIdx : now
    const seq = (work.nextPendingSeq ?? 0) + 1
    work.nextPendingSeq = seq
    const key = boundedSubagentId(`pending:${step}:${seq}`)
    const callKey = pendingCallKey(toolCall, stepIdx)
    const description = parsed.role ?? parsed.promptLine
    work.subagents ??= new Map()
    work.subagents.set(key, {
      id: key,
      state: 'working',
      startedAt: now,
      ...(parsed.agentType ? { agentType: parsed.agentType } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(description ? { description } : {})
    })
    work.pendingSpawns ??= []
    work.pendingSpawns.push({ key, ...(callKey ? { callKey } : {}) })
    return
  }
  if (eventName !== 'PostToolUse') {
    return
  }
  if (hasToolError) {
    if (parsed.kind === 'invoke_subagent' && existingWork?.pendingSpawns?.length) {
      const callKey = pendingCallKey(toolCall, stepIdx)
      const idx = callKey
        ? existingWork.pendingSpawns.findIndex((entry) => entry.callKey === callKey)
        : existingWork.pendingSpawns.length - 1
      if (idx !== -1) {
        const [removed] = existingWork.pendingSpawns.splice(idx, 1)
        if (removed) {
          existingWork.subagents?.delete(removed.key)
        }
      }
    }
    return
  }
  if (parsed.kind === 'send_message' && conversationId && parsed.recipient) {
    const id = boundedSubagentId(parsed.recipient)
    if (!id || id === boundedSubagentId(conversationId)) {
      return
    }
    const existing = existingWork?.subagents?.get(id)
    if (!existing && !isParentConversation) {
      return
    }
    const work = antigravityChildWork(state, paneKey)
    if (hasUserInput) {
      work.subagentParent = conversationId
    }
    work.subagents ??= new Map()
    work.subagents.set(
      id,
      existing ? { ...existing, state: 'working' } : { id, state: 'working', startedAt: now }
    )
    return
  }
  if (parsed.kind === 'manage_subagents') {
    if (!existingWork?.subagents) {
      return
    }
    if (parsed.action === 'kill_all') {
      existingWork.subagents.clear()
      delete existingWork.pendingSpawns
      return
    }
    for (const rawId of parsed.conversationIds) {
      existingWork.subagents.delete(boundedSubagentId(rawId))
    }
    return
  }
  if (parsed.kind === 'swarm_add' && isParentConversation) {
    const work = antigravityChildWork(state, paneKey)
    work.subagents ??= new Map()
    for (const { id: rawId, description } of parsed.workers) {
      const id = boundedSubagentId(rawId)
      work.subagents.set(id, { id, state: 'working', startedAt: now, description })
    }
    return
  }
  if (parsed.kind === 'swarm_kill' && existingWork?.subagents) {
    const targetId = boundedSubagentId(parsed.id)
    for (const key of existingWork.subagents.keys()) {
      if (matchesAntigravitySwarmKillId(key, targetId)) {
        existingWork.subagents.delete(key)
      }
    }
  }
}

export function normalizeAntigravityChildSubagentEvent(
  state: HookListenerState,
  work: AntigravityPaneChildWork,
  paneKey: string,
  childConversationId: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  now: number
): ParsedAgentStatusPayload | null {
  const id = boundedSubagentId(childConversationId)
  if (!id) {
    return null
  }
  if (eventName === 'Stop') {
    if (!isAntigravityStopStillBusy(hookPayload)) {
      work.subagents?.delete(id)
    }
  } else if (isAntigravityStepEvent(eventName)) {
    work.subagents ??= new Map()
    const toolName = readAntigravityToolCall(hookPayload).toolName
    const childState =
      eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName) ? 'waiting' : 'working'
    const existing = work.subagents.get(id)
    if (existing) {
      work.subagents.set(id, { ...existing, state: childState })
    } else {
      const pendingSpawn = work.pendingSpawns?.shift()
      const pending = pendingSpawn ? work.subagents.get(pendingSpawn.key) : undefined
      if (pendingSpawn) {
        work.subagents.delete(pendingSpawn.key)
      }
      work.subagents.set(id, {
        ...pending,
        id,
        state: childState,
        startedAt: pending?.startedAt ?? now
      })
    }
  } else {
    return null
  }

  const subagents = activeAntigravitySubagents(work)
  const parentSnapshot =
    work.parentStoppedAt === undefined ? state.lastToolByPaneKey.get(paneKey) : undefined
  const anyWaiting = subagents?.some((subagent) => subagent.state === 'waiting') === true
  return normalizeAgentStatusPayload({
    state: anyWaiting && work.parentStoppedAt !== undefined ? 'waiting' : 'working',
    prompt: state.lastPromptByPaneKey.get(paneKey) ?? '',
    agentType: 'antigravity',
    toolName: parentSnapshot?.toolName,
    toolInput: parentSnapshot?.toolInput,
    interactivePrompt: parentSnapshot?.interactivePrompt,
    lastAssistantMessage: parentSnapshot?.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: parentSnapshot?.lastAssistantMessageIsToolOutput,
    ...(subagents ? { subagents } : {}),
    ...(work.parentStoppedAt !== undefined
      ? { mainAgent: { state: 'done', stateStartedAt: work.parentStoppedAt } }
      : {})
  })
}
