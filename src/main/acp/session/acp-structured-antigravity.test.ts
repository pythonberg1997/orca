import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
import { z } from 'zod'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { antigravityHostAccountHome } from '../../antigravity/antigravity-host-acp'
import { linkAntigravityUserSkills } from '../../antigravity/antigravity-chat-user-skills'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { createAcpModelCatalogProbe } from '../discovery/acp-model-catalog-probe'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
afterEach(closeProviderTimelineRigs)

it('elicits multi-question and write-in answers on a Full access host chat', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-elicit-'))
  onTestFinished(() => rm(userHome, { recursive: true, force: true }))
  const initSchema = z.object({
    clientCapabilities: z
      .object({ elicitation: z.object({ form: z.looseObject({}) }).optional() })
      .optional()
  })
  let elicited: unknown
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    launch: {
      args: ['acp', '--dangerously-skip-permissions'],
      fullAccess: true,
      env: { PATH: '/usr/bin', HOME: userHome, USERPROFILE: userHome }
    },
    script: (agent) =>
      agent.on('session/prompt', (prompt) => {
        const init = agent.frames.find((sent) => sent.method === 'initialize')
        if (!initSchema.safeParse(init?.params).data?.clientCapabilities?.elicitation?.form) {
          agent.reply(prompt, { stopReason: 'end_turn' })
          return
        }
        // Shape emitted by agy 1.5's buildQuestionElicitation (`qN` + `qN_other` companions).
        void agent
          .request('ask-1', 'elicitation/create', {
            sessionId: PROVIDER_SESSION,
            toolCallId: 'call_ask_1',
            mode: 'form',
            message: 'The agent has 3 questions.',
            requestedSchema: {
              type: 'object',
              properties: {
                q1: {
                  type: 'string',
                  title: 'Merge strategy?',
                  oneOf: [
                    { const: 'rebase', title: '(Recommended) Rebase' },
                    { const: 'merge', title: 'Merge commit' }
                  ]
                },
                q1_other: {
                  type: 'string',
                  title: 'Other',
                  description: 'Optional free-form answer to: Merge strategy?'
                },
                q2: {
                  type: 'array',
                  title: 'Checks to run?',
                  items: {
                    anyOf: [
                      { const: 'lint', title: 'Lint' },
                      { const: 'tc', title: 'Typecheck' }
                    ]
                  }
                },
                q2_other: {
                  type: 'string',
                  title: 'Other',
                  description: 'Optional free-form answer to: Checks to run?'
                },
                q3_other: {
                  type: 'string',
                  title: 'Target branch?'
                }
              }
            }
          })
          .then((reply) => {
            elicited = reply.result
            agent.reply(prompt, { stopReason: 'end_turn' })
          })
      })
  })
  await rig.acquire({ permissionMode: 'full-access' })
  await sendHello(rig, 'send-1')
  const question = await waitFor(async () => {
    const found = (await rig.rig.rows()).find((row) => row.body.kind === 'question')
    expect(found?.body).toMatchObject({
      kind: 'question',
      questions: [
        {
          id: 'q1',
          header: 'Merge strategy?',
          multiSelect: false,
          options: [
            { id: 'o1', label: '(Recommended) Rebase' },
            { id: 'o2', label: 'Merge commit' }
          ],
          freeTextQuestionId: 'q1'
        },
        {
          id: 'q2',
          header: 'Checks to run?',
          multiSelect: true,
          options: [
            { id: 'o1', label: 'Lint' },
            { id: 'o2', label: 'Typecheck' }
          ],
          freeTextQuestionId: 'q2'
        },
        {
          id: 'q3',
          header: 'Target branch?',
          multiSelect: false,
          options: [],
          freeTextQuestionId: 'q3'
        }
      ]
    })
    return found!
  })
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: question.itemId,
    kind: 'question',
    response: {
      kind: 'answers',
      answers: [
        { questionId: 'q1', optionIds: [], other: 'squash' },
        { questionId: 'q2', optionIds: ['o1', 'o2'], other: 'unit' },
        { questionId: 'q3', optionIds: [], other: 'main' }
      ]
    },
    fence: 1,
    commit: async () => {}
  })
  await rig.settle()
  expect(elicited).toEqual({
    action: 'accept',
    content: {
      q1_other: 'squash',
      q2: ['lint', 'tc'],
      q2_other: 'unit',
      q3_other: 'main'
    }
  })
})

