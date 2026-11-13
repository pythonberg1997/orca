import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { antigravityBrainTranscriptPaths } from '../../antigravity/antigravity-brain-transcript-records'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
afterEach(closeProviderTimelineRigs)

async function appendBrainRecords(
  userHome: string,
  conversationId: string,
  records: readonly Record<string, unknown>[]
): Promise<void> {
  const { full } = antigravityBrainTranscriptPaths(
    join(userHome, '.gemini', 'antigravity-cli', 'brain'),
    conversationId
  )
  await mkdir(dirname(full), { recursive: true })
  await appendFile(full, `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
}

async function openBrainRig() {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-brain-'))
  onTestFinished(() => rm(userHome, { recursive: true, force: true }))
  const childWork: AgentChildWorkEvidence[] = []
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    // Host `agy acp` ignores `GEMINI_HOME`; observer must still resolve `<HOME>/.gemini/antigravity-cli/brain`.
    launch: {
      env: {
        PATH: '/usr/bin',
        HOME: userHome,
        USERPROFILE: userHome,
        GEMINI_HOME: join(userHome, 'ignored-custom-gemini')
      }
    },
    initialize: fixture.initialize,
    deps: {
      onChildWorkEvidence: (_sessionId, evidence) => childWork.push(...evidence)
    },
    script: (agent) =>
      agent.on('session/new', (frame) =>
        agent.reply(frame, { ...fixture.session, sessionId: PROVIDER_SESSION })
      )
  })
  await rig.acquire()
  return { userHome, childWork, rig }
}

it('keeps background invoke_subagent work live past prompt end_turn until brain wakeup completes', async () => {
  const { userHome, childWork, rig } = await openBrainRig()
  await sendHello(rig, 'subagent-turn')
  const prompt = await rig.frame('session/prompt')
  const { agent } = rig.child()
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_sub_1',
      title: 'invoke_subagent',
      kind: 'other',
      status: 'in_progress',
      rawInput: {
        TypeName: 'research',
        Role: 'Ping Check',
        Model: 'flash_lite',
        Prompt: 'Reply PONG'
      }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_sub_1',
      status: 'completed'
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'WAITING' }
    }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: 'hello'
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content:
        '10: Created the following subagent:\n11: {\n12:   "conversationId": "line-numbered-file-read"\n13: }'
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Ping Check' } }]
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created the following subagent:\n{\n  "conversationId": "child-uuid-1"\n}'
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'WAITING',
      tool_calls: []
    }
  ])
  // Real `agy acp` ends `session/prompt` immediately while the background subagent is still running.
  agent.reply(prompt, { stopReason: 'end_turn' })
  await rig.settle()
  await waitFor(async () =>
    expect((await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toEqual([
      expect.objectContaining({ state: 'completed', outcome: 'success' })
    ])
  )
  expect(childWork).toContainEqual(
    expect.objectContaining({
      type: 'live',
      child: expect.objectContaining({
        handle: { idKind: 'task_id', id: 'subagent:call_sub_1' },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        description: 'Ping Check'
      })
    })
  )
  expect(childWork.some((edge) => edge.type === 'ended')).toBe(false)

  // Later, the subagent finishes and wakes the parent in brain logs with zero ACP stdout frames.
  // An empty DONE planner step (`step_index: 6`) simulates `agy`'s internal empty-turn retry before tool work.
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 5,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T12:00:05Z sender=child-uuid-1 priority=normal content=PONG_FROM_SUBAGENT\n</SYSTEM_MESSAGE>'
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: []
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo VERIFY' } }]
    }
  ])

  await waitFor(() =>
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'subagent:call_sub_1' },
        outcome: 'succeeded'
      })
    )
  )
  // While the main agent is executing its wakeup turn, ChatUI status immediately flips to `working`
  // without waiting for a new user message.
  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'working',
      toolName: 'execute'
    })
  })

  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 8,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'VERIFY'
    },
    {
      step_index: 9,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'FINAL_SUMMARY',
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'FINAL_SUMMARY'
    })
    expect(rows.map((row) => ({ body: row.body, agentId: row.agentId ?? null }))).toContainEqual({
      agentId: 'subagent:call_sub_1',
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'PONG_FROM_SUBAGENT' }]
      }
    })
    expect(rows.map((row) => ({ body: row.body, agentId: row.agentId ?? null }))).toContainEqual({
      agentId: null,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'FINAL_SUMMARY' }]
      }
    })
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toEqual([
      expect.objectContaining({ state: 'completed', outcome: 'success' }),
      expect.objectContaining({ state: 'completed', outcome: 'success' })
    ])
  })
})

it('resolves child conversationId aliases across child errors and manage_subagents kills', async () => {
  const { userHome, childWork, rig } = await openBrainRig()
  await sendHello(rig, 'spawn-two')
  const prompt1 = await rig.frame('session/prompt', 0)
  const { agent } = rig.child()
  for (const [callId, role] of [
    ['call_sub_a', 'Worker A'],
    ['call_sub_b', 'Worker B']
  ] as const) {
    agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: 'invoke_subagent',
        kind: 'other',
        status: 'in_progress',
        rawInput: { TypeName: 'research', Role: role, Prompt: 'work' }
      }
    })
    agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed' }
    })
  }
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'go' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created the following subagent:\n{\n  "conversationId": "child-uuid-a"\n}'
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created the following subagent:\n{\n  "conversationId": "child-uuid-b"\n}'
    }
  ])
  agent.reply(prompt1, { stopReason: 'end_turn' })
  await rig.settle()

  // Recoverable tool errors (`GENERIC` + `ERROR`) inside a child must not mark the subagent failed.
  await appendBrainRecords(userHome, 'child-uuid-b', [
    {
      step_index: 0,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      content: 'Error: path must be absolute'
    }
  ])
  await appendBrainRecords(userHome, 'child-uuid-a', [
    { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'ERROR', content: 'boom' }
  ])
  await waitFor(() =>
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'subagent:call_sub_a' },
        outcome: 'failed'
      })
    )
  )
  expect(
    childWork.some((edge) => edge.type === 'ended' && edge.handle.id === 'subagent:call_sub_b')
  ).toBe(false)

  await sendHello(rig, 'kill-second')
  const prompt2 = await rig.frame('session/prompt', 1)
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_kill_b',
      title: 'manage_subagents',
      kind: 'other',
      status: 'in_progress',
      rawInput: { Action: 'kill', ConversationIds: ['child-uuid-b'] }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_kill_b',
      status: 'completed'
    }
  })
  agent.reply(prompt2, { stopReason: 'end_turn' })
  await rig.settle()
  await waitFor(() =>
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'subagent:call_sub_b' },
        outcome: 'cancelled'
      })
    )
  )
})

it('syncs main-agent wakeup turns triggered by background run_command tasks after end_turn', async () => {
  const { userHome, rig } = await openBrainRig()
  await sendHello(rig, 'bg-task-turn')
  const prompt = await rig.frame('session/prompt')
  const { agent } = rig.child()
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'RUNNING_GATE' }
    }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'run' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${PROVIDER_SESSION}/task-42`
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'RUNNING_GATE',
      tool_calls: []
    }
  ])
  agent.reply(prompt, { stopReason: 'end_turn' })
  await rig.settle()

  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 3,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T13:01:37Z sender=${PROVIDER_SESSION}/task-42 priority=MESSAGE_PRIORITY_HIGH content=Task finished\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'GATE_ALL_PASSED',
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'GATE_ALL_PASSED'
    })
  })
})

