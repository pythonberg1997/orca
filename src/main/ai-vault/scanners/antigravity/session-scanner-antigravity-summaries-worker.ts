import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { ForeignSqliteReaderLane } from '../../../foreign-sqlite-readers/foreign-sqlite-reader-client'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import { asRecord } from '../../parsing/session-record-fields'
import { throwIfAiVaultScanCancelled } from '../../scan-lifecycle/ai-vault-scan-cancellation'
import type { AntigravityConversationSummaries } from './session-scanner-antigravity-metadata'

const WORKER_ENTRY_FILENAME = 'foreign-sqlite-reader-entry.js'

type SummariesEnvelope = {
  summaries: AntigravityConversationSummaries | null
}

let sharedLane: { entryPath: string; lane: ForeignSqliteReaderLane<SummariesEnvelope> } | null =
  null

function parseSummariesValue(value: unknown): AntigravityConversationSummaries | null {
  const record = asRecord(value)
  const rawWorkspaces = asRecord(record?.workspaces)
  if (!record || !rawWorkspaces || !Array.isArray(record.internalIds)) {
    return null
  }
  const workspaces: Record<string, string | null> = {}
  for (const [id, path] of Object.entries(rawWorkspaces)) {
    if (typeof path === 'string' || path === null) {
      workspaces[id] = path
    }
  }
  return {
    workspaces,
    internalIds: record.internalIds.filter((id): id is string => typeof id === 'string')
  }
}

function parseSummariesEnvelope(value: unknown): SummariesEnvelope | null {
  if (value === null) {
    return { summaries: null }
  }
  const parsed = parseSummariesValue(value)
  return parsed ? { summaries: parsed } : null
}

async function getSummariesReaderLane(): Promise<ForeignSqliteReaderLane<SummariesEnvelope> | null> {
  const layout = currentWorkerEntryLayout(__dirname)
  const candidates =
    layout.isPackaged && layout.resourcesPath
      ? [resolveWorkerThreadEntryPath(layout, WORKER_ENTRY_FILENAME)]
      : [
          join(layout.moduleDir, WORKER_ENTRY_FILENAME),
          join(layout.moduleDir, '..', WORKER_ENTRY_FILENAME)
        ]
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isFile()) {
      if (sharedLane?.entryPath !== candidate) {
        sharedLane?.lane.dispose()
        sharedLane = {
          entryPath: candidate,
          lane: new ForeignSqliteReaderLane(
            'antigravitySummaries',
            parseSummariesEnvelope,
            () => ({ summaries: null }),
            {
              workerFactory: () =>
                spawnWorkerThread(candidate, { name: 'orca-foreign-sqlite-reader' }),
              log: () => {},
              timeoutMs: 10_000,
              idleTeardownMs: 30_000
            }
          )
        }
      }
      return sharedLane.lane
    }
  }
  return null
}

/** Read live Antigravity summaries in the worker-only foreign SQLite reader without sync fs or helper baselines. */
export async function readLocalAntigravitySummaries(
  dbPath: string,
  signal?: AbortSignal
): Promise<AntigravityConversationSummaries | null> {
  try {
    throwIfAiVaultScanCancelled(signal)
    if (isWslUncPath(dbPath)) {
      return null
    }
    if (!(await stat(dbPath).catch(() => null))?.isFile()) {
      return null
    }
    const lane = await getSummariesReaderLane()
    if (!lane) {
      return null
    }
    const result = await lane.read(dbPath, (id) => ({ id, kind: 'antigravitySummaries', dbPath }))
    throwIfAiVaultScanCancelled(signal)
    return result.summaries
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    return null
  }
}
