import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { parseAntigravitySubagentToolInput } from '../../../shared/antigravity-subagent-tool-inputs'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { acpSubagentPromptLabel } from '../timeline/acp-subagents'
import type { AcpDialectNotification, AcpSubagentUpdate } from './acp-dialect'
import { brainBackgroundTaskSchema } from './antigravity-background-tasks'

export const ANTIGRAVITY_BRAIN_NOTIFICATION = '_antigravity/brain_turn'

const nonEmptyId = lazyZodSchema(() => z.string().trim().min(1))

const rawOutputIdSchema = lazyZodSchema(() =>
  z.looseObject({
    conversationId: nonEmptyId.optional(),
    conversation_id: nonEmptyId.optional()
  })
)

const CONVERSATION_ID_LINE = /Conversation ID:\s*([A-Za-z0-9_-]+)/i
const JSON_CONVERSATION_ID = /"conversationId"\s*:\s*"([A-Za-z0-9_-]+)"/

const brainSubagentSchema = lazyZodSchema(() =>
  z.object({
    id: nonEmptyId,
    allOpen: z.literal(true).optional(),
    state: z.enum(['working', 'idle', 'completed', 'failed', 'stopped', 'unverifiable']).optional(),
    label: z.string().optional(),
    result: z.string().optional(),
    knownOnly: z.literal(true).optional(),
    restart: z.literal(true).optional()
  })
)

const brainTurnSchema = lazyZodSchema(() =>
  z.object({
    turn: nonEmptyId.optional(),
    started: z.boolean().optional(),
    end: z.object({ stopReason: nonEmptyId }).optional(),
    subagents: z.array(brainSubagentSchema).optional(),
    backgroundTasks: z.array(brainBackgroundTaskSchema).optional()
  })
)

export function antigravityNotification(
  method: string,
  params: unknown
): AcpDialectNotification | undefined {
  if (method === ANTIGRAVITY_BRAIN_NOTIFICATION) {
    const parsed = brainTurnSchema.safeParse(params)
    return parsed.success ? { disposition: 'map', ...parsed.data } : { disposition: 'ignore' }
  }
  if (method === 'session/update' && isRecord(params) && isRecord(params._meta)) {
    const rawTurn = params._meta.antigravityTurn
    const turn = typeof rawTurn === 'string' ? rawTurn.trim() : ''
    return turn ? { disposition: 'map', turn } : undefined
  }
  return undefined
}

function outputConversationId(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): string | undefined {
  const parsed = rawOutputIdSchema.safeParse(update.rawOutput)
  if (parsed.success) {
    const direct = parsed.data.conversationId ?? parsed.data.conversation_id
    if (direct) {
      return direct
    }
  }
  const text =
    typeof update.rawOutput === 'string'
      ? update.rawOutput
      : typeof tool.output === 'string'
        ? tool.output
        : undefined
  return text
    ? (CONVERSATION_ID_LINE.exec(text)?.[1] ?? JSON_CONVERSATION_ID.exec(text)?.[1])
    : undefined
}

/** Antigravity spawns background subagents that outlive the initial prompt turn until wakeup settles them. */
export function antigravityToolSubagents(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpSubagentUpdate[] {
  if (update.status !== 'completed') {
    return []
  }
  const parsed = parseAntigravitySubagentToolInput(tool.name, tool.input)
  if (!parsed) {
    return []
  }
  switch (parsed.kind) {
    case 'invoke_subagent': {
      const directId = outputConversationId(update, tool)
      const id = directId ?? `subagent:${tool.callId}`
      const label = parsed.role ?? parsed.agentType ?? acpSubagentPromptLabel(parsed.promptLine)
      return [
        {
          id,
          state: 'working',
          ...(directId ? {} : { awaitingAlias: true as const }),
          ...(label ? { label } : {})
        }
      ]
    }
    case 'send_message':
      return parsed.recipient
        ? [{ id: parsed.recipient, state: 'working', knownOnly: true, restart: true }]
        : []
    case 'manage_subagents':
      return parsed.action === 'kill_all'
        ? [{ id: '*', allOpen: true, state: 'stopped' }]
        : parsed.conversationIds.map((id) => ({ id, state: 'stopped', knownOnly: true }))
    case 'swarm_add':
      return parsed.workers.map(({ id, description }) => ({
        id,
        state: 'working',
        label: acpSubagentPromptLabel(description) ?? description,
        restart: true
      }))
    case 'swarm_kill':
      return [parsed.id, ...parsed.shardIds].map((id) => ({
        id,
        state: 'stopped',
        knownOnly: true
      }))
  }
}
