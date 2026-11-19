import type { AcpSubagentUpdate } from '../acp/acp-dialects/acp-dialect'
import {
  antigravityBrainTranscriptPaths,
  parseAntigravityBrainLine,
  type AntigravityBrainRecord,
  type AntigravityTranscriptPaths
} from './antigravity-brain-transcript-records'
import {
  createAntigravityTranscriptCursor,
  readNewAntigravityTranscriptLines,
  type AntigravityTranscriptCursor
} from './antigravity-brain-transcript-reader'

const SILENT_CHILD_SETTLE_MS = 2_000
const CONCURRENT_CHILD_READS = 8

type TrackedChild = {
  conversationId: string
  cursor: AntigravityTranscriptCursor
  openTasks: Set<string>
  idleDoneAt: number | null
  lastContent?: string
}

export function createAntigravityBrainChildren(options: {
  brainDir: string
  now: () => number
  isDisposed: () => boolean
}) {
  const { brainDir, now, isDisposed } = options
  const openChildren = new Map<string, TrackedChild>()
  const knownChildCursors = new Map<string, AntigravityTranscriptCursor>()

  const track = (conversationId: string, transcriptPaths?: AntigravityTranscriptPaths): void => {
    if (openChildren.has(conversationId)) {
      return
    }
    const cursor =
      knownChildCursors.get(conversationId) ??
      createAntigravityTranscriptCursor(
        transcriptPaths ?? antigravityBrainTranscriptPaths(brainDir, conversationId)
      )
    knownChildCursors.set(conversationId, cursor)
    openChildren.set(conversationId, {
      conversationId,
      cursor,
      openTasks: new Set(),
      idleDoneAt: null
    })
  }

  const clear = (): void => {
    openChildren.clear()
    knownChildCursors.clear()
  }

  return {
    track,
    retrackKnown: (conversationId: string): void => {
      if (knownChildCursors.has(conversationId)) {
        track(conversationId)
      }
    },
    hasOpen: (): boolean => openChildren.size > 0,
    clear,
    applySystemMessages: (
      messages: Extract<AntigravityBrainRecord, { kind: 'system-message' }>['messages']
    ): AcpSubagentUpdate[] => {
      const updates: AcpSubagentUpdate[] = []
      for (const msg of messages) {
        if (msg.stopsAllSubagents) {
          clear()
          updates.push({ id: '*', allOpen: true, state: 'stopped' })
        } else if (msg.isTask) {
          continue
        } else {
          openChildren.delete(msg.sender)
          updates.push({
            id: msg.sender,
            state: 'completed',
            knownOnly: true,
            ...(msg.content ? { result: msg.content } : {})
          })
        }
      }
      return updates
    },
    pollChildren: async (
      beforeSilentSettle: () => Promise<boolean>,
      emitUpdates: (updates: AcpSubagentUpdate[]) => void
    ): Promise<boolean> => {
      const snapshot = Array.from(openChildren.values())
      if (snapshot.length === 0 || isDisposed()) {
        return false
      }
      const batches: { child: TrackedChild; lines: string[] }[] = []
      for (let start = 0; start < snapshot.length; start += CONCURRENT_CHILD_READS) {
        if (isDisposed()) {
          return false
        }
        const slice = snapshot.slice(start, start + CONCURRENT_CHILD_READS)
        const readBatch = await Promise.all(
          slice.map(async (child) => ({
            child,
            lines: await readNewAntigravityTranscriptLines(child.cursor)
          }))
        )
        batches.push(...readBatch)
      }

      let progressed = false
      let parentRefreshed = false
      for (const { child, lines } of batches) {
        if (isDisposed() || !openChildren.has(child.conversationId)) {
          continue
        }
        if (lines.length > 0) {
          progressed = true
        }
        let terminalState: 'failed' | 'stopped' | null = null
        for (const line of lines) {
          const record = parseAntigravityBrainLine(line)
          if (!record) {
            continue
          }
          // `generic` ERROR records are recoverable tool errors; only model turn failure ends the child.
          if (record.kind === 'planner-response' && record.status === 'ERROR') {
            terminalState = 'failed'
            break
          }
          if (record.status === 'CANCELED') {
            terminalState = 'stopped'
            break
          }
          if (record.kind === 'generic' && record.backgroundTask) {
            child.openTasks.add(record.backgroundTask.taskId)
            child.idleDoneAt = null
          } else if (record.kind === 'system-message') {
            for (const msg of record.messages) {
              if (msg.isTask) {
                child.openTasks.delete(msg.sender)
              } else {
                child.idleDoneAt = null
              }
            }
          } else if (record.kind === 'planner-response') {
            if (record.content) {
              child.lastContent = record.content
            }
            child.idleDoneAt =
              record.status === 'DONE' &&
              record.toolCalls.length === 0 &&
              child.openTasks.size === 0
                ? (child.idleDoneAt ?? now())
                : null
          }
        }
        if (terminalState) {
          openChildren.delete(child.conversationId)
          emitUpdates([{ id: child.conversationId, state: terminalState, knownOnly: true }])
          progressed = true
          continue
        }
        if (child.idleDoneAt !== null && now() - child.idleDoneAt >= SILENT_CHILD_SETTLE_MS) {
          if (!parentRefreshed) {
            parentRefreshed = true
            await beforeSilentSettle()
          }
          if (openChildren.has(child.conversationId)) {
            openChildren.delete(child.conversationId)
            emitUpdates([
              {
                id: child.conversationId,
                state: 'completed',
                knownOnly: true,
                ...(child.lastContent ? { result: child.lastContent } : {})
              }
            ])
            progressed = true
          }
        }
      }
      return progressed
    }
  }
}
