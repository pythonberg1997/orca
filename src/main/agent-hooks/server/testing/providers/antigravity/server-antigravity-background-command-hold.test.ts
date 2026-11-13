import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from '../../../program-status/hook-precedence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-background-command-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const turn = { conversationId: 'parent', lastUserInput: 'start the job' }

async function agyHook(hookEventName: string, payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ ...turn, ...payload }, { hookEventName }),
    '/hook/antigravity'
  )
  expect(response.status).toBe(204)
}

function programDone(): void {
  // agy's OSC 7501 says done at every turn end, including one that waits on a background command.
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'done', agentType: 'antigravity' }
  })
}

const state = () => server.getStatusSnapshot()[0]?.state

it('keeps a turn waiting on a background command working past the hook-silence fallback, then bounds it', async () => {
  const command = {
    stepIdx: 2,
    toolCall: { name: 'run_command', args: { CommandLine: 'sleep 600', IsDaemon: false } }
  }
  await agyHook('PreInvocation', {})
  await agyHook('PreToolUse', command)
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // agy reports this done once; only the hook-silence recheck can offer it again.
  programDone()

  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(state()).toBe('working')

  vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS)
  expect(state()).toBe('done')
})

it('publishes live subagents across parent Stop and ignores screen-rule done until the final idle Stop', async () => {
  const rootTranscript = join(dir, 'root.jsonl')
  const childTranscript = join(dir, 'child.jsonl')
  writeFileSync(
    rootTranscript,
    `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start the job' })}\n`
  )
  writeFileSync(
    childTranscript,
    `${JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'sender=parent' })}\n`
  )

  await agyHook('PreInvocation', { transcriptPath: rootTranscript })
  // A failed invoke_subagent must remove its pending placeholder instead of stranding child work.
  await agyHook('PreToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 0,
    toolCall: {
      id: 'call-fail',
      name: 'invoke_subagent',
      args: { TypeName: 'unknown', Role: 'Broken Agent', Prompt: 'fail' }
    }
  })
  await agyHook('PostToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 0,
    toolCall: { id: 'call-fail', name: 'invoke_subagent', args: {} },
    error: 'Unknown TypeName: unknown'
  })
  await agyHook('PreToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 1,
    toolCall: {
      id: 'call-ok',
      name: 'invoke_subagent',
      args: {
        TypeName: 'research',
        Role: 'Codebase Researcher',
        Model: 'flash_lite',
        Prompt: 'Inspect files'
      }
    }
  })
  await agyHook('PostToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 1,
    toolCall: { id: 'call-ok', name: 'invoke_subagent', args: {} }
  })
  // Numbered swarm shards (`n: 2`) killed by base name (`name: 'rev'`) must retire all shards.
  await agyHook('PreToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 2,
    toolCall: { id: 'swarm-add', name: 'swarm', args: { action: 'add', name: 'rev', n: 2 } }
  })
  await agyHook('PostToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 2,
    toolCall: { id: 'swarm-add', name: 'swarm', args: {} }
  })
  await agyHook('PreToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 3,
    toolCall: { id: 'swarm-kill', name: 'swarm', args: { action: 'kill', name: 'rev' } }
  })
  await agyHook('PostToolUse', {
    transcriptPath: rootTranscript,
    stepIdx: 3,
    toolCall: { id: 'swarm-kill', name: 'swarm', args: {} }
  })
  await agyHook('Stop', {
    transcriptPath: rootTranscript,
    fullyIdle: false,
    terminationReason: 'NO_TOOL_CALL'
  })

  // Child subagent starts in-process under its own conversationId with no user input.
  const childResponse = await postHookEvent(
    server,
    buildBody(
      {
        conversationId: 'child-1',
        transcriptPath: childTranscript,
        lastUserInput: ''
      },
      { hookEventName: 'PreInvocation' }
    ),
    '/hook/antigravity'
  )
  expect(childResponse.status).toBe(204)

  // Child calling `send_message` back to `parent` must never invert `subagentParent` or list `parent` as a child.
  await postHookEvent(
    server,
    buildBody(
      {
        conversationId: 'child-1',
        transcriptPath: childTranscript,
        lastUserInput: '',
        stepIdx: 1,
        toolCall: {
          id: 'child-msg',
          name: 'send_message',
          args: { Recipient: 'parent', Message: 'done' }
        }
      },
      { hookEventName: 'PreToolUse' }
    ),
    '/hook/antigravity'
  )

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // Non-OSC screen rule (`composer_ready`) reports idle while the parent TUI awaits reactive wakeup.
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    payload: { prompt: '', state: 'done', agentType: 'antigravity' }
  })
  // Live subagents hold open indefinitely (unlike background commands bounded to AGENT_STATUS_STALE_AFTER_MS).
  vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1_000)

  expect(server.getStatusSnapshot()[0]).toMatchObject({
    state: 'working',
    mainAgent: { state: 'done' },
    providerSession: { id: 'parent' },
    subagents: [
      {
        id: 'child-1',
        agentType: 'research',
        model: 'flash_lite',
        description: 'Codebase Researcher',
        state: 'working'
      }
    ]
  })

  // Child subagent finishes -> subagent row retires while parent wakes to finish the turn.
  await postHookEvent(
    server,
    buildBody(
      {
        conversationId: 'child-1',
        transcriptPath: childTranscript,
        lastUserInput: '',
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL'
      },
      { hookEventName: 'Stop' }
    ),
    '/hook/antigravity'
  )
  expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
  expect(state()).toBe('working')

  await agyHook('PreInvocation', { transcriptPath: rootTranscript })
  await agyHook('Stop', {
    transcriptPath: rootTranscript,
    fullyIdle: true,
    terminationReason: 'NO_TOOL_CALL'
  })
  expect(state()).toBe('done')
})
