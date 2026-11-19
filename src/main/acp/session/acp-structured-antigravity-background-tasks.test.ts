import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
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

function backgroundTaskRows(
  rows: Awaited<ReturnType<Awaited<ReturnType<typeof openAcpAdapterRig>>['rig']['rows']>>
) {
  return rows.flatMap((row) =>
    row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
  )
}

it('surfaces background shell tasks from brain logs and manage_task across live, blocked, done, and killed states', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-bg-shell-'))
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

  const task1Id = `${PROVIDER_SESSION}/task-1`
  const task1LogPath = join(userHome, 'tasks', 'task-1.log')
  const task1LogUri = pathToFileURL(task1LogPath).href
  const task1Cmd = 'export PATH="/usr/bin"\npnpm check:changed'

  // Case 1: Real agy 1.5.12 starts a background shell command where ACP tool_call_update has no
  // background metadata, and brain logs record PLANNER_RESPONSE(toolSummary) + GENERIC(RUNNING).
  await sendHello(rig, 'bg-shell-turn')
  const prompt1 = await rig.frame('session/prompt', 0)
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_bg_1',
      title: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: task1Cmd }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_bg_1',
      status: 'failed'
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RUNNING' } }
  })
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'run' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: task1Cmd, toolSummary: 'Run repo ratchets' } }
      ]
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      content: [
        'Created At: 2026-11-19T17:10:00+08:00',
        `Tool is running as a background task with task id: ${task1Id}`,
        `Task Description: ${task1Cmd}`,
        `Task logs are available at: ${task1LogUri}`
      ].join('\n')
    },
    // Case 2: Non-RUNNING GENERIC (e.g. read_file inspecting logs containing the marker) must NOT emit a task.
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Tool is running as a background task with task id: fake-task-999'
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'RUNNING',
      tool_calls: []
    }
  ])
  agent.reply(prompt1, { stopReason: 'end_turn' })
  await rig.settle()

  await waitFor(async () => {
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: {
          handle: { idKind: 'task_id', id: `acp-task:${task1Id}` },
          kind: 'command',
          residency: 'background',
          state: 'working',
          description: 'Run repo ratchets',
          stoppable: false
        }
      })
    )
    const tasks = backgroundTaskRows(await rig.rig.rows())
    expect(tasks).toContainEqual(
      expect.objectContaining({
        taskId: task1Id,
        kind: 'command',
        label: 'Run repo ratchets',
        state: 'working',
        parentToolUseId: 'call_bg_1',
        outputFile: task1LogPath
      })
    )
  })
  expect(
    childWork.some((edge) => 'handle' in edge && edge.handle.id === 'acp-task:fake-task-999')
  ).toBe(false)
  expect(
    backgroundTaskRows(await rig.rig.rows()).some((task) => task.taskId === 'fake-task-999')
  ).toBe(false)

  // Case 3a: task-1 exits with code 0 -> removed in childWork and durable block updated to `done`.
  // Case 3b: task-2 starts with `export PATH="/bin"\npnpm lint` (no toolSummary) -> label `pnpm lint`.
  const task2Id = `${PROVIDER_SESSION}/task-2`
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 5,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T09:11:00Z sender=${task1Id} priority=MESSAGE_PRIORITY_HIGH content=Task id "${task1Id}" finished with result:\nCommand exited with code 0.\n\nLog: ${task1LogUri}\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'export PATH="/bin"\npnpm lint' } }]
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${task2Id}\nTask Description: export PATH="/bin"\npnpm lint`
    },
    {
      step_index: 8,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'NEXT_TASK',
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'removed',
        handle: { idKind: 'task_id', id: `acp-task:${task1Id}` }
      })
    )
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: `acp-task:${task2Id}` },
          kind: 'command',
          state: 'working',
          description: 'pnpm lint'
        })
      })
    )
    const tasks = backgroundTaskRows(await rig.rig.rows())
    expect(tasks).toContainEqual(expect.objectContaining({ taskId: task1Id, state: 'done' }))
    expect(tasks).toContainEqual(
      expect.objectContaining({ taskId: task2Id, label: 'pnpm lint', state: 'working' })
    )
  })

  // Case 3c: task-2 fails with exit code 1 -> removed in childWork and durable block updated to `blocked`.
  // Case 4: task-3 starts and is killed via manage_task(Action: 'kill') -> settled as `idle`.
  const task3Id = `${PROVIDER_SESSION}/task-3`
  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 9,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T09:12:00Z sender=${task2Id} priority=MESSAGE_PRIORITY_HIGH content=Task id "${task2Id}" finished with result:\nCommand exited with code 1.\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 10,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'pnpm dev', toolSummary: 'Dev server' } }
      ]
    },
    {
      step_index: 11,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${task3Id}`
    }
  ])

  await waitFor(() => {
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'removed',
        handle: { idKind: 'task_id', id: `acp-task:${task2Id}` }
      })
    )
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: `acp-task:${task3Id}` },
          description: 'Dev server',
          state: 'working'
        })
      })
    )
  })

  await appendBrainRecords(userHome, PROVIDER_SESSION, [
    {
      step_index: 12,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: [{ name: 'manage_task', args: { Action: 'kill', TaskId: task3Id } }]
    },
    {
      step_index: 13,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: `Task "${task3Id}" cancelled.`
    },
    {
      step_index: 14,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'ALL_HANDLED',
      tool_calls: []
    }
  ])

  await waitFor(async () => {
    expect(childWork).toContainEqual(
      expect.objectContaining({
        type: 'removed',
        handle: { idKind: 'task_id', id: `acp-task:${task3Id}` }
      })
    )
    const tasks = backgroundTaskRows(await rig.rig.rows())
    expect(tasks).toContainEqual(
      expect.objectContaining({
        taskId: task2Id,
        state: 'blocked',
        error: 'Command exited with code 1'
      })
    )
    expect(tasks).toContainEqual(expect.objectContaining({ taskId: task3Id, state: 'idle' }))
  })
})
