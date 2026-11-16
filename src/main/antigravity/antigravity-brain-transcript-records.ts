import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../ai-vault/transcripts/session-transcript-record-budget'
import { antigravityUserHome } from './antigravity-chat-user-skills'

const SPAWNED_SUBAGENT_MARKER = 'Created the following subagent:'
const BACKGROUND_TASK_MARKER = 'Tool is running as a background task with task id:'
const SPAWNED_SUBAGENT_JSON =
  /(?:^|\r?\n)Created the following subagent:\s*\r?\n(\{[\s\S]*?\r?\n\})/
const BACKGROUND_TASK_ID = /(?:^|\r?\n)Tool is running as a background task with task id:\s*(\S+)/
const SYSTEM_MESSAGE_ENTRY =
  /\[Message\]\s+(?:timestamp=\S+\s+)?sender=(\S+)\s+priority=(\S+)\s+content=([\s\S]*?)(?=\r?\n\[Message\]\s+(?:timestamp=\S+\s+)?sender=|\r?\n<\/SYSTEM_MESSAGE>|$)/g

export type AntigravityTranscriptPaths = {
  full: string
  compact: string
}

type AntigravityBrainToolCall = {
  name: string
  args: Record<string, unknown>
}

type AntigravitySystemMessageItem = {
  sender: string
  content: string
  isTask: boolean
  stopsAllSubagents: boolean
  wakesAgent: boolean
}

export type AntigravityBrainRecord =
  | {
      kind: 'user-input'
      stepIndex?: number
      status?: string
    }
  | {
      kind: 'checkpoint'
      stepIndex?: number
      status?: string
    }
  | {
      kind: 'planner-response'
      stepIndex?: number
      status?: string
      thinking?: string
      content?: string
      toolCalls: AntigravityBrainToolCall[]
    }
  | {
      kind: 'generic'
      stepIndex?: number
      status?: string
      content?: string
      spawnedSubagent?: {
        conversationId: string
        transcriptPaths?: AntigravityTranscriptPaths
      }
      backgroundTaskId?: string
    }
  | {
      kind: 'system-message'
      stepIndex?: number
      status?: string
      messages: AntigravitySystemMessageItem[]
    }
  | {
      kind: 'other'
      stepIndex?: number
      status?: string
    }

export function antigravityAcpBrainDir(
  env: Readonly<Record<string, string>>,
  managed: boolean
): string | null {
  if (managed) {
    const geminiHome = env.GEMINI_HOME?.trim()
    return geminiHome ? join(geminiHome, ANTIGRAVITY_ACP_HOME, 'brain') : null
  }
  // Host `agy acp` ignores `GEMINI_HOME` and writes to `<home>/.gemini/antigravity-cli/brain`.
  const userHome = antigravityUserHome(env).trim()
  return userHome ? join(userHome, '.gemini', 'antigravity-cli', 'brain') : null
}

function transcriptPathsForLogsDir(logsDir: string): AntigravityTranscriptPaths {
  return {
    full: join(logsDir, 'transcript_full.jsonl'),
    compact: join(logsDir, 'transcript.jsonl')
  }
}

export function antigravityBrainTranscriptPaths(
  brainDir: string,
  conversationId: string
): AntigravityTranscriptPaths {
  return transcriptPathsForLogsDir(join(brainDir, conversationId, '.system_generated', 'logs'))
}

function resolveTranscriptUriPaths(
  uri: string | undefined
): AntigravityTranscriptPaths | undefined {
  if (!uri?.startsWith('file://')) {
    return undefined
  }
  try {
    return transcriptPathsForLogsDir(dirname(fileURLToPath(uri)))
  } catch {
    return undefined
  }
}

