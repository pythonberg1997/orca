import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { antigravityConversationIdFromTranscriptPath } from '../ai-vault/scanners/antigravity/session-scanner-antigravity-paths'
import { antigravityBrainTranscriptPaths } from './antigravity-brain-transcript-records'
import { isAntigravityHostAccountHome } from './antigravity-host-acp'

const ANTIGRAVITY_CLI_HOME = 'antigravity-cli'

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false
    }
    throw error
  }
}

async function hasAntigravityConversationDb(store: string, sessionId: string): Promise<boolean> {
  return (
    Boolean(sessionId) &&
    !/[/\\]/.test(sessionId) &&
    (await isRegularFile(join(store, 'conversations', `${sessionId}.db`)))
  )
}

/** Host `agy` shares `<home>/.gemini/antigravity-cli` across CLI and ACP; managed chats isolate under `GEMINI_HOME/antigravity-acp`. */
export const ANTIGRAVITY_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  accountHomeVariable: 'GEMINI_HOME',
  conversationStore: ({ accountHomePath }) =>
    join(
      accountHomePath,
      isAntigravityHostAccountHome({ variable: 'GEMINI_HOME', path: accountHomePath })
        ? ANTIGRAVITY_CLI_HOME
        : ANTIGRAVITY_ACP_HOME
    ),
  admitRoot: (store) => join(store, 'brain'),
  validateAdmittedPath: async ({ store, admittedPath }) => {
    const sessionId = antigravityConversationIdFromTranscriptPath(admittedPath)
    return Boolean(sessionId && (await hasAntigravityConversationDb(store, sessionId)))
  },
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  findTranscript: async ({ providerSessionId, store }) => {
    if (!(await hasAntigravityConversationDb(store, providerSessionId))) {
      return null
    }
    const paths = antigravityBrainTranscriptPaths(join(store, 'brain'), providerSessionId)
    if (await isRegularFile(paths.full)) {
      return paths.full
    }
    return (await isRegularFile(paths.compact)) ? paths.compact : null
  }
})
