import type { AcpBackgroundTaskUpdate, AcpSubagentUpdate } from '../acp/acp-dialects/acp-dialect'
import { createAntigravityBrainBackgroundTasks } from '../acp/acp-dialects/antigravity-background-tasks'
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
  const parentTasks = createAntigravityBrainBackgroundTasks(now)
  const pendingWakeupCalls: string[] = []
  let activePromptChars = 0
  let activePromptSawTraffic = false
  let latestPromptChars: number | null = input.resumed ? 0 : null
  let seenUserInput = input.resumed
  let cycleRanStep = input.resumed
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

  const isCurrentWakeupOpen = (): boolean =>
    wakeupTurn !== null &&
    (lane.openTurnId === wakeupTurn ||
      lane.openTurnId?.endsWith(`:${encodeURIComponent(wakeupTurn)}`) === true)

  const children = createAntigravityBrainChildren({ brainDir, now, isDisposed: () => disposed })
  const replayFilter = createAntigravityWakeupReplayFilter({
    isWakeupOpen: () => wakeupTurn !== null,
    isIdleWakeupWindow: () =>
      !publishing &&
      !promptOpen &&
      latestPromptChars !== null &&
      (lane.openTurnId === null || isCurrentWakeupOpen()),
    ensureWakeupTurn: () => {
      if (!wakeupTurn) {
        unhandledSystemWake = false
        wakeupTurn = `agy-wakeup:live:${nextSeq++}`
        poller.kick()
      }
      return wakeupTurn
    }
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
    backgroundTasks?: AcpBackgroundTaskUpdate[]
  }): void => {
    applyEvents(lane.translator.notification(ANTIGRAVITY_BRAIN_NOTIFICATION, payload, now()))
  }

  const emitWakeupUpdate = (turn: string, update: Record<string, unknown>): void => {
    const params = { sessionId: providerSessionId, _meta: { antigravityTurn: turn }, update }
    applyEvents(lane.translator.notification('session/update', params, now()))
  }

  const resetWakeup = (): void => {
    wakeupTurn = null
    pendingWakeupCalls.length = 0
  }

  const emitChildUpdates = (
    subagents: AcpSubagentUpdate[],
    backgroundTasks: AcpBackgroundTaskUpdate[],
    turnTag?: string | number
  ): void => {
    const payload = {
      ...(subagents.length > 0 ? { subagents } : {}),
      ...(backgroundTasks.length > 0 ? { backgroundTasks } : {})
    }
    if (turnTag !== undefined) {
      unhandledSystemWake = false
      wakeupTurn = `agy-wakeup:${turnTag}:${nextSeq++}`
      emitBrainTurn({ turn: wakeupTurn, started: true, ...payload })
    } else if (subagents.length > 0 || backgroundTasks.length > 0) {
      emitBrainTurn(payload)
    }
  }

  const closeWakeupTurn = (stopReason: string): void => {
    if (wakeupTurn) {
      const endingTurn = wakeupTurn
      resetWakeup()
      emitBrainTurn({ turn: endingTurn, end: { stopReason } })
    }
  }

  const hasCompletedPromptBudget = (): boolean =>
    !supersededByNewerUserInput &&
    !promptOpen &&
    !lane.openTurnId &&
    seenUserInput &&
    latestPromptChars !== null &&
    transcriptCharsInCycle >= latestPromptChars

  const handlePlannerStep = (
    record: Extract<AntigravityBrainRecord, { kind: 'planner-response' }>
  ): void => {
    cycleRanStep = true
    for (const call of record.toolCalls) {
      if (call.name === 'send_message' && typeof call.args.Recipient === 'string') {
        children.retrackKnown(call.args.Recipient.trim())
      }
    }
    emitChildUpdates([], parentTasks.observePlannerCalls(record.toolCalls))
    if (!wakeupTurn && unhandledSystemWake && hasCompletedPromptBudget()) {
      emitChildUpdates([], [], record.stepIndex ?? 'p')
    }
    const finishingPrompt =
      !unhandledSystemWake &&
      latestPromptChars !== null &&
      transcriptCharsInCycle < latestPromptChars
    if (!wakeupTurn || finishingPrompt) {
      unhandledSystemWake = false
      transcriptCharsInCycle += nonWhitespaceLength(record.content)
      return
    }
    const synthesized = replayFilter.synthesizeWakeupStep(record, wakeupTurn, () => nextSeq++)
    pendingWakeupCalls.push(...synthesized.toolCallIds)
    for (const update of synthesized.updates) {
      emitWakeupUpdate(wakeupTurn, update)
    }
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
    for (const [idx, record] of records.entries()) {
      if (disposed) {
        return false
      }
      supersededByNewerUserInput = idx < lastUserInputIdx
      if (record.kind === 'user-input') {
        closeWakeupTurn('end_turn')
        unhandledSystemWake = false
        seenUserInput = true
        cycleRanStep = false
        transcriptCharsInCycle = 0
      } else if (record.kind === 'checkpoint') {
        // Manual `/compact` writes CHECKPOINT before any planner step; mid-turn auto-compaction does not.
        if (!cycleRanStep) {
          closeWakeupTurn('end_turn')
          unhandledSystemWake = false
          cycleRanStep = true
        }
      } else if (record.kind === 'generic') {
        emitChildUpdates([], parentTasks.observeGeneric(record))
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
        const subagents = children.applySystemMessages(record.messages)
        const backgroundTasks = parentTasks.applySystemMessages(record.messages, input.resumed)
        // Inbox drains before a user turn's first step belong to that turn, not a reactive wakeup.
        const canWake = cycleRanStep && record.messages.some((msg) => msg.wakesAgent)
        if (canWake && hasCompletedPromptBudget() && !wakeupTurn) {
          emitChildUpdates(subagents, backgroundTasks, record.stepIndex ?? 's')
        } else {
          unhandledSystemWake ||= canWake && !wakeupTurn && !supersededByNewerUserInput
          emitChildUpdates(subagents, backgroundTasks)
        }
      } else if (record.kind === 'planner-response') {
        handlePlannerStep(record)
      }
    }
    supersededByNewerUserInput = false
    return lines.length > 0
  }

  const hasOpenWork = (): boolean =>
    parentTasks.hasOpen() || lane.translator.subagents.hasOpen() || children.hasOpen()
  const isIdle = (): boolean => !promptOpen && !lane.openTurnId && !wakeupTurn && !hasOpenWork()

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
      return { progressed: parentMoved || childrenMoved, keepRunning: !isIdle() || graceTicks > 0 }
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
      parentTasks.observeAppliedEvents(events)
      let relevant = false
      for (const event of events) {
        if (event.type === 'turn.open' && isAcpPromptTurnId(event.turn)) {
          promptOpen = true
          activePromptChars = 0
          activePromptSawTraffic = false
          resetWakeup()
          relevant = true
        } else if (event.type === 'turn.end' && (!event.turn || isAcpPromptTurnId(event.turn))) {
          promptOpen = false
          if (
            !event.turn ||
            activePromptSawTraffic ||
            activePromptChars > 0 ||
            (event.state === 'completed' && event.outcome === 'success')
          ) {
            // Compaction ends with an unkeyed turn.end while resetting transcriptCharsInCycle.
            latestPromptChars = event.turn ? activePromptChars : 0
          }
          graceTicks = PROMPT_SETTLE_GRACE_TICKS
          relevant = true
        } else if (promptOpen && !wakeupTurn) {
          activePromptSawTraffic ||= ['item.open', 'item.update', 'text.delta'].includes(event.type)
          if (event.type === 'text.delta' && event.channel === 'assistant' && !event.producer) {
            activePromptChars += nonWhitespaceLength(event.text)
          }
        }
      }
      if (lane.openTurnId !== null && !isCurrentWakeupOpen()) {
        resetWakeup()
      }
      const hasOpen = lane.translator.subagents.hasOpen()
      if (relevant || (!hadOpenSubagents && hasOpen)) {
        poller.kick()
      }
      hadOpenSubagents = hasOpen
    },
    onDisposed: () => {
      disposed = true
      poller.dispose()
      replayFilter.dispose()
      parentTasks.clear()
      children.clear()
      resetWakeup()
    }
  })
}
