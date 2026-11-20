import { fileURLToPath } from 'node:url'

const BACKGROUND_TASK_MARKER = 'Tool is running as a background task with task id:'
const BACKGROUND_TASK_ID = /(?:^|\r?\n)Tool is running as a background task with task id:\s*(\S+)/
const BACKGROUND_TASK_DESCRIPTION =
  /(?:^|\r?\n)Task Description:\s*([\s\S]*?)(?=\r?\nTask logs are available at:|\r?\nLog output:|\r?\nYOU MUST TAKE|$)/
const BACKGROUND_TASK_LOG_URI = /(?:^|\r?\n)Task logs are available at:\s*(file:\/\/\S+)/
const TASK_EXIT_CODE = /(?:^|\r?\n)Command exited with code (-?\d+)\./
const TASK_CANCELED = /Task id "[^"]+" was cancell?ed\b/i
const TASK_FAILED = /Task id "[^"]+" failed\b/i
const TASK_SYSTEM_LOG_URI = /(?:^|\r?\n)Log:\s*(file:\/\/\S+)/

export type AntigravityStartedBackgroundTask = {
  taskId: string
  description?: string
  outputFile?: string
}

type AntigravityTaskOutcome = {
  taskState: 'done' | 'blocked' | 'idle'
  taskError?: string
  outputFile?: string
}

export function fileUriToLocalPath(uri: string | undefined): string | undefined {
  if (!uri?.startsWith('file://')) {
    return undefined
  }
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

export function summarizeCommandDescription(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const chosen = lines.find((line) => !line.startsWith('export ')) ?? lines[0]
  if (!chosen) {
    return undefined
  }
  const summary = chosen
    .replace(/\s*\\$/, '')
    .trim()
    .slice(0, 140)
    .trim()
  return summary || undefined
}

export function parseAntigravityBackgroundTaskStart(
  content: string | undefined
): AntigravityStartedBackgroundTask | undefined {
  if (!content?.includes(BACKGROUND_TASK_MARKER)) {
    return undefined
  }
  const taskId = BACKGROUND_TASK_ID.exec(content)?.[1]?.trim()
  if (!taskId) {
    return undefined
  }
  const description = summarizeCommandDescription(BACKGROUND_TASK_DESCRIPTION.exec(content)?.[1])
  const outputFile = fileUriToLocalPath(BACKGROUND_TASK_LOG_URI.exec(content)?.[1]?.trim())
  return {
    taskId,
    ...(description ? { description } : {}),
    ...(outputFile ? { outputFile } : {})
  }
}

export function parseAntigravityTaskOutcome(body: string): AntigravityTaskOutcome {
  const header = body.split(/\r?\nCommand output:\r?\n/)[0] ?? body
  let taskState: 'done' | 'blocked' | 'idle' = 'done'
  let taskError: string | undefined
  const exitMatch = TASK_EXIT_CODE.exec(header)
  if (TASK_CANCELED.test(header)) {
    taskState = 'idle'
  } else if (exitMatch) {
    const code = exitMatch[1]!
    if (Number(code) !== 0) {
      taskState = 'blocked'
      taskError = `Command exited with code ${code}`
    }
  } else if (TASK_FAILED.test(header)) {
    taskState = 'blocked'
  }
  const outputFile = fileUriToLocalPath(TASK_SYSTEM_LOG_URI.exec(body)?.[1]?.trim())
  return {
    taskState,
    ...(taskError ? { taskError } : {}),
    ...(outputFile ? { outputFile } : {})
  }
}