function parseSpawnedSubagent(
  content: string | undefined
): { conversationId: string; transcriptPaths?: AntigravityTranscriptPaths } | undefined {
  if (!content?.includes(SPAWNED_SUBAGENT_MARKER)) {
    return undefined
  }
  const block = SPAWNED_SUBAGENT_JSON.exec(content)?.[1]
  if (!block) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(block)
    if (!isRecord(parsed) || typeof parsed.conversationId !== 'string') {
      return undefined
    }
    const conversationId = parsed.conversationId.trim()
    if (!conversationId) {
      return undefined
    }
    const logUri = typeof parsed.logAbsoluteUri === 'string' ? parsed.logAbsoluteUri.trim() : ''
    const transcriptPaths = logUri ? resolveTranscriptUriPaths(logUri) : undefined
    return {
      conversationId,
      ...(transcriptPaths ? { transcriptPaths } : {})
    }
  } catch {
    return undefined
  }
}

function parseSystemMessages(content: string | undefined): AntigravitySystemMessageItem[] {
  if (!content) {
    return []
  }
  const messages: AntigravitySystemMessageItem[] = []
  for (const match of content.matchAll(SYSTEM_MESSAGE_ENTRY)) {
    const sender = match[1]?.trim()
    const priority = match[2]?.trim() ?? ''
    if (!sender) {
      continue
    }
    const body = (match[3] ?? '').trim()
    const stopsAllSubagents =
      sender === 'system' &&
      body.includes('All your subagents and background tasks have been stopped')
    messages.push({
      sender,
      content: body,
      isTask: sender.includes('/task-'),
      stopsAllSubagents,
      // Low-priority notices are piggybacked onto explicit turns and never wake an idle agent.
      wakesAgent: !stopsAllSubagents && priority !== 'MESSAGE_PRIORITY_LOW' && priority !== 'low'
    })
  }
  return messages
}

function parseToolCalls(raw: unknown): AntigravityBrainToolCall[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const calls: AntigravityBrainToolCall[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      continue
    }
    const name = entry.name.trim()
    if (!name) {
      continue
    }
    calls.push({
      name,
      args: isRecord(entry.args) ? entry.args : {}
    })
  }
  return calls
}

export function parseAntigravityBrainLine(line: string): AntigravityBrainRecord | null {
  if (!line || line.length > MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
    return null
  }
  let rawJson: unknown
  try {
    rawJson = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(rawJson)) {
    return null
  }
  const stepIndex =
    typeof rawJson.step_index === 'number' &&
    Number.isInteger(rawJson.step_index) &&
    rawJson.step_index >= 0
      ? rawJson.step_index
      : undefined
  const source = typeof rawJson.source === 'string' ? rawJson.source : undefined
  const type = typeof rawJson.type === 'string' ? rawJson.type : undefined
  const status = typeof rawJson.status === 'string' ? rawJson.status : undefined
  const content = typeof rawJson.content === 'string' ? rawJson.content : undefined
  const thinking = typeof rawJson.thinking === 'string' ? rawJson.thinking : undefined

  if (
    (source === 'USER_EXPLICIT' || source === 'USER') &&
    (type === 'USER_INPUT' || type === 'REQUEST')
  ) {
    return { kind: 'user-input', stepIndex, status }
  }
  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    return {
      kind: 'planner-response',
      stepIndex,
      status,
      thinking,
      content,
      toolCalls: parseToolCalls(rawJson.tool_calls)
    }
  }
  if (source === 'MODEL' && type === 'GENERIC') {
    const spawnedSubagent = parseSpawnedSubagent(content)
    const backgroundTaskId = content?.includes(BACKGROUND_TASK_MARKER)
      ? BACKGROUND_TASK_ID.exec(content)?.[1]
      : undefined
    return {
      kind: 'generic',
      stepIndex,
      status,
      content,
      ...(spawnedSubagent ? { spawnedSubagent } : {}),
      ...(backgroundTaskId ? { backgroundTaskId } : {})
    }
  }
  if (source === 'SYSTEM' && type === 'SYSTEM_MESSAGE') {
    return {
      kind: 'system-message',
      stepIndex,
      status,
      messages: parseSystemMessages(content)
    }
  }
  if (source === 'SYSTEM' && type === 'CHECKPOINT') {
    return { kind: 'checkpoint', stepIndex, status }
  }
  return { kind: 'other', stepIndex, status }
}