it('replays early brain subagent outcomes on ACP bind, kills numbered swarm shards, and clears in-prompt system wakes', async () => {
  const { userHome, childWork, rig } = await openBrainRig()
  await sendHello(rig, 'early-brain-and-swarm')
  const prompt1 = await rig.frame('session/prompt', 0)
  const { agent } = rig.child()

  // Brain records the spawned child ID and its fatal error BEFORE ACP delivers `tool_call_update(completed)`.
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_early',
      title: 'invoke_subagent',
      kind: 'other',
      status: 'in_progress',
      rawInput: { TypeName: 'research', Role: 'Fast Failer', Prompt: 'check' }
    }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'go' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created the following subagent:\n{\n  "conversationId": "early-child-1"\n}'
    },
    // In-prompt SYSTEM_MESSAGE handled inside the same active prompt must not arm a post-turn wakeup.
    {
      step_index: 2,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] sender=peer priority=normal content=inline-note\n</SYSTEM_MESSAGE>'
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'ACK_INLINE',
      tool_calls: []
    }
  ])
  await appendBrainRecords(userHome, 'early-child-1', [
    { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'ERROR', content: 'crash' }
  ])
  await waitFor(() => expect(childWork).toEqual([]))

  // Now ACP completes `invoke_subagent` and also spawns + kills a numbered `swarm` worker group.
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_early', status: 'completed' }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_swarm_add',
      title: 'swarm',
      kind: 'other',
      status: 'completed',
      rawInput: { action: 'add', name: 'rev', n: 2, brief: 'review' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_swarm_kill',
      title: 'swarm',
      kind: 'other',
      status: 'completed',
      rawInput: { action: 'kill', name: 'rev' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ACK_INLINE' }
    }
  })
  agent.reply(prompt1, { stopReason: 'end_turn' })
  await rig.settle()

  await waitFor(() => {
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'subagent:call_early' },
        outcome: 'failed'
      })
    )
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'swarm:rev-1' },
        outcome: 'cancelled'
      })
    )
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'swarm:rev-2' },
        outcome: 'cancelled'
      })
    )
  })

  // A post-turn PLANNER_RESPONSE without a new post-turn SYSTEM_MESSAGE must be ignored (no leaked wake).
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'ACK_INLINE',
      tool_calls: []
    }
  ])
  const rowsAfterTurn = await rig.rig.rows()
  expect(
    rowsAfterTurn.filter(
      (row) => row.body.kind === 'message' && row.body.role === 'assistant' && !row.agentId
    )
  ).toHaveLength(1)
})

