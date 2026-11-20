import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { AgentModelCatalogProbeError } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { antigravityHostAcpReady, hasAgyCredential } from './antigravity-host-acp'

const probe = vi.hoisted(() => ({
  initializeAntigravityAcp: vi.fn()
}))

vi.mock('./antigravity-acp-runtime-probe', () => ({
  initializeAntigravityAcp: probe.initializeAntigravityAcp
}))

const homes: string[] = []
afterEach(() => {
  probe.initializeAntigravityAcp.mockReset()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

function makeFakeBinary(name = 'agy'): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bin-'))
  homes.push(dir)
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\n')
  return file
}

function compatibleInitialize(supportsSystemPromptAppend: boolean): InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.13' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, list: {} },
      ...(supportsSystemPromptAppend
        ? { _meta: { antigravity: { systemPrompt: { append: true } } } }
        : {})
    }
  }
}

describe('hasAgyCredential', () => {
  it('leaves a keyring-fallback marker to the ACP readiness probe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'))
    homes.push(home)
    const marker = join(home, '.gemini/antigravity-cli/cache/antigravity-keyring-unavailable')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '1794977777')
    await expect(hasAgyCredential(home)).resolves.toBe(true)
  })
})

describe('antigravityHostAcpReady', () => {
  it('requires systemPrompt.append for bot checks while allowing normal chats on older servers', async () => {
    const modernBin = makeFakeBinary('agy-modern')
    const legacyBin = makeFakeBinary('agy-legacy')
    probe.initializeAntigravityAcp.mockImplementation(
      async (
        launch: (folder: string) => { command: string },
        _timeoutMs: number,
        _signal: AbortSignal | undefined,
        check?: (
          connection: { listSessions: () => Promise<{ sessions: [] }> },
          initialized: InitializeResponse,
          folder: string
        ) => Promise<void>
      ) => {
        const initialized = compatibleInitialize(launch('/tmp').command === modernBin)
        await check?.({ listSessions: async () => ({ sessions: [] }) }, initialized, '/tmp')
        return initialized
      }
    )

    await expect(antigravityHostAcpReady(modernBin, {}, [])).resolves.toBe(true)
    await expect(
      antigravityHostAcpReady(modernBin, {}, [], { requireSystemPromptAppend: true })
    ).resolves.toBe(true)

    await expect(antigravityHostAcpReady(legacyBin, {}, [])).resolves.toBe(true)
    await expect(
      antigravityHostAcpReady(legacyBin, {}, [], { requireSystemPromptAppend: true })
    ).resolves.toBe(false)
    expect(probe.initializeAntigravityAcp).toHaveBeenCalledTimes(2)
  })

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
          const initialized = compatibleInitialize(true)
          await check?.({ listSessions: async () => ({ sessions: [] }) }, initialized, '/tmp')
          return initialized
        }
        if (attempt === 2) {
          throw new AgentModelCatalogProbeError('Antigravity listing timed out', 'timeout')
        }
        throw new Error('Authentication required')
      }
    )

    await expect(antigravityHostAcpReady(bin, {}, [], { now: clock })).resolves.toBe(true)

    // Past the 30m TTL: background revalidation hits a transient timeout but keeps readiness.
    now += 31 * 60_000
    await expect(antigravityHostAcpReady(bin, {}, [], { now: clock })).resolves.toBe(true)
    await vi.waitFor(() => expect(attempt).toBe(2))
    await expect(antigravityHostAcpReady(bin, {}, [], { now: clock })).resolves.toBe(true)

    // After the retry backoff, a real auth failure flips the cached server to not ready.
    now += 11_000
    await expect(antigravityHostAcpReady(bin, {}, [], { now: clock })).resolves.toBe(true)
    await vi.waitFor(() => expect(attempt).toBe(3))
    await expect(antigravityHostAcpReady(bin, {}, [], { now: clock })).resolves.toBe(false)
  })
})
