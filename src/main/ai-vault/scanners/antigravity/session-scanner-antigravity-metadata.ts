import { fileURLToPath } from 'node:url'
import { parseJsonObject } from '../../parsing/session-json-object'

export const ANTIGRAVITY_INDEX_MAX_BYTES = 4 * 1024 * 1024
const MAX_INDEX_ENTRIES = 10_000

type JsonRecord = Record<string, unknown>
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function record(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null
}
function entries(value: unknown): [string, unknown][] {
  const object = record(value)
  return object ? Object.entries(object).slice(0, MAX_INDEX_ENTRIES) : []
}
function parse(content: string | null): JsonRecord | null {
  return content && Buffer.byteLength(content) <= ANTIGRAVITY_INDEX_MAX_BYTES
    ? parseJsonObject(content)
    : null
}
function unique(map: Map<string, string | null>, id: string, path: string | null): void {
  if (!id || id.length > 512 || (path !== null && (!path || path.length > 4096))) {
    return
  }
  if (map.has(id) && map.get(id) !== path) {
    map.set(id, null)
  } else if (!map.has(id)) {
    map.set(id, path)
  }
}

export type AntigravityConversationSummaries = {
  workspaces: Record<string, string | null>
  internalIds: string[]
}

export function antigravityCachePath(historyPath: string, fileName: string): string {
  const separator = historyPath.includes('\\') ? '\\' : '/'
  return `${historyPath.replace(/[\\/]history\.jsonl$/, '') + separator}cache${separator}${fileName}`
}

export function antigravitySummariesDbPath(historyPath: string): string {
  const separator = historyPath.includes('\\') ? '\\' : '/'
  return `${historyPath.replace(/[\\/]history\.jsonl$/, '') + separator}conversation_summaries.db`
}

export function antigravityWorkspaceFromUri(uri: string): string | null {
  if (!uri.startsWith('file://')) {
    return null
  }
  try {
    const parsed = new URL(uri)
    if (parsed.protocol !== 'file:') {
      return null
    }
    const decodedPath = decodeURIComponent(parsed.pathname)
    // Decode POSIX and Windows file:// URIs regardless of the scanning host OS.
    const isWindows =
      (!parsed.hostname && /^\/[A-Za-z]:(?:\/|$)/.test(decodedPath)) ||
      (Boolean(parsed.hostname) && parsed.hostname !== 'localhost')
    let resolved = fileURLToPath(parsed, { windows: isWindows })
    if (
      isWindows
        ? resolved.length > 3 && resolved.endsWith('\\')
        : resolved.length > 1 && resolved.endsWith('/')
    ) {
      resolved = resolved.slice(0, -1)
    }
    return /^(?:[/\\]|[A-Za-z]:[/\\])/.test(resolved) && resolved.length <= 4096 ? resolved : null
  } catch {
    return null
  }
}

export function antigravitySummaryWorkspaceUriPath(raw: unknown): string | null | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const decoded = new Set<string>()
  for (const item of raw.slice(0, 16)) {
    if (typeof item !== 'string' || !item.trim()) {
      continue
    }
    const path = antigravityWorkspaceFromUri(item.trim())
    if (!path) {
      return null
    }
    decoded.add(path)
    if (decoded.size > 1) {
      return null
    }
  }
  return decoded.size === 1 ? decoded.values().next().value : undefined
}

export function antigravityMetadataInternalConversations(metadata: string | null): Set<string> {
  const internal = new Set<string>()
  for (const [id, value] of entries(parse(metadata)?.conversations)) {
    const entry = record(value)
    const summary = record(entry?.summary)
    if (id && id.length <= 512 && (entry?.is_internal === true || summary?.Internal === true)) {
      internal.add(id)
    }
  }
  return internal
}

export function antigravityMetadataWorkspaces(contents: {
  metadata: string | null
  projects: string | null
  lastConversations: string | null
}): Map<string, string | null> {
  const projectPaths = new Map<string, string | null>()
  for (const [key, value] of entries(parse(contents.projects))) {
    if (typeof value !== 'string') {
      continue
    }
    if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(key)) {
      unique(projectPaths, value, key)
    } else if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(value)) {
      unique(projectPaths, key, value)
    }
  }
  const paths = new Map<string, string | null>()
  for (const [path, id] of entries(parse(contents.lastConversations))) {
    if (typeof id === 'string' && /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path)) {
      unique(paths, id, path)
    }
  }
  for (const [id, value] of entries(parse(contents.metadata)?.conversations)) {
    const summary = record(record(value)?.summary)
    const projectId = summary?.ProjectID
    const projectPath = typeof projectId === 'string' ? projectPaths.get(projectId) : undefined
    if (projectPath !== undefined) {
      unique(paths, id, projectPath)
    }
    const uriPath = antigravitySummaryWorkspaceUriPath(summary?.WorkspaceURIs)
    if (uriPath !== undefined) {
      unique(paths, id, uriPath)
    }
  }
  return paths
}

export async function readBoundedAntigravityIndex(
  chunks: AsyncIterable<Buffer>
): Promise<string | null> {
  const retained: Buffer[] = []
  let bytes = 0
  for await (const chunk of chunks) {
    bytes += chunk.length
    if (bytes > ANTIGRAVITY_INDEX_MAX_BYTES) {
      return null
    }
    retained.push(chunk)
  }
  return Buffer.concat(retained, bytes).toString('utf8')
}
