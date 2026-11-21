import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { AcpAgentError } from '../acp/transport/acp-errors'
import {
  createAcpModelCatalogProbe,
  type AcpModelCatalogProbeDeps
} from '../acp/discovery/acp-model-catalog-probe'
import { resolveAcpLaunchInvocation } from '../acp/launch/acp-structured-launch-resolution'
import { AgentModelCatalogProbeError } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import {
  antigravityHostAccountHome,
  checkAntigravityHostAcp,
  forgetAntigravityHostAcpChecks,
  isCompatibleAntigravityHostAcp
} from './antigravity-host-acp'

const probe = vi.hoisted(() => ({
  initializeAntigravityAcp: vi.fn()
}))

vi.mock('./antigravity-acp-runtime-probe', () => ({
  initializeAntigravityAcp: probe.initializeAntigravityAcp
}))

const homes: string[] = []
afterEach(() => {
  probe.initializeAntigravityAcp.mockReset()
  forgetAntigravityHostAcpChecks()
  vi.restoreAllMocks()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

function makeFakeBinary(name = 'agy'): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bin-'))
  homes.push(dir)
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\n')
  return file
}

// agy 1.5.13's own initialize answer, trimmed to what the check reads.
function agyInitialize(meta: Record<string, unknown>): InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.13' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, list: {} },
      _meta: meta
    }
  }
}

describe('isCompatibleAntigravityHostAcp', () => {
  it("leaves an agy that can't append to its system prompt to Orca's own server", () => {
    expect(
      isCompatibleAntigravityHostAcp(
        agyInitialize({ antigravity: { tier: true, systemPrompt: { append: true } } })
      )
    ).toBe(true)
    expect(isCompatibleAntigravityHostAcp(agyInitialize({ antigravity: { tier: true } }))).toBe(
      false
    )
  })
})

describe('ANTIGRAVITY_LAUNCH_SPEC host backend environment', () => {
  it('scrubs alternate-case auto-update flags on Windows so they cannot shadow the uppercase entry', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const home = mkdtempSync(join(tmpdir(), 'agy-host-win-env-'))
    homes.push(home)
    const invocation = await resolveAcpLaunchInvocation(
      ANTIGRAVITY_LAUNCH_SPEC,
      antigravityHostAccountHome(home),
      {
        resolveEnvironment: async () => ({ PATH: '', agy_cli_disable_auto_update: 'false' }),
        resolveCommand: (command) => join(home, command),
        inheritedEnv: { agy_cli_disable_auto_update: 'false' },
        homePath: home,
        dataDirectory: home
      }
    )
    expect(invocation.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
    expect(invocation.env.agy_cli_disable_auto_update).toBeUndefined()
    expect(invocation.envToDelete).toContain('agy_cli_disable_auto_update')
    expect(invocation.envToDelete).not.toContain('AGY_CLI_DISABLE_AUTO_UPDATE')
  })

  it('overrides inherited auto-updates when listing host models', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-host-models-'))
    homes.push(home)
    const runListing = vi.fn<NonNullable<AcpModelCatalogProbeDeps['runListing']>>(
      async () => 'gemini-4-neon-high\tGemini 4 Neon (High)\n'
    )
    const probeModels = createAcpModelCatalogProbe(ANTIGRAVITY_LAUNCH_SPEC, {
      resolveEnvironment: async () => ({ PATH: '', AGY_CLI_DISABLE_AUTO_UPDATE: 'false' }),
      resolveCommand: (command) => join(home, command),
      probeVersion: async () => ({ version: '1.5.12' }),
      inheritedEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: 'false' },
      homePath: home,
      dataDirectory: home,
      runListing
    })
    const result = await probeModels(antigravityHostAccountHome(home), { workspacePath: home })
    expect(result.models).toHaveLength(1)
    expect(runListing).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['models'],
        env: expect.objectContaining({ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })
      }),
      expect.anything()
    )
  })
})

describe('checkAntigravityHostAcp', () => {
  it('uses a 15s probe budget and keeps a proven server ready across a revalidation timeout', async () => {
    const bin = makeFakeBinary('agy-reval')
    let now = 1_000_000
    const clock = () => now
    let attempt = 0
    probe.initializeAntigravityAcp.mockImplementation(
      async (
        _launch: (folder: string) => { command: string },
        timeoutMs: number,
        _signal: AbortSignal | undefined,
        check?: (
          connection: { listSessions: () => Promise<{ sessions: [] }> },
          initialized: InitializeResponse,
          folder: string
        ) => Promise<void>
      ) => {
        expect(timeoutMs).toBe(15_000)
        attempt += 1
        if (attempt === 1) {
          const initialized = agyInitialize({
            antigravity: { tier: true, systemPrompt: { append: true } }
          })
          await check?.({ listSessions: async () => ({ sessions: [] }) }, initialized, '/tmp')
          return initialized
        }
        if (attempt === 2) {
          throw new AgentModelCatalogProbeError('Antigravity listing timed out', 'timeout')
        }
        throw new AcpAgentError(-32000, 'Authentication required')
      }
    )

    await expect(checkAntigravityHostAcp(bin, {}, [], clock)).resolves.toBe('ready')

    // Past the 5m TTL: background revalidation hits a transient timeout but keeps readiness.
    now += 6 * 60_000
    await expect(checkAntigravityHostAcp(bin, {}, [], clock)).resolves.toBe('ready')
    await vi.waitFor(() => expect(attempt).toBe(2))
    await expect(checkAntigravityHostAcp(bin, {}, [], clock)).resolves.toBe('ready')

    // After the retry backoff, a real auth failure flips the cached server to signedOut.
    now += 11_000
    await expect(checkAntigravityHostAcp(bin, {}, [], clock)).resolves.toBe('ready')
    await vi.waitFor(() => expect(attempt).toBe(3))
    await expect(checkAntigravityHostAcp(bin, {}, [], clock)).resolves.toBe('signedOut')
  })

  it('rechecks an initial unanswered probe after 10s instead of caching it for 5 minutes', async () => {
    const bin = makeFakeBinary('agy-recover')
    let now = 1_000_000
    const clock = () => now
    let attempt = 0
    probe.initializeAntigravityAcp.mockImplementation(
      async (
        _launch: (folder: string) => { command: string },
        _timeoutMs: number,
        _signal: AbortSignal | undefined,
        check?: (
          connection: { listSessions: () => Promise<{ sessions: [] }> },
          initialized: InitializeResponse,
          folder: string
        ) => Promise<void>
      ) => {
        attempt += 1
        if (attempt === 1) {
          throw new AgentModelCatalogProbeError('Antigravity listing timed out', 'timeout')
        }
        const initialized = agyInitialize({
          antigravity: { tier: true, systemPrompt: { append: true } }
        })
        await check?.({ listSessions: async () => ({ sessions: [] }) }, initialized, '/tmp')
        return initialized
      }
    )

    await expect(checkAntigravityHostAcp(bin, {}, [], clock)).resolves.toBe('unanswered')
    now += 11_000
    await expect(checkAntigravityHostAcp(bin, {}, [], clock)).resolves.toBe('ready')
    expect(attempt).toBe(2)
  })
})
