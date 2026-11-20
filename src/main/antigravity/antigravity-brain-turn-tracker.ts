import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { isAcpPromptTurnId } from '../acp/timeline/acp-prompt-turns'
import { nonWhitespaceLength } from './antigravity-acp-wakeup-replay-filter'

type PendingLiveEnd = { stopReason: string; expectedChars: number }

const LIVE_END_SILENCE_TICKS = 6

/** Tracks ACP prompt/agent-turn text budgets vs Antigravity brain transcript progress. */
export function createAntigravityBrainTurnTracker(resumed: boolean) {
  let activePromptChars = 0
  let activePromptSawTraffic = false
  let activeLiveStepChars = 0
  let pendingLiveEnd: PendingLiveEnd | null = null
  let idleLiveEndTicks = 0
  let latestPromptChars: number | null = resumed ? 0 : null
  let seenUserInput = resumed
  let cycleRanStep = resumed
  let transcriptCharsInCycle = 0
  let promptOpen = false
  let unhandledSystemWake = false

  const takeLiveEnd = (liveTurnOpen: boolean, force = false): string | null => {
    if (
      !pendingLiveEnd ||
      !liveTurnOpen ||
      (!force &&
        pendingLiveEnd.stopReason === 'end_turn' &&
        activeLiveStepChars < pendingLiveEnd.expectedChars)
    ) {
      return null
    }
    const { stopReason } = pendingLiveEnd
    pendingLiveEnd = null
    idleLiveEndTicks = 0
    return stopReason
  }

  return {
    isPromptOpen: (): boolean => promptOpen,
    hasCompletedPromptBudget: (superseded: boolean, openTurnId: string | null): boolean =>
      !superseded &&
      !promptOpen &&
      !openTurnId &&
      seenUserInput &&
      latestPromptChars !== null &&
      transcriptCharsInCycle >= latestPromptChars,
    isIdleWakeupCandidate: (): boolean => !promptOpen && latestPromptChars !== null,
    isFinishingPrompt: (): boolean =>
      !unhandledSystemWake &&
      latestPromptChars !== null &&
      transcriptCharsInCycle < latestPromptChars,
    shouldCloseBeforeCheckpoint: (): boolean => !cycleRanStep,

    beginUserInput(): void {
      unhandledSystemWake = false
      pendingLiveEnd = null
      idleLiveEndTicks = 0
      activeLiveStepChars = 0
      seenUserInput = true
      cycleRanStep = false
      transcriptCharsInCycle = 0
    },

    beginCheckpoint(): void {
      unhandledSystemWake = false
      pendingLiveEnd = null
      idleLiveEndTicks = 0
      activeLiveStepChars = 0
      cycleRanStep = true
    },

    notePlannerStep(): boolean {
      cycleRanStep = true
      return unhandledSystemWake
    },

    advancePromptChars(content: string | undefined): void {
      unhandledSystemWake = false
      transcriptCharsInCycle += nonWhitespaceLength(content)
    },

    canSystemWake(wakesAgent: boolean): boolean {
      return cycleRanStep && wakesAgent
    },

    clearUnhandledWake(): void {
      unhandledSystemWake = false
    },

    armUnhandledWakeIf(condition: boolean): void {
      unhandledSystemWake ||= condition
    },

    noteLiveStep(record: {
      status?: string | undefined
      toolCalls: readonly unknown[]
      content?: string | undefined
    }): void {
      unhandledSystemWake = false
      if (record.status === 'ERROR' || record.status === 'CANCELED') {
        pendingLiveEnd = {
          stopReason: record.status === 'ERROR' ? 'error' : 'cancelled',
          expectedChars: 0
        }
        idleLiveEndTicks = 0
      } else if (record.status === 'DONE' && !record.toolCalls.length && record.content?.trim()) {
        pendingLiveEnd = {
          stopReason: 'end_turn',
          expectedChars: nonWhitespaceLength(record.content)
        }
        idleLiveEndTicks = 0
      }
    },

    takeReadyLiveEnd: (liveTurnOpen: boolean): string | null => takeLiveEnd(liveTurnOpen),

    pollSilentLiveEnd(progressed: boolean, liveTurnOpen: boolean): string | null {
      if (progressed || !pendingLiveEnd) {
        idleLiveEndTicks = 0
        return null
      }
      idleLiveEndTicks += 1
      if (idleLiveEndTicks < LIVE_END_SILENCE_TICKS) {
        return null
      }
      idleLiveEndTicks = 0
      return takeLiveEnd(liveTurnOpen, true)
    },

    observeApplied(
      events: readonly ProviderTimelineEvent[],
      options: { isWakeupOpen: () => boolean; isAgentTurnOpen: () => boolean },
      onPromptOpen: () => void
    ): { relevant: boolean; promptClosed: boolean } {
      if (events.length > 0) {
        idleLiveEndTicks = 0
      }
      let relevant = false
      let promptClosed = false
      for (const event of events) {
        if (event.type === 'turn.open') {
          activeLiveStepChars = 0
          if (isAcpPromptTurnId(event.turn)) {
            promptOpen = true
            activePromptChars = 0
            activePromptSawTraffic = false
            pendingLiveEnd = null
            onPromptOpen()
          }
          relevant = true
        } else if (event.type === 'turn.end') {
          if (!event.turn || isAcpPromptTurnId(event.turn)) {
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
            promptClosed = true
          } else {
            activeLiveStepChars = 0
            pendingLiveEnd = null
          }
          relevant = true
        } else if (
          event.type === 'text.delta' &&
          event.channel === 'assistant' &&
          !event.producer
        ) {
          if (promptOpen && !options.isWakeupOpen()) {
            activePromptSawTraffic = true
            activePromptChars += nonWhitespaceLength(event.text)
          } else if (options.isWakeupOpen() || options.isAgentTurnOpen()) {
            activeLiveStepChars += nonWhitespaceLength(event.text)
          }
        } else if (promptOpen && !options.isWakeupOpen()) {
          activePromptSawTraffic ||= event.type === 'item.open' || event.type === 'item.update'
        } else if (
          (options.isWakeupOpen() || options.isAgentTurnOpen()) &&
          event.type === 'item.open' &&
          event.body.kind === 'tool-call'
        ) {
          activeLiveStepChars = 0
        }
      }
      return { relevant, promptClosed }
    }
  }
}
