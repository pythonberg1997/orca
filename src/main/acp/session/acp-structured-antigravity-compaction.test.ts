import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { antigravityBrainTranscriptPaths } from '../../antigravity/antigravity-brain-transcript-records'
import { antigravityHostAccountHome } from '../../antigravity/antigravity-host-acp'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
afterEach(closeProviderTimelineRigs)

it('compacts host agy chats while narrowing managed accounts out and classifying fallback or error replies', async () => {
  const hostSpec = ANTIGRAVITY.hostBackend!.spec
  const rig = await openAcpAdapterRig({ spec: hostSpec })
  const registry = new StructuredAgentRegistry([
    { definition: acpStructuredAgentDefinition(ANTIGRAVITY), adapter: rig.adapter }
  ])
  expect(registry.capabilities('antigravity')).toMatchObject({
    compact: true,
    compactInstructions: false
  })
  expect(
    registry.capabilities('antigravity', antigravityHostAccountHome('/Users/dev'))
  ).toMatchObject({
    compact: true,
    compactInstructions: false
  })
  expect(
    registry.capabilities('antigravity', {
      variable: 'GEMINI_HOME',
      path: '/managed/antigravity-chat'
    })
  ).toMatchObject({
    compact: false,
    compactInstructions: false
  })

  await rig.acquire()
  const { agent } = rig.child()
  const runCompact = async (clientMessageId: string, promptIndex: number, replyText?: string) => {
    const turn = structuredAgentSessionCommandTurn(clientMessageId)
    const running = agentJournalTurnBody({
      turnId: turn.turnId,
      state: 'running',
      startedAt: 4_000
    })
    await rig.rig.journal.appendItem(turn.identity, running, {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    const command = { clientMessageId, ...turn, running }
    expect(await rig.adapter.compact({ sessionId: SESSION, fence: 1, command })).toEqual({
      state: 'accepted',
      providerIdentity: null
    })
    const prompt = await rig.frame('session/prompt', promptIndex)
    expect(prompt.params).toEqual({
      sessionId: PROVIDER_SESSION,
      prompt: [{ type: 'text', text: '/compact' }]
    })
    if (replyText !== undefined) {
      agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: replyText }
        }
      })
    }
    agent.reply(prompt, { stopReason: 'end_turn' })
    return waitFor(async () => {
      const rows = await rig.rig.rows()
      const settled = readAgentJournalTurn(
        rows.find((row) => row.itemId === agentJournalItemKey(turn.identity))?.body
      )
      expect(settled?.state).not.toBe('running')
      const inside = rows
        .filter(
          (row) =>
            row.turnScope?.kind === 'turn' &&
            row.turnScope.turnItemId === agentJournalItemKey(turn.identity)
        )
        .map((row) => row.body)
      return { settled, inside, rows }
    })
  }

  const compacted = await runCompact('compact-ok', 0)
  expect(compacted.settled).toMatchObject({ state: 'completed', outcome: 'success' })
  expect(compacted.inside).toEqual([
    {
      kind: 'status',
      text: 'Context compacted',
      presentation: 'compaction'
    }
  ])

  const skipped = await runCompact('compact-empty', 1, 'I am ready whenever you want to begin.')
  expect(skipped.settled).toMatchObject({ state: 'completed', outcome: 'success' })
  expect(skipped.inside).toEqual([
    {
      kind: 'status',
      tone: 'warning',
      text: 'Nothing to compact',
      presentation: 'compaction-skipped'
    }
  ])
  expect(
    skipped.rows.some((row) => row.body.kind === 'message' && row.body.role === 'assistant')
  ).toBe(false)

  const failed = await runCompact('compact-err', 2, '\n\ncontext summarization: deadline exceeded')
  expect(failed.settled).toMatchObject({ state: 'completed', outcome: 'failure' })
  expect(failed.inside).toEqual([
    expect.objectContaining({
      kind: 'status',
      tone: 'error',
      failure: {
        kind: 'compactionFailed',
        detail: { text: 'context summarization: deadline exceeded', audience: 'person' }
      }
    })
  ])
})

