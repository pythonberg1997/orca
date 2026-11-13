// Track evidence for this provider child; the host owns durable subagent records.

import { createHash } from 'node:crypto'
import type { AgentChildWorkOutcome } from '../../../shared/agent-status/child-work/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentState } from '../../../shared/native-chat/native-chat-types'
import { sliceAtCodeUnitLimit } from '../../../shared/surrogate-safe-text-slice'
import { boundSubagentLabel } from '../../native-chat/agent-session-journal/item-lifecycle/journal-subagent-item'
import type {
  ProviderTimelineJoin,
  ProviderTimelineEvent
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpSubagentUpdate } from '../acp-dialects/acp-dialect'

type KnownSubagent = {
  /** Pin replies to the spawning turn. */
  placement: ProviderTimelineJoin
  replyDigest?: string
  /** Preserve the first terminal state; only completed runs can publish replies. */
  ended?: NativeChatSubagentState
}

const OUTCOMES: Record<
  Exclude<NativeChatSubagentState, 'working' | 'idle'>,
  AgentChildWorkOutcome
> = {
  completed: 'succeeded',
  failed: 'failed',
  stopped: 'cancelled',
  unverifiable: 'unknown'
}

export function acpSubagentOutcome(
  state: NativeChatSubagentState
): AgentChildWorkOutcome | undefined {
  return state === 'working' || state === 'idle' ? undefined : OUTCOMES[state]
}

const MAX_PROMPT_LABEL_CHARS = 80

export function acpSubagentPromptLabel(prompt: string | undefined): string | undefined {
  const line = prompt?.trim().split('\n')[0]?.trim()
  if (!line) {
    return undefined
  }
  return line.length > MAX_PROMPT_LABEL_CHARS
    ? `${sliceAtCodeUnitLimit(line, MAX_PROMPT_LABEL_CHARS - 1)}…`
    : line
}

export class AcpSubagents {
  private readonly known = new Map<string, KnownSubagent>()
  private readonly aliases = new Map<string, string>()
  private readonly unaliasedSpawns: string[] = []
  private readonly pendingSpawnIds: string[] = []
  private readonly deferredByPendingId = new Map<string, AcpSubagentUpdate[]>()
  private readonly pending: AgentChildWorkEvidence[] = []

  /** Include settled subagents so they cannot be reclassified as background tasks. */
  has(id: string): boolean {
    return this.known.has(this.resolveId(id))
  }

  hasOpen(): boolean {
    for (const subagent of this.known.values()) {
      if (subagent.ended === undefined) {
        return true
      }
    }
    return false
  }

  /** Map a provider-minted child ID discovered out-of-band to the call-keyed spawn row. */
  bindSpawnAlias(providerId: string): void {
    if (
      this.aliases.has(providerId) ||
      this.known.has(providerId) ||
      this.pendingSpawnIds.includes(providerId)
    ) {
      return
    }
    const target = this.unaliasedSpawns.shift()
    if (target) {
      this.aliases.set(providerId, target)
      return
    }
    this.pendingSpawnIds.push(providerId)
  }

  dispose(): void {
    this.known.clear()
    this.aliases.clear()
    this.unaliasedSpawns.length = 0
    this.pendingSpawnIds.length = 0
    this.deferredByPendingId.clear()
    this.pending.length = 0
  }

  drainEvidence(): AgentChildWorkEvidence[] {
    return this.pending.splice(0)
  }

  reconcile(
    id: string,
    state: NativeChatSubagentState,
    thread: string,
    at: number
  ): ProviderTimelineEvent[] {
    return this.translate([{ id, state, knownOnly: true }], { thread }, at)
  }

