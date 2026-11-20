import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { selectAcpHostAccountHomeForCatalog } from './acp-launch-command'
import { acpLaunchSpecFor } from './acp-launch-registry'

const tempDirs: string[] = []
afterEach(() => {
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function makeHostEnv(): { binDir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-catalog-select-'))
  tempDirs.push(dir)
  const binName = process.platform === 'win32' ? 'agy.cmd' : 'agy'
  const binPath = join(dir, binName)
  writeFileSync(binPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
  if (process.platform !== 'win32') {
    chmodSync(binPath, 0o755)
  }
  return { binDir: dir, env: { PATH: dir, HOME: dir } }
}

describe('selectAcpHostAccountHomeForCatalog', () => {
  it('does not cache null host results and keeps bot and normal selections separate', async () => {
    const baseSpec = acpLaunchSpecFor('antigravity')!
    const hostHome = { variable: 'GEMINI_HOME', path: '/Users/dev/.gemini' }
    const select = vi
      .fn<NonNullable<AcpLaunchSpec['hostBackend']>['select']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(hostHome)
      .mockResolvedValueOnce(null)
    const spec: AcpLaunchSpec = {
      ...baseSpec,
      hostBackend: {
        ...baseSpec.hostBackend!,
        select
      }
    }
    const { env } = makeHostEnv()

    await expect(selectAcpHostAccountHomeForCatalog(spec, env, '/state', {}, 1_000)).resolves.toBe(
      null
    )
    await expect(
      selectAcpHostAccountHomeForCatalog(spec, env, '/state', {}, 1_100)
    ).resolves.toEqual(hostHome)
    await expect(
      selectAcpHostAccountHomeForCatalog(spec, env, '/state', {}, 1_200, { bot: true })
    ).resolves.toBe(null)

    expect(select).toHaveBeenCalledTimes(3)
    expect(select.mock.calls[0]?.[0].bot).toBeUndefined()
    expect(select.mock.calls[2]?.[0].bot).toBe(true)
  })
})
