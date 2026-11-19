import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareLegacyTranscriptImport } from '../native-chat/agent-session-journal/history-import/journal-legacy-import'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { antigravityHostAccountHome } from './antigravity-host-acp'
import { ANTIGRAVITY_TRANSCRIPT_IMPORT } from './antigravity-transcript-import'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createTempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  tempRoots.push(root)
  return root
}

describe('ANTIGRAVITY_TRANSCRIPT_IMPORT and launch session history', () => {
  it('admits and locates full or compact transcripts only when a conversation db exists', async () => {
    const root = await createTempRoot('orca-agy-import-')
    const hostAccount = antigravityHostAccountHome(root)
    const cliStore = ANTIGRAVITY_TRANSCRIPT_IMPORT.conversationStore({
      accountHome: hostAccount,
      launchEnv: {}
    })
    expect(cliStore).toBe(join(root, '.gemini', 'antigravity-cli'))

    const managedAccount = { variable: 'GEMINI_HOME', path: join(root, 'antigravity-chat') }
    const managedStore = ANTIGRAVITY_TRANSCRIPT_IMPORT.conversationStore({
      accountHome: managedAccount,
      launchEnv: {}
    })
    expect(managedStore).toBe(join(root, 'antigravity-chat', 'antigravity-acp'))

    const sessionId = '12345678-1234-4123-8123-1234567890ab'
    const logsDir = join(cliStore!, 'brain', sessionId, '.system_generated', 'logs')
    const compactPath = join(logsDir, 'transcript.jsonl')
    const fullPath = join(logsDir, 'transcript_full.jsonl')
    await mkdir(logsDir, { recursive: true })
    await mkdir(join(cliStore!, 'conversations'), { recursive: true })
    await writeFile(compactPath, '{"step_index":0}\n')

    expect(
      await ANTIGRAVITY_TRANSCRIPT_IMPORT.findTranscript({
        providerSessionId: sessionId,
        store: cliStore!,
        launchEnv: {},
        workspaceCwd: root
      })
    ).toBeNull()
    expect(
      await ANTIGRAVITY_TRANSCRIPT_IMPORT.admitTranscriptPath({
        store: cliStore!,
        transcriptPath: compactPath
      })
    ).toBeNull()

    await writeFile(join(cliStore!, 'conversations', `${sessionId}.db`), '')
    expect(
      await ANTIGRAVITY_TRANSCRIPT_IMPORT.findTranscript({
        providerSessionId: sessionId,
        store: cliStore!,
        launchEnv: {},
        workspaceCwd: root
      })
    ).toBe(compactPath)
    expect(
      await ANTIGRAVITY_TRANSCRIPT_IMPORT.admitTranscriptPath({
        store: cliStore!,
        transcriptPath: compactPath
      })
    ).toBe(compactPath)

    await writeFile(fullPath, '{"step_index":0}\n')
    expect(
      await ANTIGRAVITY_TRANSCRIPT_IMPORT.findTranscript({
        providerSessionId: sessionId,
        store: cliStore!,
        launchEnv: {},
        workspaceCwd: root
      })
    ).toBe(fullPath)
    expect(
      await ANTIGRAVITY_TRANSCRIPT_IMPORT.admitTranscriptPath({
        store: cliStore!,
        transcriptPath: join(root, 'elsewhere', 'transcript_full.jsonl')
      })
    ).toBeNull()
  })

  it('parses agy CLI resume flags cleanly', () => {
    const parse = ANTIGRAVITY_LAUNCH_SPEC.sessionHistory.parseResumeArgs
    expect(parse(['-c'])).toEqual({ target: null })
    expect(parse(['--continue'])).toEqual({ target: null })
    expect(parse(['--conversation', 'abc-123'])).toEqual({ target: 'abc-123' })
    expect(parse(['--conversation=abc-123'])).toEqual({ target: 'abc-123' })
    expect(parse(['acp'])).toBeNull()
    expect(parse(['models'])).toBeNull()
  })

  it('decodes Antigravity transcripts into journal replacement items and enforces source identity', async () => {
    const root = await createTempRoot('orca-agy-decode-')
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const logsDir = join(root, 'brain', sessionId, '.system_generated', 'logs')
    const transcriptPath = join(logsDir, 'transcript_full.jsonl')
    await mkdir(logsDir, { recursive: true })
    const lines = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'CHECKPOINT',
        created_at: '2026-11-15T06:00:00.000Z',
        content: ''
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-15T06:00:01.000Z',
        content: '<USER_REQUEST>Inspect repo status</USER_REQUEST>'
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-15T06:00:02.000Z',
        model: 'gemini-3-pro',
        thinking: 'Let me check two files.',
        content: 'Running checks.',
        tool_calls: [
          { name: 'read_file', args: { Path: '/repo/a.ts' } },
          { name: 'run_command', args: { CommandLine: 'false' } }
        ]
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: '2026-11-15T06:00:03.000Z',
        status: 'DONE',
        content: 'file contents'
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: '2026-11-15T06:00:04.000Z',
        status: 'ERROR',
        content: 'command failed'
      },
      {
        step_index: 5,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-11-15T06:00:05.000Z',
        content: 'internal wakeup'
      }
    ]
    await writeFile(transcriptPath, `${lines.map((row) => JSON.stringify(row)).join('\n')}\n`)

    const prepared = await prepareLegacyTranscriptImport({
      agent: 'antigravity',
      sessionId,
      options: {
        filePath: transcriptPath,
        source: { providerSessionId: sessionId, workspaceCwd: '/repo' }
      }
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      throw new Error(prepared.error)
    }
    expect(prepared.sourceEmpty).toBe(false)
    expect(prepared.items.map((item) => item.body)).toEqual([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Inspect repo status' }] },
      {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: 'Let me check two files.' }]
      },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Running checks.' }] },
      {
        kind: 'tool-call',
        name: 'read_file',
        input: { Path: '/repo/a.ts' },
        callId: 'step:2:call:0',
        state: 'completed'
      },
      {
        kind: 'tool-call',
        name: 'run_command',
        input: { CommandLine: 'false' },
        callId: 'step:2:call:1',
        state: 'completed'
      },
      {
        kind: 'message',
        role: 'tool',
        blocks: [{ type: 'tool-result', output: 'file contents', callId: 'step:2:call:0' }]
      },
      {
        kind: 'message',
        role: 'tool',
        blocks: [
          { type: 'tool-result', output: 'command failed', callId: 'step:2:call:1', isError: true }
        ]
      }
    ])

    const mismatched = await prepareLegacyTranscriptImport({
      agent: 'antigravity',
      sessionId,
      options: {
        filePath: transcriptPath,
        source: { providerSessionId: 'other-session-id', workspaceCwd: '/repo' }
      }
    })
    expect(mismatched.ok).toBe(false)
  })
})
