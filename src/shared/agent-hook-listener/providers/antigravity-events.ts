import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readLastUserPromptFromTranscript } from '../transcript-lines'
import { readAntigravityToolCall } from './antigravity-tool-fields'
import { isAntigravityStopStillBusy } from './antigravity-event-rules'
import {
  activeAntigravitySubagents,
  isAntigravityFeedbackTool,
  isAntigravityStepEvent,
  normalizeAntigravityChildSubagentEvent,
  trackAntigravityBackgroundCommand,
  trackAntigravityParentSubagentTools
} from './antigravity-subagent-work'

export { isAntigravityFeedbackTool } from './antigravity-subagent-work'

export function normalizeAntigravityEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const now = Date.now()
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  const currentAgent = state.lastStatusByPaneKey.get(paneKey)?.payload.agentType
  if (currentAgent && currentAgent !== 'antigravity') {
    state.antigravityChildWorkByPaneKey.delete(paneKey)
  }
  const hasUserInput = Boolean(readFirstString(hookPayload, ['lastUserInput']))
  const existingWork = state.antigravityChildWorkByPaneKey.get(paneKey)
  const subagentParent = existingWork?.subagentParent
  if (subagentParent && conversationId && conversationId !== subagentParent) {
    // Subagents run inside the parent agy under their own conversationId and never carry user input.
    if (!hasUserInput) {
      return normalizeAntigravityChildSubagentEvent(
        state,
        existingWork,
        paneKey,
        conversationId,
        eventName,
        hookPayload,
        now
      )
    }
    state.antigravityChildWorkByPaneKey.delete(paneKey)
  }
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  ) {
    // Ignore bookkeeping PostToolUse after Stop so finished rows do not resurrect.
    return null
  }

  const toolCall = readAntigravityToolCall(hookPayload)
  const stepIdx = hookPayload.stepIdx
  const hasToolError = typeof hookPayload.error === 'string' && hookPayload.error.trim().length > 0
  trackAntigravityParentSubagentTools(
    state,
    paneKey,
    eventName,
    conversationId,
    hasUserInput,
    stepIdx,
    toolCall,
    hasToolError,
    now
  )
  trackAntigravityBackgroundCommand(state, paneKey, eventName, conversationId, stepIdx, toolCall)

  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  // agy ends the parent's turn with fullyIdle=false while its helpers run; they hold the pane open.
  const childWork = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (stopStillBusy && childWork) {
    childWork.parentStoppedAt ??= now
  } else if (childWork && isAntigravityStepEvent(eventName)) {
    childWork.parentStoppedAt = undefined
  }
  const heldOpenByHelpers = stopStillBusy && childWork?.subagentParent !== undefined
  // A backgrounded command holds it the same way, as monitoring so silence can still bound it.
  const heldOpenByCommands =
    stopStillBusy && !heldOpenByHelpers && (childWork?.commands?.size ?? 0) > 0
  const stateName =
    eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolCall.toolName)
      ? 'waiting'
      : eventName === 'Stop'
        ? stopStillBusy
          ? 'working'
          : 'done'
        : isAntigravityStepEvent(eventName)
          ? 'working'
          : null

  if (!stateName) {
    return null
  }

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  // Cache prompts per turn instead of rescanning large transcripts per hook.
  const cachedPrompt = resetsTurn ? undefined : state.lastPromptByPaneKey.get(paneKey)
  const effectivePrompt =
    promptText || cachedPrompt || readLastUserPromptFromTranscript(transcriptPath) || ''
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('antigravity', eventName, hookPayload),
    { resetOnNewTurn: resetsTurn }
  )

  const subagents = stateName === 'done' ? undefined : activeAntigravitySubagents(childWork)
  const payload = normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: resetsTurn
    }),
    agentType: 'antigravity',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(subagents ? { subagents } : {}),
    ...(heldOpenByCommands ? { workingMode: 'monitoring' as const } : {}),
    mainAgent:
      heldOpenByHelpers || heldOpenByCommands
        ? { state: 'done', stateStartedAt: childWork?.parentStoppedAt ?? now }
        : undefined
  })
  // Stop between tools can report fullyIdle=false; only an idle Stop is terminal.
  if (eventName === 'Stop' && !stopStillBusy) {
    state.antigravityChildWorkByPaneKey.delete(paneKey)
    if (transcriptPath) {
      state.antigravityCompletedTranscriptByPaneKey.set(paneKey, transcriptPath)
    }
  }
  return payload
}
