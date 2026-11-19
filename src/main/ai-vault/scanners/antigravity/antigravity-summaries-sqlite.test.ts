import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import SyncDatabase from '../../../sqlite/sync-database'
import { handleForeignSqliteReaderRequest } from '../../../foreign-sqlite-readers/foreign-sqlite-reader-dispatch'
import { readAntigravityConversationSummaries } from './antigravity-summaries-sqlite'
import { createAntigravityWorkspaceResolver } from './session-scanner-antigravity-history'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function stubSession(sessionId: string): AiVaultSession {
  return {
    id: `local:antigravity:${sessionId}`,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    agent: 'antigravity',
    sessionId,
    title: 'Git Commit Command',
    cwd: null,
    branch: null,
    model: null,
    filePath: `/home/ada/.gemini/antigravity-cli/brain/${sessionId}/.system_generated/logs/transcript_full.jsonl`,
    codexHome: null,
    createdAt: '2026-11-19T07:56:24.000Z',
    updatedAt: '2026-11-19T07:58:06.000Z',
    modifiedAt: '2026-11-19T07:58:06.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `agy --conversation ${sessionId}`,
    subagent: null
  }
}

it('reads workspace URIs and child subagent ids from conversation_summaries.db and enriches missing JSON cache entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-agy-summaries-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'conversation_summaries.db')
  const db = new SyncDatabase(dbPath)
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      workspace_uris TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      last_modified_time TEXT
    );
  `)
  const insert = db.prepare(
    'INSERT INTO conversation_summaries (conversation_id, workspace_uris, parent_conversation_id, nesting_depth, last_modified_time) VALUES (?, ?, ?, ?, ?)'
  )
  const activeId = 'ddde6a40-4d92-4d9d-9cc9-0202f4fdc08f'
  insert.run(
    activeId,
    '["file:///Users/roshan/Projects/orca"]',
    '',
    0,
    '2026-11-19 07:58:06.923959+00:00'
  )
  insert.run(
    'subagent-1',
    '["file:///Users/roshan/Projects/orca"]',
    activeId,
    1,
    '2026-11-19 07:57:00.000000+00:00'
  )
  db.close()

  expect(
    handleForeignSqliteReaderRequest({
      id: 1,
      kind: 'antigravitySummaries',
      dbPath
    })
  ).toEqual({
    id: 1,
    ok: true,
    value: {
      workspaces: {
        [activeId]: '/Users/roshan/Projects/orca',
        'subagent-1': '/Users/roshan/Projects/orca'
      },
      internalIds: ['subagent-1']
    }
  })

  const historyPath = join(dir, 'history.jsonl')
  const resolver = createAntigravityWorkspaceResolver(
    async () => null,
    async (path) => readAntigravityConversationSummaries(path)
  )
  expect((await resolver.enrich(stubSession(activeId), historyPath))?.cwd).toBe(
    '/Users/roshan/Projects/orca'
  )
  expect(await resolver.enrich(stubSession('subagent-1'), historyPath)).toBeNull()
})