it('settles /compact with in-turn system notices to idle while preserving post-compact reactive wakeups', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-compact-brain-'))
  onTestFinished(() => rm(userHome, { recursive: true, force: true }))
  const appendBrainRecords = async (records: readonly Record<string, unknown>[]) => {
    const { full } = antigravityBrainTranscriptPaths(
      join(userHome, '.gemini', 'antigravity-cli', 'brain'),
      PROVIDER_SESSION
    )
    await mkdir(dirname(full), { recursive: true })
    await appendFile(full, `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  }
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

  await sendHello(rig, 'pre-compact-turn')
  const prompt1 = await rig.frame('session/prompt', 0)
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_sub_1',
      title: 'invoke_subagent',
      kind: 'other',
      status: 'in_progress',
      rawInput: { TypeName: 'research', Role: 'Helper', Prompt: 'work' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_sub_1', status: 'completed' }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'INITIAL_REPLY_WITH_PROMPT_BUDGET' }
    }
  })
  await appendBrainRecords([
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
      content: 'Created the following subagent:\n{\n  "conversationId": "child-before-compact"\n}'
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'INITIAL_REPLY_WITH_PROMPT_BUDGET',
      tool_calls: []
    }
  ])
  agent.reply(prompt1, { stopReason: 'end_turn' })
  await rig.settle()

  const compactTurn = structuredAgentSessionCommandTurn('compact-1')
  const running = agentJournalTurnBody({
    turnId: compactTurn.turnId,
    state: 'running',
    startedAt: 5_000
  })
  await rig.rig.journal.appendItem(compactTurn.identity, running, {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  await rig.adapter.compact({
    sessionId: SESSION,
    fence: 1,
    command: { clientMessageId: 'compact-1', ...compactTurn, running }
  })
  const compactPrompt = await rig.frame('session/prompt', 1)
  // Real `agy` drains pending server-restart / inbox SYSTEM_MESSAGE steps into the `/compact`
  // cycle and ends the turn at `CHECKPOINT` with no `PLANNER_RESPONSE`.
  await appendBrainRecords([
    {
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>\n/compact\n</USER_REQUEST>'
    },
    {
      step_index: 4,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content:
        '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T14:31:49Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n[Message] timestamp=2026-11-15T14:31:49Z sender=peer priority=normal content=Drained inline before checkpoint\n</SYSTEM_MESSAGE>'
    },
    {
      step_index: 5,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      content: '# Resuming from a compaction\nSummary'
    }
  ])
  agent.reply(compactPrompt, { stopReason: 'end_turn' })
  await rig.settle()
  // Subagent stop proves brain polling processed steps 3..5; no phantom wakeup turn may open.
  await waitFor(() =>
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: { idKind: 'task_id', id: 'subagent:call_sub_1' },
        outcome: 'cancelled'
      })
    )
  )
  const afterCompactRows = await rig.rig.rows()
  expect(projectStructuredAgentSessionStatusSummary(afterCompactRows)).toMatchObject({
    status: 'idle',
    lastAssistantMessage: 'INITIAL_REPLY_WITH_PROMPT_BUDGET'
  })
  expect(afterCompactRows.flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toEqual([
    expect.objectContaining({ state: 'completed', outcome: 'success' }),
    expect.objectContaining({
      turnId: compactTurn.turnId,
      state: 'completed',
      outcome: 'success'
    })
  ])

  // Genuine post-compact reactive wakeup still opens a wakeup turn and settles back to idle.
  await appendBrainRecords([
    {
      step_index: 6,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T14:33:00Z sender=${PROVIDER_SESSION}/task-1 priority=normal content=Timer fired\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'POST_COMPACT_WAKEUP',
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(projectStructuredAgentSessionStatusSummary(rows)).toMatchObject({
      status: 'idle',
      lastAssistantMessage: 'POST_COMPACT_WAKEUP'
    })
  })
})
