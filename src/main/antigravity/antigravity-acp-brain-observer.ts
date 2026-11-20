import { randomUUID } from 'node:crypto'
import type { AcpBackgroundTaskUpdate, AcpSubagentUpdate } from '../acp/acp-dialects/acp-dialect'
import { createAntigravityBrainBackgroundTasks } from '../acp/acp-dialects/antigravity-background-tasks'
import { ANTIGRAVITY_BRAIN_NOTIFICATION } from '../acp/acp-dialects/antigravity-subagents'
import type { AcpStructuredLane } from '../acp/journal/acp-structured-lane'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { createAntigravityWakeupReplayFilter } from './antigravity-acp-wakeup-replay-filter'
import { createAntigravityBrainChildren } from './antigravity-brain-children'
import { createAntigravityBrainTurnTracker } from './antigravity-brain-turn-tracker'
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
  const parentTasks = createAntigravityBrainBackgroundTasks(now, (taskId, settled) =>
    lane.translator.confirmBackgroundTask(taskId, settled)
  )
  const tracker = createAntigravityBrainTurnTracker(input.resumed)
  const pendingWakeupCalls: string[] = []
  let supersededByNewerUserInput = false
  let wakeupTurn: string | null = null
  let graceTicks = 0
  let hadOpenSubagents = false
  let publishing = false
  let disposed = false

  const isAgentTurnOpen = (): boolean => lane.translator.agentTurnCalls() !== null
  const isCurrentWakeupOpen = (): boolean =>
    wakeupTurn !== null &&
    (lane.openTurnId === wakeupTurn ||
      lane.openTurnId?.endsWith(`:${encodeURIComponent(wakeupTurn)}`) === true)

  const children = createAntigravityBrainChildren({ brainDir, now, isDisposed: () => disposed })
  const replayFilter = createAntigravityWakeupReplayFilter({
    isWakeupOpen: () => wakeupTurn !== null,
    isIdleWakeupWindow: () =>
      !publishing &&
      tracker.isIdleWakeupCandidate() &&
      (lane.openTurnId === null || isCurrentWakeupOpen() || isAgentTurnOpen())
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
  }): void =>
    applyEvents(lane.translator.notification(ANTIGRAVITY_BRAIN_NOTIFICATION, payload, now()))

  const emitWakeupUpdate = (turn: string, update: Record<string, unknown>): void =>
    applyEvents(
      lane.translator.notification(
        'session/update',
        { sessionId: providerSessionId, _meta: { antigravityTurn: turn }, update },
        now()
      )
    )

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
      tracker.clearUnhandledWake()
      wakeupTurn = `agy-wakeup:${turnTag}:${randomUUID()}`
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

  const isLiveTurnOpen = (): boolean => wakeupTurn !== null || isAgentTurnOpen()

  const settleLiveTurn = (stopReason: string | null): void => {
    if (!stopReason) {
      return
    }
    if (wakeupTurn) {
      closeWakeupTurn(stopReason)
    } else if (stopReason === 'end_turn') {
      lane.agentTurn.endUnasked()
    } else {
      lane.agentTurn.end(stopReason)
    }
  }

  const handlePlannerStep = (
    record: Extract<AntigravityBrainRecord, { kind: 'planner-response' }>
  ): void => {
    const hadUnhandledWake = tracker.notePlannerStep()
    for (const call of record.toolCalls) {
      if (call.name === 'send_message' && typeof call.args.Recipient === 'string') {
        children.retrackKnown(call.args.Recipient.trim())
      }
    }
    emitChildUpdates([], parentTasks.observePlannerCalls(record.toolCalls))
    const liveActive = replayFilter.isLiveWakeups() || isAgentTurnOpen()
    if (
      !wakeupTurn &&
      !liveActive &&
      hadUnhandledWake &&
      tracker.hasCompletedPromptBudget(supersededByNewerUserInput, lane.openTurnId)
    ) {
      emitChildUpdates([], [], record.stepIndex ?? 'p')
    }
    const finishingPrompt = tracker.isFinishingPrompt()
    if (!finishingPrompt && liveActive) {
      tracker.noteLiveStep(record)
      settleLiveTurn(tracker.takeReadyLiveEnd(isLiveTurnOpen()))
      return
    }
    if (!wakeupTurn || finishingPrompt) {
      tracker.advancePromptChars(record.content)
      return
    }
    const synthesized = replayFilter.synthesizeWakeupStep(record, wakeupTurn)
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
        tracker.beginUserInput()
      } else if (record.kind === 'checkpoint') {
        // Manual `/compact` writes CHECKPOINT before any planner step; mid-turn auto-compaction does not.
        if (tracker.shouldCloseBeforeCheckpoint()) {
          closeWakeupTurn('end_turn')
          tracker.beginCheckpoint()
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
        const canWake = tracker.canSystemWake(record.messages.some((msg) => msg.wakesAgent))
        if (replayFilter.isLiveWakeups() || isAgentTurnOpen()) {
          tracker.clearUnhandledWake()
          emitChildUpdates(subagents, backgroundTasks)
        } else if (
          canWake &&
          tracker.hasCompletedPromptBudget(supersededByNewerUserInput, lane.openTurnId) &&
          !wakeupTurn
        ) {
          emitChildUpdates(subagents, backgroundTasks, record.stepIndex ?? 's')
        } else {
          tracker.armUnhandledWakeIf(canWake && !wakeupTurn && !supersededByNewerUserInput)
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
  const isIdle = (): boolean =>
    !tracker.isPromptOpen() && !lane.openTurnId && !wakeupTurn && !hasOpenWork()

  const poller = createAntigravityTranscriptPoller({
    watchPaths: parentPaths,
    minPollMs: MIN_POLL_MS,
    maxPollMs: MAX_BACKOFF_POLL_MS,
    runTick: async () => {
      const parentMoved = await readParentTranscript()
      const childrenMoved = await children.pollChildren(readParentTranscript, (subagents) =>
        emitBrainTurn({ subagents })
      )
      settleLiveTurn(tracker.pollSilentLiveEnd(parentMoved || childrenMoved, isLiveTurnOpen()))
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
      const { relevant, promptClosed } = tracker.observeApplied(
        events,
        { isWakeupOpen: () => wakeupTurn !== null, isAgentTurnOpen },
        resetWakeup
      )
      if (promptClosed) {
        graceTicks = PROMPT_SETTLE_GRACE_TICKS
      }
      if (lane.openTurnId !== null && !isCurrentWakeupOpen()) {
        resetWakeup()
      }
      settleLiveTurn(tracker.takeReadyLiveEnd(isLiveTurnOpen()))
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
