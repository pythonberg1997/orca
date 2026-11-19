import { columnExists, tableExists } from '../../../opencode-usage/schema-helpers'
import { asRecord } from '../../parsing/session-record-fields'
import { readOpenCodeDatabase } from '../opencode/sqlite/session-scanner-opencode-sqlite-open'
import {
  antigravitySummaryWorkspaceUriPath,
  type AntigravityConversationSummaries
} from './session-scanner-antigravity-metadata'

// Worker-only: runs SyncDatabase inside the SQLite reader worker; never import on the main thread.
const SUMMARY_TABLE = 'conversation_summaries'
const SUMMARY_ROW_LIMIT = 10_000
const OPTIONAL_COLUMNS = ['workspace_uris', 'parent_conversation_id', 'nesting_depth'] as const

function mergeWorkspace(
  workspaces: Record<string, string | null>,
  id: string,
  path: string | null
): void {
  if (!Object.hasOwn(workspaces, id)) {
    workspaces[id] = path
  } else if (workspaces[id] !== path) {
    workspaces[id] = null
  }
}

/** Read workspace URIs and child/subagent flags from agy's live SQLite summary store. */
export function readAntigravityConversationSummaries(
  dbPath: string
): AntigravityConversationSummaries | null {
  return readOpenCodeDatabase({
    dbPath,
    read: (db) => {
      if (!tableExists(db, SUMMARY_TABLE) || !columnExists(db, SUMMARY_TABLE, 'conversation_id')) {
        return null
      }
      const cols = OPTIONAL_COLUMNS.filter((col) => columnExists(db, SUMMARY_TABLE, col))
      const orderBy = columnExists(db, SUMMARY_TABLE, 'last_modified_time')
        ? ' ORDER BY last_modified_time DESC'
        : ''
      const query = `SELECT conversation_id${cols.map((col) => `, ${col}`).join('')} FROM ${SUMMARY_TABLE}${orderBy} LIMIT ?`
      const workspaces: Record<string, string | null> = {}
      const internalIds = new Set<string>()
      for (const row of db.prepare(query).all(SUMMARY_ROW_LIMIT)) {
        const record = asRecord(row)
        const id = typeof record?.conversation_id === 'string' ? record.conversation_id.trim() : ''
        if (!record || !id || id.length > 512) {
          continue
        }
        const parentId =
          typeof record.parent_conversation_id === 'string'
            ? record.parent_conversation_id.trim()
            : ''
        const depth = typeof record.nesting_depth === 'number' ? record.nesting_depth : 0
        if (parentId || depth > 0) {
          internalIds.add(id)
        }
        if (typeof record.workspace_uris === 'string' && record.workspace_uris.trim()) {
          try {
            const parsed: unknown = JSON.parse(record.workspace_uris)
            const uriPath = antigravitySummaryWorkspaceUriPath(parsed)
            if (uriPath !== undefined) {
              mergeWorkspace(workspaces, id, uriPath)
            }
          } catch {
            mergeWorkspace(workspaces, id, null)
          }
        }
      }
      return { workspaces, internalIds: [...internalIds] }
    }
  })
}
