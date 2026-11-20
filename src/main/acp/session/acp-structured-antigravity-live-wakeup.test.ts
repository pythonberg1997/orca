import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { antigravityBrainTranscriptPaths } from '../../antigravity/antigravity-brain-transcript-records'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
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

function rowText(body: {
  kind: string
  blocks?: readonly { type: string; text?: string }[]
}): string {
  return (body.blocks ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('')
}

it('deduplicates live-streamed reactive wakeup steps across pre-brain and pre-ACP ordering without accruing replay debt', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-live-wakeup-'))
  onTestFinished(() => rm(userHome, { recursive: true, force: true }))
  const childWork: AgentChildWorkEvidence[] = []
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    launch: {
      env: { PATH: '/usr/bin', HOME: userHome, USERPROFILE: userHome }
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
  const { agent } = rig.child()

  // Initial prompt spawns a background subagent (`child-1`) and background task (`task-1`).
  await sendHello(rig, 'initial-turn')
  const prompt1 = await rig.frame('session/prompt', 0)
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_init_cmd',
      title: 'run_command',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'pnpm gate' },
      rawOutput: {
        combinedOutput: `Tool is running as a background task with task id: ${PROVIDER_SESSION}/task-1`,
        exitCode: 0
      }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_sub_1',
      title: 'invoke_subagent',
      kind: 'other',
      status: 'completed',
      rawInput: { TypeName: 'research', Role: 'Verifier', Prompt: 'verify' },
      rawOutput: 'Created the following subagent:\n{\n  "conversationId": "child-1"\n}'
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'run' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${PROVIDER_SESSION}/task-1`
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created the following subagent:\n{\n  "conversationId": "child-1"\n}'
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

  // Wave 1: brain SYSTEM_MESSAGE arrives first and opens the wakeup turn; then agy 1.5.12+ streams
  // live ACP frames across two steps while brain logs also record each completed planner step.
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 4,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T08:00:01Z sender=${PROVIDER_SESSION}/task-1 priority=normal content=Task 1 finished\n</SYSTEM_MESSAGE>`
    }
  ])
  await waitFor(async () => {
    expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
      status: 'working'
    })
  })

  const statusText = '正在完成全部仓库 ratchet 与代码质量检查，稍候为您汇报原因与修复结果。'
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking ratchets' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_live_1',
      title: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'pnpm check' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_live_1',
      status: 'completed',
      rawOutput: {
        combinedOutput: `Tool is running as a background task with task id: ${PROVIDER_SESSION}/task-2`,
        exitCode: 0
      }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Waiting on task-2' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_live_2',
      title: 'read_file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { Path: '/repo/foo.ts' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_live_2',
      status: 'completed'
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: statusText }
    }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Checking ratchets',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm check' } }]
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${PROVIDER_SESSION}/task-2`
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Waiting on task-2',
      content: statusText,
      tool_calls: [{ name: 'read_file', args: { Path: '/repo/foo.ts' } }]
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
      thinking: 'Waiting on task-2',
      content: statusText,
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: statusText
    })
  })

  const wave1Rows = await rig.rig.rows()
  const wave1ToolIds = wave1Rows
    .filter((row) => row.body.kind === 'tool-call')
    .map((row) => (row.body.kind === 'tool-call' ? (row.body.callId ?? '') : ''))
  expect(wave1ToolIds).toContain('call_live_1')
  expect(wave1ToolIds).toContain('call_live_2')
  expect(wave1ToolIds.some((id) => id.startsWith('agy-wakeup-call:'))).toBe(false)
  const wave1AssistantTexts = wave1Rows
    .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant' && !row.agentId)
    .map((row) => (row.body.kind === 'message' ? rowText(row.body) : ''))
  expect(wave1AssistantTexts).toEqual(['WAITING', statusText])
  const wave1ReasoningTexts = wave1Rows
    .filter((row) => row.body.kind === 'message' && row.body.role === 'reasoning' && !row.agentId)
    .map((row) => (row.body.kind === 'message' ? rowText(row.body) : ''))
  expect(wave1ReasoningTexts).toEqual(['Checking ratchets', 'Waiting on task-2'])

  // Wave 2: live ACP session/update arrives BEFORE brain poller sees SYSTEM_MESSAGE.
  // Also verifies a leading tool_call is not dropped by stale replay debt from Wave 1.
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_live_3',
      title: 'read_file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { Path: '/repo/bar.ts' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_live_3',
      status: 'completed'
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Finalizing' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ALL_CHECKS_GREEN' }
    }
  })

  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({ status: 'working' })
    expect(
      rows.some((row) => row.body.kind === 'tool-call' && row.body.callId === 'call_live_3')
    ).toBe(true)
  })

  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 10,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T08:01:00Z sender=child-1 priority=normal content=SUBAGENT_DONE\n[Message] timestamp=2026-11-19T08:01:00Z sender=${PROVIDER_SESSION}/task-2 priority=normal content=Task 2 finished\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 11,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Finalizing',
      content: 'ALL_CHECKS_GREEN',
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'child-1' },
        outcome: 'succeeded'
      })
    )
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'ALL_CHECKS_GREEN'
    })
  })

  const wave2Rows = await rig.rig.rows()
  expect(
    wave2Rows
      .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant' && !row.agentId)
      .map((row) => (row.body.kind === 'message' ? rowText(row.body) : ''))
  ).toEqual(['WAITING', statusText, 'ALL_CHECKS_GREEN'])
  expect(wave2Rows.flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toEqual([
    expect.objectContaining({ state: 'completed', outcome: 'success' }),
    expect.objectContaining({ state: 'completed', outcome: 'success' }),
    expect.objectContaining({ state: 'completed', outcome: 'success' })
  ])

  // Follow-up prompt works cleanly without interference from live wakeups.
  await sendHello(rig, 'follow-up-turn')
  const prompt2 = await rig.frame('session/prompt', 1)
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'FOLLOW_UP_OK' }
    }
  })
  agent.reply(prompt2, { stopReason: 'end_turn' })
  await rig.settle()
  expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
    status: 'idle',
    lastAssistantMessage: 'FOLLOW_UP_OK'
  })
})

it('preserves wakeup replies across session resume and when brain PLANNER_RESPONSE precedes trailing ACP message chunks', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-live-wakeup-resume-'))
  onTestFinished(() => rm(userHome, { recursive: true, force: true }))
  let resume: {
    sessionId: string
    key: string
    mayBeUnsaved: () => Promise<boolean>
    lossKeys: string[]
  } | null = null
  let generation = 0
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    launch: {
      env: {
        PATH: '/usr/bin',
        HOME: userHome,
        USERPROFILE: userHome
      },
      get resume() {
        return resume
      }
    },
    initialize: fixture.initialize,
    deps: {
      mintGeneration: () => `gen-acp-${++generation}`
    },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { ...fixture.session, sessionId: PROVIDER_SESSION })
      )
      agent.on('session/resume', (frame) => agent.reply(frame, { ...fixture.session }))
    }
  })

  await rig.acquire()
  await sendHello(rig, 'gen1-turn')
  const prompt1 = await rig.frame('session/prompt')
  rig.child().agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'GEN1_PROMPT_OK' }
    }
  })
  rig.child().agent.reply(prompt1, { stopReason: 'end_turn' })
  await rig.settle()
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      step_index: 1,
      content: 'hello'
    },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      step_index: 2,
      content: 'GEN1_PROMPT_OK',
      tool_calls: []
    },
    {
      type: 'SYSTEM_MESSAGE',
      source: 'SYSTEM',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T08:00:01Z sender=${PROVIDER_SESSION}/task-1 priority=normal content=Task 1 finished\n</SYSTEM_MESSAGE>`
    },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      content: 'GEN1_WAKEUP',
      tool_calls: []
    }
  ])
  await waitFor(async () => {
    expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'GEN1_WAKEUP'
    })
  })

  await rig.adapter.closeSession(SESSION)
  resume = {
    sessionId: PROVIDER_SESSION,
    key: 'acp:antigravity:saved',
    mayBeUnsaved: async () => false,
    lossKeys: []
  }
  await rig.acquire({ fence: 2 })

  await sendHello(rig, 'gen2-turn', 2)
  const prompt2 = await rig.frame('session/prompt')
  const { agent: agent2 } = rig.child()
  agent2.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'GEN2_PROMPT_OK' }
    }
  })
  agent2.reply(prompt2, { stopReason: 'end_turn' })
  await rig.settle()
  expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
    status: 'idle',
    lastAssistantMessage: 'GEN2_PROMPT_OK'
  })

  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      step_index: 3,
      content: 'hello'
    },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      step_index: 4,
      content: 'GEN2_PROMPT_OK',
      tool_calls: []
    },
    {
      type: 'SYSTEM_MESSAGE',
      source: 'SYSTEM',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T08:02:01Z sender=${PROVIDER_SESSION}/task-2 priority=normal content=Task 2 finished\n</SYSTEM_MESSAGE>`
    },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      content: 'GEN2_SYNTHESIZED_WAKEUP',
      tool_calls: []
    }
  ])
  await waitFor(async () => {
    expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'GEN2_SYNTHESIZED_WAKEUP'
    })
  })

  await sendHello(rig, 'gen2-turn-2', 2)
  const prompt3 = await rig.frame('session/prompt', 1)
  agent2.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'GEN2_PROMPT2_OK' }
    }
  })
  agent2.reply(prompt3, { stopReason: 'end_turn' })
  await rig.settle()

  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      step_index: 5,
      content: 'hello'
    },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      step_index: 6,
      content: 'GEN2_PROMPT2_OK',
      tool_calls: []
    },
    {
      type: 'SYSTEM_MESSAGE',
      step_index: 7,
      source: 'SYSTEM',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T08:03:01Z sender=${PROVIDER_SESSION}/task-3 priority=normal content=Task 3 finished\n</SYSTEM_MESSAGE>`
    }
  ])
  await waitFor(async () => {
    expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
      status: 'working'
    })
  })

  agent2.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking gen2' }
    }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      type: 'PLANNER_RESPONSE',
      step_index: 8,
      source: 'MODEL',
      status: 'DONE',
      thinking: 'Thinking gen2',
      content: 'GEN2_LIVE_WAKEUP_REPLY',
      tool_calls: []
    },
    {
      type: 'SYSTEM_MESSAGE',
      step_index: 9,
      source: 'SYSTEM',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T08:03:02Z sender=${PROVIDER_SESSION}/task-probe priority=low content=Task probe done\n</SYSTEM_MESSAGE>`
    }
  ])
  await waitFor(async () => {
    const currentRows = await rig.rig.rows()
    expect(
      currentRows.some(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some(
            (block) =>
              block.type === 'background-task' &&
              block.taskId === `${PROVIDER_SESSION}/task-probe` &&
              block.state === 'done'
          )
      )
    ).toBe(true)
    expect(projectStructuredAgentSessionStatusSummary(currentRows)).toMatchObject({
      status: 'working'
    })
  })

  agent2.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'GEN2_LIVE_WAKEUP_REPLY' }
    }
  })

  await waitFor(async () => {
    expect(projectStructuredAgentSessionStatusSummary(await rig.rig.rows())).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'GEN2_LIVE_WAKEUP_REPLY'
    })
  })
  const rows = await rig.rig.rows()
  const turns = rows.flatMap((row) => readAgentJournalTurn(row.body) ?? [])
  expect(turns).toHaveLength(6)
  expect(turns.every((turn) => turn.state === 'completed')).toBe(true)
})
