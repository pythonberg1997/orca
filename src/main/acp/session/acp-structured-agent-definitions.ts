import type { AgentSessionCapabilities } from '../../../shared/agent-session/capabilities/agent-session-capabilities'
import type { StructuredAgentDefinition } from '../../native-chat/agent-session-wire/providers/structured-agent-definition'
import { acpLaunchSpecForAccount } from '../launch/acp-launch-command'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import {
  isManagedAgentCli,
  managedAgentCli
} from '../../managed-agent-cli/managed-agent-cli-registry'

export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

export const ACP_HANDLE_TRANSPORT = 'acp'

const ACP_OPTION_KEYS: ReadonlySet<string> = new Set(['model', 'effort'])

export function isAcpStructuredOptionKey(key: string): boolean {
  return ACP_OPTION_KEYS.has(key)
}

function acpCapabilities(
  spec: AcpLaunchSpec,
  compactionSpec: { compaction?: boolean; compactionInstructions?: boolean } = spec
): AgentSessionCapabilities {
  return {
    // ACP has no stable rewind or goal methods.
    rewind: false,
    // Imported tips need native terminal evidence; Grok's importer does not observe it yet.
    ...(spec.transcriptImport && ['omp', 'opencode', 'opencode2'].includes(spec.agent)
      ? { fork: 'tip' as const }
      : {}),
    compact: compactionSpec.compaction === true,
    compactInstructions: compactionSpec.compactionInstructions === true,
    threadGoal: false,
    contextUsage: true,
    // Narrowed by each agent's advertised startup capabilities.
    imagePrompts: true,
    steering: 'queue',
    approvalEnforcement: 'orca'
  }
}

export function acpStructuredAgentDefinition(spec: AcpLaunchSpec): StructuredAgentDefinition {
  const { agent, managedRuntime, hostBackend } = spec
  return {
    agent,
    handleTransport: ACP_HANDLE_TRANSPORT,
    ...spec.account.pin,
    capabilities: acpCapabilities(spec, {
      compaction: Boolean(spec.compaction || hostBackend?.spec.compaction),
      compactionInstructions: Boolean(
        spec.compactionInstructions || hostBackend?.spec.compactionInstructions
      )
    }),
    ...(hostBackend && {
      capabilitiesForAccount: (home) => acpCapabilities(spec, acpLaunchSpecForAccount(spec, home))
    }),
    ...(managedRuntime && { managedRuntime: () => managedRuntime.pin() !== null }),
    ...(isManagedAgentCli(agent) && { managedRuntime: () => managedAgentCli(agent).available() }),
    ...(hostBackend && { runsHostProgram: (home) => hostBackend.pins(home) }),
    restingOptions: {
      acceptsKey: (key) =>
        isAcpStructuredOptionKey(key) ||
        (spec.dialect.fastConfigId !== undefined && key === 'fastMode') ||
        (spec.dialect.interactionModes !== undefined && key === 'interactionMode'),
      // Populate catalogs from live agents.
      fallbackModels: () => null,
      effortDefaultsToModel: false,
      listedSelection: spec.dialect.listedSelection
    }
  }
}