it('derives per-model thinking efforts from availableModels and CLI model listings', async () => {
  const hostDiscovery = ANTIGRAVITY.hostBackend!.spec.modelDiscovery
  expect(hostDiscovery.kind).toBe('command')
  if (hostDiscovery.kind !== 'command') {
    throw new Error('expected command model discovery')
  }
  const parsedCli = hostDiscovery.parse(
    [
      'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
      'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
      'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
      'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
      'gemini-pro-orchestrator\tOrchestrator (Carbon)',
      'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
      'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
    ].join('\n')
  )
  expect(parsedCli).toEqual([
    {
      id: 'gemini-4-hydrogen',
      label: 'Gemini 4 Hydrogen',
      isDefault: false,
      defaultEffort: 'high',
      declaredDefaultEffort: 'high',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'XHigh' }
      ]
    },
    {
      id: 'gemini-pro-orchestrator',
      label: 'Orchestrator (Carbon)',
      isDefault: false,
      declaredDefaultEffort: null,
      efforts: []
    },
    {
      id: 'gemini-3.1-pro',
      label: 'Gemini 3.1 Pro',
      isDefault: false,
      defaultEffort: 'high',
      declaredDefaultEffort: 'high',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-oss-120b-medium',
      label: 'GPT-OSS 120B (Medium)',
      isDefault: false,
      declaredDefaultEffort: null,
      efforts: []
    }
  ])

  const sessionConfigOptions = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gemini-4-carbon',
      options: [
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
      ]
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', label: 'Low', name: 'Low' },
        { value: 'medium', label: 'Medium', name: 'Medium' },
        { value: 'high', label: 'High', name: 'High' }
      ]
    },
    fixture.session.configOptions[2]!
  ]
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-options-'))
  onTestFinished(() => rm(userHome, { recursive: true, force: true }))
  let replyConfigOptions = sessionConfigOptions
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    launch: { env: { PATH: '/usr/bin', HOME: userHome, USERPROFILE: userHome } },
    initialize: fixture.initialize,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: sessionConfigOptions,
          models: {
            currentModelId: 'gemini-4-carbon-medium',
            availableModels: [
              { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
              { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
              { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
              { modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
              { modelId: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
              { modelId: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
              { modelId: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
              { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
              { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
            ]
          }
        })
      )
      agent.on('session/set_config_option', (frame) =>
        agent.reply(frame, { configOptions: replyConfigOptions })
      )
    }
  })
  await rig.acquire()
  expect(rig.started().catalogListing?.models).toEqual([
    expect.objectContaining({
      id: 'gemini-4-carbon',
      defaultEffort: 'medium',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    }),
    expect.objectContaining({
      id: 'gemini-4-hydrogen',
      defaultEffort: 'high',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'XHigh' }
      ]
    }),
    expect.objectContaining({
      id: 'gemini-pro-orchestrator',
      declaredDefaultEffort: null,
      efforts: []
    }),
    expect.objectContaining({
      id: 'gpt-oss-120b-medium',
      declaredDefaultEffort: null,
      efforts: []
    })
  ])
  // Running model's live thought_level menu remains authoritative if a level is withdrawn.
  replyConfigOptions = sessionConfigOptions.map((option) =>
    option.id === 'thought_level' && 'options' in option && Array.isArray(option.options)
      ? {
          ...option,
          currentValue: 'high',
          options: option.options.filter((choice) => choice.value !== 'low')
        }
      : option
  )
  await rig.adapter.setOption({ sessionId: SESSION, fence: 1, key: 'effort', value: 'high' })
  const live = await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })
  expect(live.models.find((model) => model.id === 'gemini-4-carbon')).toMatchObject({
    efforts: [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ]
  })
  expect(live.models.find((model) => model.id === 'gemini-4-hydrogen')).toMatchObject({
    defaultEffort: 'high',
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'XHigh' }
    ]
  })
})

