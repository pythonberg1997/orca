import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import { isSettledBackgroundTaskState } from '../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import {
  parseAntigravityBackgroundTaskStart,
  summarizeCommandDescription
} from '../../antigravity/antigravity-brain-background-task-records'
import type { AntigravityBrainRecord } from '../../antigravity/antigravity-brain-transcript-records'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpBackgroundTaskUpdate } from './acp-dialect'

const RECENT_EXECUTE_LIMIT = 32

export const brainBackgroundTaskSchema = z.object({
  taskId: z.string().trim().min(1),
  kind: z.enum(['command', 'monitor', 'workflow', 'unknown']).optional(),
  label: z.string().optional(),
  fallbackKind: z.enum(['command', 'monitor', 'workflow', 'unknown']).optional(),
  fallbackLabel: z.string().optional(),
  state: z.enum(['working', 'monitoring', 'waiting', 'done', 'blocked', 'idle', 'unverifiable']),
  parentToolUseId: z.string().trim().min(1).optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  outputFile: z.string().optional(),
  startedAt: z.number().optional(),
  settledAt: z.number().optional()
})

type TaskKind = 'command' | 'monitor' | 'workflow'

type PlannedTaskCall = {
  kind: TaskKind
  label?: string
  command?: string
}

function usableLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 140) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function planBrainTaskCall(name: string, args: Record<string, unknown>): PlannedTaskCall | null {
  if (name === 'run_command') {
    const command = asString(args.CommandLine)?.trim()
    const label = usableLabel(args.toolSummary) ?? summarizeCommandDescription(command)
    return {
      kind: 'command',
      ...(label ? { label } : {}),
      ...(command ? { command } : {})
    }
  }
  if (name === 'schedule') {
    const label = summarizeCommandDescription(asString(args.Prompt))
    return { kind: 'monitor', ...(label ? { label } : {}) }
  }
  if (name === 'run_workflow') {
    const label = usableLabel(args.Description)
    return { kind: 'workflow', ...(label ? { label } : {}) }
  }
  return null
}

function toolOutputText(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): string | undefined {
  if (typeof update.rawOutput === 'string') {
    return update.rawOutput
  }
  if (isRecord(update.rawOutput)) {
    const text =
      asString(update.rawOutput.stdout) ??
      asString(update.rawOutput.combinedOutput) ??
      asString(update.rawOutput.combined_output)
    if (text !== undefined) {
      return text
    }
  }
  const contentText = update.content
    ?.flatMap((item) =>
      item.type === 'content' && item.content.type === 'text' ? [item.content.text] : []
    )
    .join('\n')
  if (contentText) {
    return contentText
  }
  return tool.output?.head
}

