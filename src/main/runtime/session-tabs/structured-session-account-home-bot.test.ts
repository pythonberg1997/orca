import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type * as AcpLaunchCommand from '../../acp/launch/acp-launch-command'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './chat/structured-session-account-home'

const hostEnvironment = vi.hoisted(() => vi.fn(async () => ({ PATH: '', HOME: '/nowhere' })))
const selectHostHome = vi.hoisted(() => vi.fn())
vi.mock('./chat/structured-session-cli-writer-host', () => ({
  OrcaRuntimeWithStructuredSessionCliWriterHost: class {}
}))
vi.mock('../../orca-profiles/profile-storage-paths', async () => {
  const { tmpdir } = await import('node:os')
  return { getProfileUserDataPath: () => tmpdir() }
})
vi.mock('../agent-session/launch/structured-agent-launch-support', () => ({
  resolveHostStructuredAgentLaunchEnvironment: hostEnvironment
}))
vi.mock('../../acp/launch/acp-launch-command', async (importOriginal) => {
  const actual = await importOriginal<typeof AcpLaunchCommand>()
  return {
    ...actual,
    selectAcpHostAccountHome: selectHostHome
  }
})

afterEach(() => {
  hostEnvironment.mockClear()
  selectHostHome.mockReset()
})

abstract class AccountHomeRuntime extends OrcaRuntimeWithStructuredSessionAccountHome {
  resolveCreateHome(workspaceId: string) {
    const record = agentSessionRecordFixture()
    return this.structuredAgentAccountHomeResolver(
      'antigravity',
      '',
      'launch'
    )?.({ launchEnv: {}, location: { ...record.location, workspaceId } })
  }
}

function createRuntime(bot: { folderWorkspaceId: string }): AccountHomeRuntime {
  return Object.assign(Object.create(AccountHomeRuntime.prototype), {
    accounts: {},
    requireStore: () => ({ getSettings: () => ({}), getBots: () => [bot] }),
    structuredAgentLaunchEnv: () => ({})
  })
}

it("uses a compatible host agy for a bot's Antigravity chat, checking bot support", async () => {
  const bot = { folderWorkspaceId: 'zorblax-home' }
  const hostHome = { variable: 'GEMINI_HOME', path: '/Users/dev/.gemini' }
  selectHostHome.mockResolvedValueOnce(hostHome)

  await expect(
    createRuntime(bot).resolveCreateHome(folderWorkspaceKey(bot.folderWorkspaceId))
  ).resolves.toEqual(hostHome)
  expect(selectHostHome).toHaveBeenCalledWith(
    expect.objectContaining({ agent: 'antigravity' }),
    { PATH: '', HOME: '/nowhere' },
    tmpdir(),
    {},
    process.env,
    { bot: true }
  )
})

it("falls back to Orca's managed Antigravity server for a bot when host agy declines", async () => {
  const bot = { folderWorkspaceId: 'zorblax-home' }
  selectHostHome.mockResolvedValueOnce(null)
  const managed = { variable: 'GEMINI_HOME', path: join(tmpdir(), 'antigravity-chat') }

  await expect(
    createRuntime(bot).resolveCreateHome(folderWorkspaceKey(bot.folderWorkspaceId))
  ).resolves.toEqual(managed)
})