it('probes host agy models via CLI and links plugin skills into managed chat homes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-agy-probe-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const userHome = join(root, 'home')
  const managedHome = join(root, 'antigravity-chat')
  await mkdir(join(userHome, '.gemini', 'config', 'plugins', 'context7', 'skills', 'c7'), {
    recursive: true
  })
  await linkAntigravityUserSkills(managedHome, userHome)
  expect(
    (await stat(join(managedHome, 'config', 'plugins', 'context7', 'skills', 'c7'))).isDirectory()
  ).toBe(true)

  const seenArgs: string[][] = []
  const probe = createAcpModelCatalogProbe(ANTIGRAVITY, {
    homePath: userHome,
    dataDirectory: root,
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: userHome, USERPROFILE: userHome }),
    resolveCommand: (command) => `/mock/${command}`,
    probeVersion: async () => ({ status: 'ok', version: '1.5.2' }),
    runListing: async (launch) => {
      seenArgs.push(launch.args)
      return 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n'
    }
  })

  const listed = await probe(antigravityHostAccountHome(userHome))
  expect(seenArgs).toEqual([['models']])
  expect(listed).toEqual({
    origin: 'probe',
    models: [
      {
        id: 'gemini-3.1-pro',
        label: 'Gemini 3.1 Pro',
        isDefault: false,
        defaultEffort: 'high',
        declaredDefaultEffort: 'high',
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ]
  })
})

// agy 1.5.12 frames a failed request as "\n⚠ %s\n" in its own chunk, then replies end_turn.
const UNAUTHENTICATED =
  '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.'

const chunk = (text: string) => ({
  sessionId: PROVIDER_SESSION,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
})

it("fails the turn on agy's streamed 401 notice, shown as an error row and not as its reply", async () => {
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', chunk('The log said UNAUTHENTICATED (code 401).'))
        agent.notify('session/update', chunk(`\n${UNAUTHENTICATED}\n`))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
  })
  await rig.acquire()
  await sendHello(rig, 'send-1')
  const rows = await waitFor(async () => {
    const found = await rig.rig.rows()
    expect(found.some((row) => readAgentJournalTurn(row.body)?.state === 'completed')).toBe(true)
    return found
  })
  expect(rows.map((row) => readAgentJournalTurn(row.body)?.outcome).filter(Boolean)).toEqual([
    'failure'
  ])
  expect(rows.filter((row) => row.body.kind !== 'turn').map((row) => row.body)).toEqual([
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The log said UNAUTHENTICATED (code 401).' }]
    },
    { kind: 'status', tone: 'error', text: UNAUTHENTICATED }
  ])
})

it.each([
  'API key not valid. Please pass a valid API key.',
  'Agent execution error: failed to create Gemini client: failed to configure default GCP credentials for Vertex AI: credentials: could not find default credentials.'
])("fails the turn on the server's own credential notice: %s", async (notice) => {
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', chunk(notice))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
  })
  await rig.acquire()
  await sendHello(rig, 'send-1')
  const rows = await waitFor(async () => {
    const found = await rig.rig.rows()
    expect(found.some((row) => readAgentJournalTurn(row.body)?.state === 'completed')).toBe(true)
    return found
  })
  expect(rows.map((row) => readAgentJournalTurn(row.body)?.outcome).filter(Boolean)).toEqual([
    'failure'
  ])
  expect(rows.filter((row) => row.body.kind !== 'turn').map((row) => row.body)).toEqual([
    { kind: 'status', tone: 'error', text: notice }
  ])
})
