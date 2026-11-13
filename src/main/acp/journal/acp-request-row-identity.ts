import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ProviderTimelineIdentityScheme } from '../../native-chat/agent-session-timeline/provider-timeline-identity'

export function matchesAcpRequestRow(
  scheme: ProviderTimelineIdentityScheme,
  scope: { sessionId: string; generation: string },
  itemId: string,
  requestKey: string
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'legacy' || identity.sessionId !== scope.sessionId) {
    return false
  }
  const first = scheme.request({ generation: scope.generation, key: requestKey, incarnation: 1 })
  const prefix = first.provider === 'legacy' ? first.recordId : null
  return identity.recordId === prefix || identity.recordId.startsWith(`${prefix}#`)
}
