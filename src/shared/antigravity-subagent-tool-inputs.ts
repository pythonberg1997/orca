import { isRecord } from './agent-status/child-work/agent-status-child-work-value-guards'

const MAX_SWARM_WORKERS = 32
const POSITIVE_SHARD_SUFFIX = /^[1-9]\d*$/

type AntigravityParsedSubagentToolInput =
  | {
      kind: 'invoke_subagent'
      agentType?: string
      role?: string
      model?: string
      promptLine?: string
    }
  | {
      kind: 'send_message'
      recipient?: string
    }
  | {
      kind: 'manage_subagents'
      action: 'kill_all'
    }
  | {
      kind: 'manage_subagents'
      action: 'kill'
      conversationIds: string[]
    }
  | {
      kind: 'swarm_add'
      workers: { id: string; description: string }[]
    }
  | {
      kind: 'swarm_kill'
      id: string
      shardIds: string[]
    }

function firstTrimmedString(
  source: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        return trimmed
      }
    }
  }
  return undefined
}

function firstPromptLine(text: string | undefined): string | undefined {
  const line = text?.split('\n')[0]?.trim()
  return line || undefined
}

export function isAntigravityParentSubagentTool(toolName: string | undefined): boolean {
  return toolName === 'invoke_subagent' || toolName === 'swarm'
}

export function matchesAntigravitySwarmKillId(candidateId: string, killId: string): boolean {
  if (candidateId === killId) {
    return true
  }
  const prefix = `${killId}-`
  return (
    candidateId.startsWith(prefix) && POSITIVE_SHARD_SUFFIX.test(candidateId.slice(prefix.length))
  )
}

export function parseAntigravitySubagentToolInput(
  toolName: string | undefined,
  rawInput: unknown
): AntigravityParsedSubagentToolInput | null {
  const args = isRecord(rawInput) ? rawInput : {}
  if (toolName === 'invoke_subagent') {
    const role = firstTrimmedString(args, ['Role', 'role'])
    const agentType = firstTrimmedString(args, ['TypeName', 'typeName', 'type_name'])
    const rawModel = firstTrimmedString(args, ['Model', 'model'])
    const model = rawModel && rawModel !== 'inherit' ? rawModel : undefined
    const promptLine = firstPromptLine(firstTrimmedString(args, ['Prompt', 'prompt']))
    return {
      kind: 'invoke_subagent',
      ...(agentType ? { agentType } : {}),
      ...(role ? { role } : {}),
      ...(model ? { model } : {}),
      ...(promptLine ? { promptLine } : {})
    }
  }
  if (toolName === 'send_message') {
    const recipient = firstTrimmedString(args, ['Recipient', 'recipient'])
    return { kind: 'send_message', ...(recipient ? { recipient } : {}) }
  }
  if (toolName === 'manage_subagents') {
    const action = firstTrimmedString(args, ['Action', 'action'])
    if (action === 'kill_all') {
      return { kind: 'manage_subagents', action: 'kill_all' }
    }
    const rawIds = Array.isArray(args.ConversationIds)
      ? args.ConversationIds
      : Array.isArray(args.conversationIds)
        ? args.conversationIds
        : undefined
    if (action === 'kill' && rawIds) {
      const conversationIds = [
        ...new Set(
          rawIds.flatMap((entry) =>
            typeof entry === 'string' && entry.trim() ? [entry.trim()] : []
          )
        )
      ]
      if (conversationIds.length > 0) {
        return { kind: 'manage_subagents', action: 'kill', conversationIds }
      }
    }
    return null
  }
  if (toolName === 'swarm') {
    const action = firstTrimmedString(args, ['action', 'Action'])
    const name = firstTrimmedString(args, ['name', 'Name'])
    if (!name) {
      return null
    }
    if (action === 'add') {
      const rawTasks = Array.isArray(args.tasks)
        ? args.tasks.slice(0, MAX_SWARM_WORKERS)
        : undefined
      if (rawTasks && rawTasks.length > 0) {
        return {
          kind: 'swarm_add',
          workers: rawTasks.map((task, idx) => {
            const worker = `${name}-${idx + 1}`
            const taskLine = typeof task === 'string' ? firstPromptLine(task.trim()) : undefined
            return {
              id: `swarm:${worker}`,
              description: taskLine ? `${worker}: ${taskLine}` : worker
            }
          })
        }
      }
      const rawCount = typeof args.n === 'number' && Number.isInteger(args.n) ? args.n : 1
      const count = rawCount > 1 ? Math.min(rawCount, MAX_SWARM_WORKERS) : 1
      if (count > 1) {
        return {
          kind: 'swarm_add',
          workers: Array.from({ length: count }, (_, idx) => {
            const worker = `${name}-${idx + 1}`
            return { id: `swarm:${worker}`, description: worker }
          })
        }
      }
      const briefLine = firstPromptLine(firstTrimmedString(args, ['brief', 'Brief']))
      return {
        kind: 'swarm_add',
        workers: [{ id: `swarm:${name}`, description: briefLine ? `${name}: ${briefLine}` : name }]
      }
    }
    if (action === 'kill') {
      const id = `swarm:${name}`
      return {
        kind: 'swarm_kill',
        id,
        shardIds: Array.from({ length: MAX_SWARM_WORKERS }, (_, idx) => `${id}-${idx + 1}`)
      }
    }
  }
  return null
}
