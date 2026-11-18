import { ANTIGRAVITY_BASE_EFFORT_CHOICES } from '../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-antigravity'
import type { AgentSessionOptionChoice } from '../../shared/agent-session/agent-session-wire'
import type { AgentSessionModelOption } from '../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { AcpAdvertisedEfforts } from '../acp/acp-dialects/acp-dialect'
import type { ModelInfo } from '../acp/generated/acp-protocol.generated'

export const ANTIGRAVITY_MODEL_LISTING_ARGS = ['models'] as const

const EFFORT_ORDER: readonly AgentSessionOptionChoice[] = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  ...ANTIGRAVITY_BASE_EFFORT_CHOICES,
  { value: 'max', label: 'Max' }
]

const KNOWN_EFFORTS = new Set(EFFORT_ORDER.map((choice) => choice.value))
const TRAILING_EFFORT_LABEL = /\s*\((?:none|minimal|low|medium|high|xhigh|extra|max)\)\s*$/i

function splitCompositeModelId(modelId: string): { baseId: string; effort: string } | null {
  const dash = modelId.lastIndexOf('-')
  if (dash <= 0 || dash >= modelId.length - 1) {
    return null
  }
  const effort = modelId.slice(dash + 1)
  if (!KNOWN_EFFORTS.has(effort)) {
    return null
  }
  return { baseId: modelId.slice(0, dash), effort }
}

function buildEffortMenu(variantEfforts: readonly string[]): AcpAdvertisedEfforts {
  const present = new Set(variantEfforts)
  const defaultEffort = variantEfforts[0]
  return {
    efforts: EFFORT_ORDER.filter((choice) => present.has(choice.value)),
    ...(defaultEffort
      ? { defaultEffort, declaredDefaultEffort: defaultEffort }
      : { declaredDefaultEffort: null })
  }
}

/** Antigravity reports per-model thinking variants as `<modelId>-<effort>` entries in `availableModels`. */
export function antigravityFamilyEfforts(
  modelId: string,
  availableModels: readonly ModelInfo[]
): AcpAdvertisedEfforts | undefined {
  if (!availableModels.length) {
    return undefined
  }
  const prefix = `${modelId}-`
  const variantEfforts: string[] = []
  for (const entry of availableModels) {
    if (!entry.modelId.startsWith(prefix)) {
      continue
    }
    const suffix = entry.modelId.slice(prefix.length)
    if (KNOWN_EFFORTS.has(suffix) && !variantEfforts.includes(suffix)) {
      variantEfforts.push(suffix)
    }
  }
  if (variantEfforts.length > 0) {
    return buildEffortMenu(variantEfforts)
  }
  if (availableModels.some((entry) => entry.modelId === modelId)) {
    return { efforts: [], declaredDefaultEffort: null }
  }
  return undefined
}

/** Parse `agy models` tab-separated `<modelId>\t<label>` lines into base models and per-model efforts. */
export function parseAntigravityModelListing(stdout: string): AgentSessionModelOption[] {
  const rows: { modelId: string; label: string }[] = []
  const seenRowIds = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const tab = rawLine.indexOf('\t')
    if (tab <= 0) {
      continue
    }
    const modelId = rawLine.slice(0, tab).trim()
    const label = rawLine.slice(tab + 1).trim()
    if (!modelId || !label || seenRowIds.has(modelId)) {
      continue
    }
    seenRowIds.add(modelId)
    rows.push({ modelId, label })
  }

  const familyEfforts = new Map<string, string[]>()
  for (const row of rows) {
    const split = splitCompositeModelId(row.modelId)
    // Single-variant models (e.g. gpt-oss-120b-medium) or bare sibling IDs keep their literal ID.
    if (!split || seenRowIds.has(split.baseId)) {
      continue
    }
    const list = familyEfforts.get(split.baseId) ?? []
    if (!list.includes(split.effort)) {
      list.push(split.effort)
    }
    familyEfforts.set(split.baseId, list)
  }

  const emittedFamilies = new Set<string>()
  const models: AgentSessionModelOption[] = []
  for (const row of rows) {
    const split = splitCompositeModelId(row.modelId)
    const efforts = split ? familyEfforts.get(split.baseId) : undefined
    if (split && efforts && efforts.length >= 2) {
      if (emittedFamilies.has(split.baseId)) {
        continue
      }
      emittedFamilies.add(split.baseId)
      const menu = buildEffortMenu(efforts)
      models.push({
        id: split.baseId,
        label: row.label.replace(TRAILING_EFFORT_LABEL, '').trim() || split.baseId,
        isDefault: false,
        ...menu
      })
      continue
    }
    models.push({
      id: row.modelId,
      label: row.label,
      isDefault: false,
      efforts: [],
      declaredDefaultEffort: null
    })
  }
  return models
}