it('suppresses queued wakeup session/update bursts flushed by agy acp at the start of the next prompt', async () => {
  const { userHome, rig } = await openBrainRig()
  await sendHello(rig, 'simplify-turn')
  const prompt1 = await rig.frame('session/prompt', 0)
  const { agent } = rig.child()

  for (const [callId, role] of [
    ['call_rev_1', 'Reuse Reviewer'],
    ['call_rev_2', 'Efficiency Reviewer']
  ] as const) {
    agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: 'invoke_subagent',
        kind: 'other',
        status: 'in_progress',
        rawInput: { TypeName: 'research', Role: role, Prompt: 'review' }
      }
    })
    agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed' }
    })
  }
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '/simplify'
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created the following subagent:\n{\n  "conversationId": "rev-uuid-1"\n}'
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created the following subagent:\n{\n  "conversationId": "rev-uuid-2"\n}'
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'WAITING',
      tool_calls: []
    }
  ])
  agent.reply(prompt1, { stopReason: 'end_turn' })
  await rig.settle()

  // Multi-wave wakeup: Wave 1 emits an intermediate status; Wave 2 runs a tool and emits the English report.
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 4,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T06:00:01Z sender=rev-uuid-1 priority=normal content=LGTM_1\n</SYSTEM_MESSAGE>'
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Checking wave 1',
      content: 'Reviewer 1 completed (1/2).',
      tool_calls: []
    },
    {
      step_index: 6,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T06:00:05Z sender=rev-uuid-2 priority=normal content=LGTM_2\n</SYSTEM_MESSAGE>'
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Applying fixes',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'go test ./...' } }]
    },
    {
      step_index: 8,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'ok'
    },
    {
      step_index: 9,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '### Applied\n\n- Fixed wakeup deadline check.',
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: '### Applied - Fixed wakeup deadline check.'
    })
  })

  // User sends follow-up prompt ("请用中文总结"); `agy acp` flushes all buffered wakeup frames first.
  await sendHello(rig, 'chinese-summary-turn')
  const prompt2 = await rig.frame('session/prompt', 1)
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking wave 1' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Reviewer 1 completed (1/2).' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Applying fixes' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_replayed_go_test',
      title: 'go test ./...',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'go test ./...' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_replayed_go_test',
      status: 'completed',
      rawOutput: { combinedOutput: 'ok', exitCode: 0 }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '### Applied\n\n- Fixed wakeup deadline check.' }
    }
  })

  // Now `agy acp` streams the actual response for Prompt 2, plus a new background task to verify
  // prompt char budgets were not inflated by the suppressed replay.
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Translating summary to Chinese' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '### 已应用\n\n' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '- 修复了唤醒后的截止时间检查。' }
    }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 10,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '请用中文总结'
    },
    {
      step_index: 11,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${PROVIDER_SESSION}/task-99`
    },
    {
      step_index: 12,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Translating summary to Chinese',
      content: '### 已应用\n\n- 修复了唤醒后的截止时间检查。',
      tool_calls: []
    }
  ])
  agent.reply(prompt2, { stopReason: 'end_turn' })
  await rig.settle()

  const rowsAfterChinese = await rig.rig.rows()
  const assistantMessages = rowsAfterChinese
    .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant' && !row.agentId)
    .map((row) =>
      row.body.kind === 'message'
        ? row.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
        : ''
    )
  expect(assistantMessages).toEqual([
    'WAITING',
    'Reviewer 1 completed (1/2).',
    '### Applied\n\n- Fixed wakeup deadline check.',
    '### 已应用\n\n- 修复了唤醒后的截止时间检查。'
  ])
  expect(
    rowsAfterChinese.some(
      (row) => row.body.kind === 'tool-call' && row.body.callId === 'call_replayed_go_test'
    )
  ).toBe(false)

  // Subsequent wakeup after Prompt 2 must still trigger cleanly (`latestPromptChars` was not inflated).
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 13,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T06:01:00Z sender=${PROVIDER_SESSION}/task-99 priority=normal content=Done\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 14,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'POST_CHINESE_WAKEUP_OK',
      tool_calls: []
    }
  ])
  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'POST_CHINESE_WAKEUP_OK'
    })
  })

  // If a runtime skips wakeup replay and streams fresh output directly, nothing is dropped.
  await sendHello(rig, 'no-replay-turn')
  const prompt3 = await rig.frame('session/prompt', 2)
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'DIRECT_REPLY_WITHOUT_REPLAY' }
    }
  })
  agent.reply(prompt3, { stopReason: 'end_turn' })
  await rig.settle()
  expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
    status: 'idle',
    lastAssistantMessage: 'DIRECT_REPLY_WITHOUT_REPLAY'
  })
})