  translate(
    updates: readonly AcpSubagentUpdate[],
    join: ProviderTimelineJoin,
    at: number
  ): ProviderTimelineEvent[] {
    const replies: ProviderTimelineEvent[] = []
    for (const rawUpdate of updates) {
      if (
        rawUpdate.allOpen &&
        rawUpdate.state !== undefined &&
        acpSubagentOutcome(rawUpdate.state)
      ) {
        for (const [id, subagent] of this.known) {
          if (subagent.ended === undefined) {
            subagent.ended = rawUpdate.state
            this.pending.push(subagentEvidence({ id, state: rawUpdate.state }, at))
          }
        }
        for (const providerId of this.pendingSpawnIds) {
          const queued = this.deferredByPendingId.get(providerId) ?? []
          queued.push({ id: providerId, state: rawUpdate.state, knownOnly: true })
          this.deferredByPendingId.set(providerId, queued)
        }
        continue
      }
      const id = this.resolveId(rawUpdate.id)
      const update = id === rawUpdate.id ? rawUpdate : { ...rawUpdate, id }
      const known = this.known.get(update.id)
      if (!known && update.knownOnly === true) {
        if (this.pendingSpawnIds.includes(update.id)) {
          const queued = this.deferredByPendingId.get(update.id) ?? []
          queued.push(update)
          this.deferredByPendingId.set(update.id, queued)
        }
        continue
      }
      let boundProviderId: string | undefined
      if (!known && update.awaitingAlias === true) {
        boundProviderId = this.pendingSpawnIds.shift()
        if (boundProviderId) {
          this.aliases.set(boundProviderId, update.id)
        } else {
          this.unaliasedSpawns.push(update.id)
        }
      }
      const turn = update.turn ?? join.turn
      const subagent = known ?? {
        placement: {
          ...(join.thread === undefined ? {} : { thread: join.thread }),
          ...(turn === undefined ? {} : { turn })
        }
      }
      this.known.set(update.id, subagent)
      if (update.restart && subagent.ended !== undefined) {
        subagent.ended = undefined
        subagent.replyDigest = undefined
      }
      const ending = update.state !== undefined && acpSubagentOutcome(update.state) !== undefined
      // Late live reports must not resurrect an ended run after the host retires its record.
      if (ending || subagent.ended === undefined) {
        this.pending.push(subagentEvidence(update, at))
      }
      if (ending) {
        subagent.ended ??= update.state
      }
      if (update.result && subagent.ended === 'completed') {
        replies.push(...this.reply(update.id, subagent, update.result))
      }
      if (boundProviderId !== undefined) {
        const deferred = this.deferredByPendingId.get(boundProviderId)
        if (deferred) {
          this.deferredByPendingId.delete(boundProviderId)
          replies.push(...this.translate(deferred, join, at))
        }
      }
    }
    return replies
  }

  private resolveId(id: string): string {
    return this.aliases.get(id) ?? id
  }

  private reply(id: string, subagent: KnownSubagent, text: string): ProviderTimelineEvent[] {
    const digest = createHash('sha256').update(text, 'utf16le').digest('hex')
    if (subagent.replyDigest === digest) {
      return []
    }
    subagent.replyDigest = digest
    return [
      {
        type: 'item.update',
        item: `subagent-result:${id}`,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
        producer: { agentId: id, producerKind: 'agent' },
        join: subagent.placement
      }
    ]
  }
}

// Subagents outlive their spawning prompt and have no provider run identity.
function subagentEvidence(update: AcpSubagentUpdate, observedAt: number): AgentChildWorkEvidence {
  const handle = subagentHandle(update.id)
  const outcome = update.state === undefined ? undefined : acpSubagentOutcome(update.state)
  if (outcome === undefined) {
    return {
      type: 'live',
      observedAt,
      child: {
        handle,
        kind: 'agent',
        residency: 'background',
        state: update.state === 'idle' ? 'idle' : 'working',
        ...(update.label !== undefined ? { description: boundSubagentLabel(update.label) } : {}),
        ...(update.tokens !== undefined ? { totalTokens: update.tokens } : {}),
        ...(update.ownerId !== undefined ? { ownerId: subagentHandle(update.ownerId).id } : {}),
        // Hashed handles cannot address provider cancellation.
        stoppable: handle.id === update.id
      },
      ...(update.restart ? { restart: true } : {})
    }
  }
  return {
    type: 'ended',
    observedAt,
    handle,
    outcome,
    ...(update.tokens !== undefined ? { totalTokens: update.tokens } : {})
  }
}

function subagentHandle(id: string): AgentChildWorkEvidenceHandle {
  const bounded =
    id.length <= MAX_SUBAGENT_FIELD_CHARS
      ? id
      : `acp-child:${createHash('sha256').update(id).digest('hex')}`
  return {
    idKind: 'task_id',
    id: bounded,
    // Hash the smaller invocation fence while retaining the full handle.
    ...(bounded.length > AGENT_CHILD_WORK_ID_MAX_LENGTH
      ? { runId: `acp-child:${createHash('sha256').update(bounded).digest('hex')}` }
      : {})
  }
}
