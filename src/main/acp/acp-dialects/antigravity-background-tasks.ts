import { z } from 'zod'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import { isSettledBackgroundTaskState } from '../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import { summarizeCommandDescription } from '../../antigravity/antigravity-brain-background-task-records'
import type { AntigravityBrainRecord } from '../../antigravity/antigravity-brain-transcript-records'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpBackgroundTaskUpdate } from './acp-dialect'

const RECENT_EXECUTE_LIMIT = 32
const TASK_ALIAS_LIMIT = 128

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
  isDaemon?: boolean
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
      ...(command ? { command } : {}),
      ...(args.IsDaemon === true ? { isDaemon: true } : {})
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

export function createAntigravityBrainBackgroundTasks(
  now: () => number,
  confirmTask?: (taskId: string, settled?: AcpBackgroundTaskUpdate) => void
) {
  const openTasks = new Set<string>()
  const knownTasks = new Set<string>()
  const recentExecuteCalls = new BoundedMap<string, string>({ maxEntries: RECENT_EXECUTE_LIMIT })
  const idByBrainTask = new BoundedMap<string, string>({ maxEntries: TASK_ALIAS_LIMIT })
  const pendingStepCalls: (PlannedTaskCall | null)[] = []

  return {
    hasOpen: (): boolean => openTasks.size > 0,

    observeAppliedEvents(events: readonly ProviderTimelineEvent[]): void {
      for (const event of events) {
        if (
          (event.type === 'item.open' ||
            event.type === 'item.update' ||
            event.type === 'item.close') &&
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
          const rawTaskId = asString(call.args.TaskId)?.trim()
          const taskId = rawTaskId ? (idByBrainTask.get(rawTaskId) ?? rawTaskId) : ''
          if (taskId && (openTasks.delete(taskId) || knownTasks.has(taskId))) {
            const update: AcpBackgroundTaskUpdate = {
              taskId,
              state: 'idle',
              summary: '',
              error: '',
              settledAt: at
            }
            confirmTask?.(taskId, update)
            settled.push(update)
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
      const parentToolUseId = stepMeta?.command
        ? recentExecuteCalls.get(stepMeta.command)
        : undefined
      const effectiveId = parentToolUseId ?? taskId
      idByBrainTask.set(taskId, effectiveId)
      confirmTask?.(effectiveId)
      openTasks.add(effectiveId)
      knownTasks.add(effectiveId)
      const kind = stepMeta?.kind ?? 'command'
      const label = stepMeta?.label ?? description
      return [
        {
          taskId: effectiveId,
          kind,
          state: kind === 'monitor' || stepMeta?.isDaemon ? 'monitoring' : 'working',
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
            const update: AcpBackgroundTaskUpdate = {
              taskId,
              state: 'idle',
              summary: '',
              error: '',
              settledAt: at
            }
            confirmTask?.(taskId, update)
            updates.push(update)
          }
          openTasks.clear()
        } else if (msg.isTask) {
          const effectiveId = idByBrainTask.get(msg.sender) ?? msg.sender
          const wasOpen = openTasks.delete(effectiveId)
          if (wasOpen || knownTasks.has(effectiveId) || resumed) {
            updates.push({
              taskId: effectiveId,
              fallbackKind: 'command',
              state: msg.taskState ?? 'done',
              ...(msg.taskError ? { error: msg.taskError } : {}),
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
      idByBrainTask.clear()
      pendingStepCalls.length = 0
    }
  }
}
