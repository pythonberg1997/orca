import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { SessionConfigOption, SessionModelState } from '../generated/acp-protocol.generated'
import { acpSelectChoices } from './acp-select-choices'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export function projectAcpSessionModels(params: {
  modelOption: SelectOption | null
  effortOption: SelectOption | null
  models: SessionModelState | null
  currentModel: string | undefined
  modelEfforts: AcpDialect['modelEfforts']
}): AgentSessionModelOption[] {
  const { modelOption, effortOption, models, currentModel, modelEfforts } = params
  const sessionEfforts: AgentSessionOptionChoice[] = effortOption
    ? acpSelectChoices(effortOption).map((choice) => ({
        value: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : []
  const listed: { id: string; label: string; description?: string }[] = modelOption
    ? acpSelectChoices(modelOption).map((choice) => ({
        id: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : (models?.availableModels.map((model) => ({
        id: model.modelId,
        label: model.name,
        ...(model.description ? { description: model.description } : {})
      })) ?? [])
  const availableModels = models?.availableModels
  return listed.map((model) => {
    const modelInfo = availableModels?.find((entry) => entry.modelId === model.id)
    const advertised = modelEfforts?.({
      modelId: model.id,
      modelInfo,
      availableModels,
      hasModelConfigOption: modelOption !== null
    })
    // A current-session menu supplies no negative evidence about an unobserved model.
    const sessionMenu =
      model.id === currentModel
        ? { efforts: sessionEfforts }
        : (modelOption || effortOption) && !advertised
          ? { efforts: [], effortsKnown: false as const }
          : { efforts: [] }
    return {
      ...model,
      isDefault: false,
      // Fall back to the running session's menu when the advertised menu is empty.
      ...(advertised && (advertised.efforts.length > 0 || model.id !== currentModel)
        ? advertised
        : sessionMenu),
      ...(advertised?.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: advertised.declaredDefaultEffort }
        : {})
    }
  })
}
