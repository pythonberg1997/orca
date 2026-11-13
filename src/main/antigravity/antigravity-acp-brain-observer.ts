import type { AcpSubagentUpdate } from '../acp/acp-dialects/acp-dialect'
import { ANTIGRAVITY_BRAIN_NOTIFICATION } from '../acp/acp-dialects/antigravity-subagents'
import type { AcpStructuredLane } from '../acp/journal/acp-structured-lane'
import { isAcpPromptTurnId } from '../acp/timeline/acp-prompt-turns'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  createAntigravityWakeupReplayFilter,
  nonWhitespaceLength
} from './antigravity-acp-wakeup-replay-filter'
import { createAntigravityBrainChildren } from './antigravity-brain-children'
import {
  antigravityAcpBrainDir,
  antigravityBrainTranscriptPaths,
  parseAntigravityBrainLine,
  type AntigravityBrainRecord
} from './antigravity-brain-transcript-records'
import {
  createAntigravityTranscriptCursor,
  createAntigravityTranscriptPoller,
  readNewAntigravityTranscriptLines
} from './antigravity-brain-transcript-reader'

const MIN_POLL_MS = 250
const MAX_BACKOFF_POLL_MS = 2_500
const PROMPT_SETTLE_GRACE_TICKS = 3

export function observeAntigravityAcpBrainSession(input: {
  env: Readonly<Record<string, string>>
  managed: boolean
  providerSessionId: string
  resumed: boolean
  lane: AcpStructuredLane
  now: () => number
}): void {
  const brainDir = antigravityAcpBrainDir(input.env, input.managed)
  if (!brainDir) {
    return
  }
  const { providerSessionId, lane, now } = input
  const parentPaths = antigravityBrainTranscriptPaths(brainDir, providerSessionId)
  const parentCursor = createAntigravityTranscriptCursor(parentPaths, input.resumed)
  const openParentTasks = new Set<string>()
  const pendingWakeupCalls: string[] = []
  let activePromptChars = 0
  let activePromptSawTraffic = false
  let latestPromptChars: number | null = input.resumed ? 0 : null
  let seenUserInput = input.resumed
  let transcriptCharsInCycle = 0
  let supersededByNewerUserInput = false
  let promptOpen = false
  let unhandledSystemWake = false
  let wakeupTurn: string | null = null
  let nextSeq = 1
  let graceTicks = 0
  let hadOpenSubagents = false
  let publishing = false
  let disposed = false

  const children = createAntigravityBrainChildren({
    brainDir,
    now,
    isDisposed: () => disposed
  })
  const replayFilter = createAntigravityWakeupReplayFilter({
    isWakeupOpen: () => wakeupTurn !== null
  })

  const applyEvents = (events: readonly ProviderTimelineEvent[]): void => {
    if (disposed) {
      return
    }
    publishing = true
    try {
      lane.apply(events)
    } finally {
      publishing = false
    }
  }

  const emitBrainTurn = (payload: {
    turn?: string
    started?: boolean
    end?: { stopReason: string }
    subagents?: AcpSubagentUpdate[]
  }): void => {
    applyEvents(lane.translator.notification(ANTIGRAVITY_BRAIN_NOTIFICATION, payload, now()))
  }

  const emitWakeupUpdate = (turn: string, update: Record<string, unknown>): void => {
    const params = { sessionId: providerSessionId, _meta: { antigravityTurn: turn }, update }
    applyEvents(lane.translator.notification('session/update', params, now()))
  }

  const emitTextChunk = (turn: string, sessionUpdate: string, text: string | undefined): void => {
    if (text) {
      emitWakeupUpdate(turn, { sessionUpdate, content: { type: 'text', text } })
    }
  }

  const closeWakeupTurn = (stopReason: string): void => {
    if (wakeupTurn) {
      const endingTurn = wakeupTurn
      wakeupTurn = null
      pendingWakeupCalls.length = 0
      emitBrainTurn({ turn: endingTurn, end: { stopReason } })
    }
  }

  const hasCompletedPromptBudget = (): boolean =>
    !supersededByNewerUserInput &&
    !promptOpen &&
    seenUserInput &&
    latestPromptChars !== null &&
    transcriptCharsInCycle >= latestPromptChars

  const handlePlannerStep = (
    record: Extract<AntigravityBrainRecord, { kind: 'planner-response' }>
  ): void => {
    for (const call of record.toolCalls) {
      if (call.name === 'send_message' && typeof call.args.Recipient === 'string') {
        children.retrackKnown(call.args.Recipient.trim())
      }
    }
    if (!wakeupTurn && unhandledSystemWake && hasCompletedPromptBudget()) {
      unhandledSystemWake = false
      wakeupTurn = `agy-wakeup:${record.stepIndex ?? 'p'}:${nextSeq++}`
      emitBrainTurn({ turn: wakeupTurn, started: true })
    }
    if (!wakeupTurn) {
      unhandledSystemWake = false
      transcriptCharsInCycle += nonWhitespaceLength(record.content)
      return
    }
    replayFilter.recordWakeupStep(record)
    emitTextChunk(wakeupTurn, 'agent_thought_chunk', record.thinking)
    for (const call of record.toolCalls) {
      const toolCallId = `agy-wakeup-call:${nextSeq++}`
      pendingWakeupCalls.push(toolCallId)
      emitWakeupUpdate(wakeupTurn, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: call.name,
        kind: call.name === 'run_command' ? 'execute' : 'other',
        status: 'in_progress',
        rawInput: call.args
      })
    }
    emitTextChunk(wakeupTurn, 'agent_message_chunk', record.content)
    if (record.status === 'ERROR' || record.status === 'CANCELED') {
      closeWakeupTurn(record.status === 'ERROR' ? 'error' : 'cancelled')
    } else if (record.status === 'DONE' && !record.toolCalls.length && record.content?.trim()) {
      // Empty DONE planner steps trigger an internal `agy` retry rather than ending the wakeup turn.
      closeWakeupTurn('end_turn')
    }
  }

  const readParentTranscript = async (): Promise<boolean> => {
    const lines = await readNewAntigravityTranscriptLines(parentCursor)
    const records = lines.flatMap((line) => parseAntigravityBrainLine(line) ?? [])
    const lastUserInputIdx = records.findLastIndex((record) => record.kind === 'user-input')
    for (let idx = 0; idx < records.length; idx += 1) {
      if (disposed) {
        return false
      }
      const record = records[idx]!
      supersededByNewerUserInput = idx < lastUserInputIdx
      if (record.kind === 'user-input') {
        closeWakeupTurn('end_turn')
        unhandledSystemWake = false
        seenUserInput = true
        transcriptCharsInCycle = 0
      } else if (record.kind === 'generic') {
        if (record.backgroundTaskId) {
          openParentTasks.add(record.backgroundTaskId)
        }
        if (record.spawnedSubagent) {
          const { conversationId, transcriptPaths } = record.spawnedSubagent
          lane.translator.subagents.bindSpawnAlias(conversationId)
          children.track(conversationId, transcriptPaths)
        }
        const toolCallId = wakeupTurn ? pendingWakeupCalls.shift() : undefined
        if (wakeupTurn && toolCallId) {
          emitWakeupUpdate(wakeupTurn, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: record.status === 'ERROR' ? 'failed' : 'completed',
            ...(record.content === undefined ? {} : { rawOutput: record.content })
          })
        }
      } else if (record.kind === 'system-message') {
        const subagentUpdates = children.applySystemMessages(record.messages, openParentTasks)
        if (hasCompletedPromptBudget() && !wakeupTurn) {
          unhandledSystemWake = false
          wakeupTurn = `agy-wakeup:${record.stepIndex ?? 's'}:${nextSeq++}`
          emitBrainTurn({
            turn: wakeupTurn,
            started: true,
            ...(subagentUpdates.length > 0 ? { subagents: subagentUpdates } : {})
          })
        } else {
          if (!wakeupTurn && !supersededByNewerUserInput && record.messages.length > 0) {
            unhandledSystemWake = true
          }
          if (subagentUpdates.length > 0) {
            emitBrainTurn({ subagents: subagentUpdates })
          }
        }
      } else if (record.kind === 'planner-response') {
        handlePlannerStep(record)
      }
    }
    supersededByNewerUserInput = false
    return lines.length > 0
  }

  const isIdle = (): boolean =>
    !promptOpen &&
    !openParentTasks.size &&
    !lane.translator.subagents.hasOpen() &&
    !children.hasOpen() &&
    !wakeupTurn

  const poller = createAntigravityTranscriptPoller({
    watchPaths: parentPaths,
    minPollMs: MIN_POLL_MS,
    maxPollMs: MAX_BACKOFF_POLL_MS,
    runTick: async () => {
      const parentMoved = await readParentTranscript()
      const childrenMoved = await children.pollChildren(readParentTranscript, (subagents) =>
        emitBrainTurn({ subagents })
      )
      hadOpenSubagents = lane.translator.subagents.hasOpen()
      if (isIdle()) {
        graceTicks = Math.max(0, graceTicks - 1)
      }
      return {
        progressed: parentMoved || childrenMoved,
        keepRunning: !isIdle() || graceTicks > 0
      }
    }
  })

  if (input.resumed) {
    poller.kick()
  }

  lane.observe({
    filterSessionNotification: replayFilter.filterSessionNotification,
    onApplied: (events) => {
      if (disposed || publishing) {
        return
      }
      let relevant = false
      for (const event of events) {
        if (event.type === 'turn.open' && isAcpPromptTurnId(event.turn)) {
          promptOpen = true
          activePromptChars = 0
          activePromptSawTraffic = false
          wakeupTurn = null
          pendingWakeupCalls.length = 0
          relevant = true
        } else if (event.type === 'turn.end' && isAcpPromptTurnId(event.turn)) {
          promptOpen = false
          if (
            activePromptSawTraffic ||
            activePromptChars > 0 ||
            (event.state === 'completed' && event.outcome === 'success')
          ) {
            latestPromptChars = activePromptChars
          }
          graceTicks = PROMPT_SETTLE_GRACE_TICKS
          relevant = true
        } else if (promptOpen && !wakeupTurn) {
          if (
            event.type === 'item.open' ||
            event.type === 'item.update' ||
            event.type === 'text.delta'
          ) {
            activePromptSawTraffic = true
          }
          if (event.type === 'text.delta' && event.channel === 'assistant' && !event.producer) {
            activePromptChars += nonWhitespaceLength(event.text)
          }
        }
      }
      const hasOpen = lane.translator.subagents.hasOpen()
      const newlyOpenedSubagent = !hadOpenSubagents && hasOpen
      hadOpenSubagents = hasOpen
      if (relevant || newlyOpenedSubagent) {
        poller.kick()
      }
    },
    onDisposed: () => {
      disposed = true
      poller.dispose()
      replayFilter.dispose()
      openParentTasks.clear()
      children.clear()
      pendingWakeupCalls.length = 0
    }
  })
}
