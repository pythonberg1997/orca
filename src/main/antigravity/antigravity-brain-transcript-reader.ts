import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../ai-vault/transcripts/session-transcript-record-budget'
import type { AntigravityTranscriptPaths } from './antigravity-brain-transcript-records'

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d
const READ_CHUNK_BYTES = 256 * 1024

export type AntigravityTranscriptCursor = {
  paths: AntigravityTranscriptPaths
  activePath: string | null
  offset: number
  seekToEndOnOpen: boolean
  carryParts: Buffer[]
  carryLength: number
  discardingOversized: boolean
}

export function createAntigravityTranscriptPoller(options: {
  watchPaths: AntigravityTranscriptPaths
  minPollMs: number
  maxPollMs: number
  runTick: () => Promise<{ progressed: boolean; keepRunning: boolean }>
}) {
  const { watchPaths, minPollMs, maxPollMs, runTick } = options
  const logsDir = dirname(watchPaths.full)
  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let delayMs = minPollMs
  let running = false
  let rerun = false
  let disposed = false

  const closeWatch = (): void => {
    if (watcher) {
      watcher.close()
      watcher = null
    }
  }

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const ensureWatch = (): void => {
    if (watcher || disposed) {
      return
    }
    try {
      watcher = watch(logsDir, { persistent: false }, () => kick())
      watcher.on('error', closeWatch)
    } catch {
      // Directory is created lazily by `agy` on the first step.
    }
  }

  const poll = async (): Promise<void> => {
    if (disposed || running) {
      rerun ||= !disposed
      return
    }
    running = true
    try {
      let progressed = false
      let keepRunning = false
      do {
        rerun = false
        const step = await runTick()
        progressed ||= step.progressed
        keepRunning = step.keepRunning
      } while (rerun && !disposed)
      clearTimer()
      if (disposed || !keepRunning) {
        closeWatch()
        return
      }
      ensureWatch()
      delayMs = progressed ? minPollMs : Math.min(maxPollMs, delayMs * 2)
      timer = setTimeout(() => {
        timer = null
        void poll()
      }, delayMs)
      timer.unref?.()
    } finally {
      running = false
    }
  }

  const kick = (): void => {
    if (!disposed) {
      delayMs = minPollMs
      clearTimer()
      void poll()
    }
  }

  return {
    kick,
    dispose: (): void => {
      disposed = true
      clearTimer()
      closeWatch()
    }
  }
}

export function createAntigravityTranscriptCursor(
  paths: AntigravityTranscriptPaths,
  skipExisting = false
): AntigravityTranscriptCursor {
  return {
    paths,
    activePath: null,
    offset: 0,
    seekToEndOnOpen: skipExisting,
    carryParts: [],
    carryLength: 0,
    discardingOversized: false
  }
}

function resetPartialCarry(cursor: AntigravityTranscriptCursor): void {
  cursor.carryParts.length = 0
  cursor.carryLength = 0
  cursor.discardingOversized = false
}

export async function readNewAntigravityTranscriptLines(
  cursor: AntigravityTranscriptCursor
): Promise<string[]> {
  let chosen: string | null = null
  let size = 0
  const candidates = cursor.activePath
    ? [cursor.activePath]
    : [cursor.paths.full, cursor.paths.compact]
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (info?.isFile()) {
      chosen = candidate
      size = info.size
      break
    }
  }
  if (cursor.seekToEndOnOpen) {
    cursor.seekToEndOnOpen = false
    if (chosen) {
      cursor.activePath = chosen
      cursor.offset = size
    }
    return []
  }
  if (!chosen) {
    return []
  }
  if (size < cursor.offset) {
    cursor.offset = 0
    resetPartialCarry(cursor)
  }
  if (size === cursor.offset) {
    return []
  }
  cursor.activePath = chosen
  const handle = await open(chosen, 'r').catch(() => null)
  if (!handle) {
    return []
  }
  try {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - cursor.offset))
    const lines: string[] = []
    while (cursor.offset < size) {
      const toRead = Math.min(buffer.length, size - cursor.offset)
      const { bytesRead } = await handle.read(buffer, 0, toRead, cursor.offset)
      if (bytesRead <= 0) {
        break
      }
      cursor.offset += bytesRead
      const chunk = buffer.subarray(0, bytesRead)
      let lineStart = 0
      let newlineIdx = chunk.indexOf(NEWLINE_BYTE, lineStart)
      while (newlineIdx !== -1) {
        const segment = chunk.subarray(lineStart, newlineIdx)
        const totalLength = cursor.carryLength + segment.length
        if (!cursor.discardingOversized && totalLength <= MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
          const rawLine =
            cursor.carryLength > 0
              ? Buffer.concat([...cursor.carryParts, segment], totalLength)
              : segment
          const trimmedEnd =
            rawLine.at(-1) === CARRIAGE_RETURN_BYTE ? rawLine.length - 1 : rawLine.length
          if (trimmedEnd > 0) {
            lines.push(rawLine.toString('utf8', 0, trimmedEnd))
          }
        }
        resetPartialCarry(cursor)
        lineStart = newlineIdx + 1
        newlineIdx = chunk.indexOf(NEWLINE_BYTE, lineStart)
      }
      if (lineStart < chunk.length && !cursor.discardingOversized) {
        const tail = chunk.subarray(lineStart)
        if (cursor.carryLength + tail.length > MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
          resetPartialCarry(cursor)
          cursor.discardingOversized = true
        } else {
          cursor.carryParts.push(Buffer.from(tail))
          cursor.carryLength += tail.length
        }
      }
    }
    return lines
  } finally {
    await handle.close().catch(() => undefined)
  }
}