/** Extract Antigravity background shell/monitor/workflow updates from direct ACP tool frames. */
export function antigravityToolBackgroundTasks(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpBackgroundTaskUpdate[] {
  if (
    (tool.name === 'manage_task' || update.title === 'manage_task') &&
    update.status === 'completed' &&
    isRecord(tool.input) &&
    tool.input.Action === 'kill'
  ) {
    const taskId = asString(tool.input.TaskId)?.trim()
    return taskId ? [{ taskId, state: 'idle', summary: '', error: '' }] : []
  }

  const rawName = update.title ?? tool.name
  const isTaskTool =
    tool.name === 'execute' ||
    rawName === 'run_command' ||
    rawName === 'schedule' ||
    rawName === 'run_workflow'
  if (!isTaskTool) {
    return []
  }

  const started = parseAntigravityBackgroundTaskStart(toolOutputText(update, tool))
  if (!started) {
    return []
  }
  const kind: TaskKind =
    rawName === 'schedule' ? 'monitor' : rawName === 'run_workflow' ? 'workflow' : 'command'
  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined
  const toolInput = isRecord(tool.input) ? tool.input : undefined
  const label =
    usableLabel(rawInput?.toolSummary) ??
    usableLabel(rawInput?.Description) ??
    summarizeCommandDescription(
      asString(rawInput?.Prompt) ?? asString(rawInput?.CommandLine) ?? asString(toolInput?.command)
    ) ??
    started.description

  return [
    {
      taskId: started.taskId,
      kind,
      state: kind === 'monitor' ? 'monitoring' : 'working',
      ...(label ? { label } : {}),
      ...(started.outputFile ? { outputFile: started.outputFile } : {}),
      parentToolUseId: update.toolCallId
    }
  ]
}

export function createAntigravityBrainBackgroundTasks(now: () => number) {
  const openTasks = new Set<string>()
  const knownTasks = new Set<string>()
  const recentExecuteCalls = new BoundedMap<string, string>({ maxEntries: RECENT_EXECUTE_LIMIT })
  const pendingStepCalls: (PlannedTaskCall | null)[] = []

  return {
    hasOpen: (): boolean => openTasks.size > 0,

    observeAppliedEvents(events: readonly ProviderTimelineEvent[]): void {
      for (const event of events) {
        if (
          (event.type === 'item.open' || event.type === 'item.close') &&
          event.body.kind === 'tool-call' &&
          event.body.callId &&
          isRecord(event.body.input) &&
          typeof event.body.input.command === 'string'
        ) {
          const command = event.body.input.command.trim()
          if (command) {
            recentExecuteCalls.set(command, event.body.callId)
          }
        } else if (event.type === 'item.update' && event.body.kind === 'message') {
          for (const block of event.body.blocks) {
            if (!isBackgroundTaskBlock(block)) {
              continue
            }
            knownTasks.add(block.taskId)
            if (isSettledBackgroundTaskState(block.state)) {
              openTasks.delete(block.taskId)
            } else {
              openTasks.add(block.taskId)
            }
          }
        }
      }
    },

    observePlannerCalls(
      toolCalls: readonly { name: string; args: Record<string, unknown> }[]
    ): AcpBackgroundTaskUpdate[] {
      pendingStepCalls.length = 0
      const settled: AcpBackgroundTaskUpdate[] = []
      const at = now()
      for (const call of toolCalls) {
        pendingStepCalls.push(planBrainTaskCall(call.name, call.args))
        if (call.name === 'manage_task' && call.args.Action === 'kill') {
          const taskId = asString(call.args.TaskId)?.trim()
          if (taskId && (openTasks.delete(taskId) || knownTasks.has(taskId))) {
            settled.push({ taskId, state: 'idle', summary: '', error: '', settledAt: at })
          }
        }
      }
      return settled
    },

    observeGeneric(
      record: Extract<AntigravityBrainRecord, { kind: 'generic' }>
    ): AcpBackgroundTaskUpdate[] {
      const stepMeta = pendingStepCalls.shift() ?? null
      if (!record.backgroundTask) {
        return []
      }
      const { taskId, description, outputFile } = record.backgroundTask
      openTasks.add(taskId)
      knownTasks.add(taskId)
      const kind = stepMeta?.kind ?? 'command'
      const label = stepMeta?.label ?? description
      const parentToolUseId = stepMeta?.command
        ? recentExecuteCalls.get(stepMeta.command)
        : undefined
      return [
        {
          taskId,
          kind,
          state: kind === 'monitor' ? 'monitoring' : 'working',
          ...(label ? { label } : {}),
          ...(outputFile ? { outputFile } : {}),
          ...(parentToolUseId ? { parentToolUseId } : {}),
          startedAt: now()
        }
      ]
    },

    applySystemMessages(
      messages: Extract<AntigravityBrainRecord, { kind: 'system-message' }>['messages'],
      resumed: boolean
    ): AcpBackgroundTaskUpdate[] {
      const updates: AcpBackgroundTaskUpdate[] = []
      const at = now()
      for (const msg of messages) {
        if (msg.stopsAllSubagents) {
          for (const taskId of openTasks) {
            updates.push({ taskId, state: 'idle', summary: '', error: '', settledAt: at })
          }
          openTasks.clear()
        } else if (msg.isTask) {
          const wasOpen = openTasks.delete(msg.sender)
          if (wasOpen || knownTasks.has(msg.sender) || resumed) {
            updates.push({
              taskId: msg.sender,
              fallbackKind: 'command',
              state: msg.taskState ?? 'done',
              summary: '',
              error: msg.taskError ?? '',
              ...(msg.outputFile ? { outputFile: msg.outputFile } : {}),
              settledAt: at
            })
          }
        }
      }
      return updates
    },

    clear(): void {
      openTasks.clear()
      knownTasks.clear()
      recentExecuteCalls.clear()
      pendingStepCalls.length = 0
    }
  }
}
