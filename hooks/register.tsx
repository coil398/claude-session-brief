import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  ClassicEventName,
  ClassicResultOf,
  EngineInterface,
  Register,
  Timer,
} from 'claude-code'
import { createSerialLatestQueue } from './queue'
import {
  activeAgentCount,
  activeBackgroundTaskCount,
  activeCodexJobCount,
  applySummary,
  buildSummaryPrompt,
  clipText,
  configuredClassicEvents,
  createBackgroundTask,
  createCodexJob,
  formatDuration,
  formatHookOverview,
  formatHookStat,
  initialState,
  isValidCodexRunnerIdentity,
  mergeAgents,
  parseCodexRunnerCommand,
  parseSummary,
  reconcileBackgroundTasks,
  retainCodexJobs,
  truncateCells,
  updateCodexJobFromEvents,
  visibleHookStats,
  type SummarySnapshot,
} from './summary'
import type { SessionBriefState } from '../types'

const PLUGIN = 'session-brief'
const PANE_ID = 'session-brief-pane'
const PANE_TITLE = 'セッション概要'
const MAX_ACTIVITY_LINES = 40
const MAX_ACTIVITY_LINE_LENGTH = 180
const MAX_CODEX_FILE_BYTES = 4 * 1024 * 1024
const CODEX_POLL_INTERVAL_MS = 15000
const CODEX_NO_PROGRESS_TIMEOUT_MS = 30 * 60 * 1000
const CODEX_PROGRESS_ARTIFACTS = [
  'events.jsonl',
  'err.txt',
  'state.txt',
  'pid',
  'helper-done',
  'prompt.md',
] as const
const MAX_LAST_RESPONSE_LINES = 4
const MAX_LAST_RESPONSE_LINE_LENGTH = 180

type CodexArtifactProgress = NonNullable<SessionBriefState['codexJobs'][number]['artifactProgress']>

const brief = atom({ plugin: 'session-brief', key: 'brief' } as const, initialState())

type MainTurn = {
  number: number
  request: string
  activity: string[]
}

type IsCurrentSession = () => boolean
type AgentLifecycle = { id: string; type?: string; description?: string; status?: string }

type ClassicObservedResult = ClassicResultOf[ClassicEventName]

function recordAgentEvidence(
  id: string,
  excludedAgentIds: Set<string>,
  confirmedAgentIds: Set<string>,
): void {
  confirmedAgentIds.add(id)
  excludedAgentIds.delete(id)
}

function isExcludedAgent(
  id: string,
  excludedAgentIds: ReadonlySet<string>,
  confirmedAgentIds: ReadonlySet<string>,
): boolean {
  return excludedAgentIds.has(id) && !confirmedAgentIds.has(id)
}

function safeDebug($: EngineInterface, message: string): void {
  try {
    $.ui.log(`[session-brief] ${message}`, { to: 'debug' })
  } catch {
    // Debug logging must never affect a hook result.
  }
}

async function safeNow($: EngineInterface): Promise<number | undefined> {
  try {
    return await $.clock.now()
  } catch {
    return undefined
  }
}

async function updateIfCurrent(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  change: (state: SessionBriefState) => SessionBriefState,
): Promise<void> {
  if (!isCurrent()) return
  await update($, brief, state => isCurrent() ? change(state) : state)
}

function scheduleBackground(
  $: EngineInterface,
  label: string,
  task: () => Promise<void>,
): boolean {
  try {
    $.clock.after(0, () => {
      void task().catch(error => safeDebug($, `${label} failed: ${String(error)}`))
    })
    return true
  } catch (error) {
    safeDebug($, `${label} could not be scheduled: ${String(error)}`)
    return false
  }
}

async function refreshHookConfiguration(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
): Promise<void> {
  if (!isCurrent()) return
  try {
    const settings = await $.settings.read()
    const configured = configuredClassicEvents(settings)
    await updateIfCurrent($, isCurrent, state => ({ ...state, configuredHookEvents: configured }))
  } catch (error) {
    await updateIfCurrent($, isCurrent, state => ({ ...state, configuredHookEvents: null }))
    safeDebug($, `could not read configured settings hook events: ${String(error)}`)
  }
}

async function refreshAgents(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  lifecycle: AgentLifecycle | undefined,
  excludedAgentIds: ReadonlySet<string>,
  confirmedAgentIds: ReadonlySet<string>,
): Promise<void> {
  if (!isCurrent()) return
  let listed: readonly AgentInfo[] = []
  let listAvailable = true
  try {
    listed = await $.agent.list()
  } catch (error) {
    listAvailable = false
    safeDebug($, `could not read subagent list: ${String(error)}`)
  }
  if (!isCurrent()) return
  const now = await safeNow($)
  if (now === undefined || !isCurrent()) return
  await updateIfCurrent($, isCurrent, state => {
    const current = state.agents.filter(agent =>
      !isExcludedAgent(agent.id, excludedAgentIds, confirmedAgentIds),
    )
    const activeLifecycle = lifecycle &&
      !isExcludedAgent(lifecycle.id, excludedAgentIds, confirmedAgentIds)
      ? lifecycle
      : undefined
    if (!listAvailable && !activeLifecycle) {
      return current.length === state.agents.length ? state : { ...state, agents: current }
    }
    return {
      ...state,
      agents: mergeAgents(
        current,
        listAvailable
          ? listed.filter(agent =>
            !isExcludedAgent(agent.id, excludedAgentIds, confirmedAgentIds),
          )
          : [],
        now,
        activeLifecycle,
      ),
    }
  })
}

async function captureAgentIds(
  $: EngineInterface,
  phase: 'before' | 'after',
): Promise<Set<string> | undefined> {
  try {
    return new Set((await $.agent.list()).map(agent => agent.id))
  } catch (error) {
    safeDebug($, `could not capture agent IDs ${phase} summary completion: ${String(error)}`)
    return undefined
  }
}

async function excludeAgentsCreatedBySummary(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  before: ReadonlySet<string> | undefined,
  excludedAgentIds: Set<string>,
  confirmedAgentIds: ReadonlySet<string>,
): Promise<void> {
  const after = await captureAgentIds($, 'after')
  if (!isCurrent() || before === undefined || after === undefined) return
  const added = new Set([...after].filter(id =>
    !before.has(id) && !confirmedAgentIds.has(id),
  ))
  if (added.size === 0) return
  for (const id of added) excludedAgentIds.add(id)
  try {
    await updateIfCurrent($, isCurrent, state => {
      const agents = state.agents.filter(agent =>
        !added.has(agent.id) || confirmedAgentIds.has(agent.id),
      )
      return agents.length === state.agents.length ? state : { ...state, agents }
    })
  } catch (error) {
    safeDebug($, `could not remove summary-created agents from the brief: ${String(error)}`)
  }
}

function formatToolActivity(event: unknown): string {
  if (typeof event !== 'object' || event === null) return 'tool activity'
  const record = event as Record<string, unknown>
  const tool = typeof record.tool === 'string' ? record.tool : 'unknown tool'
  const details =
    typeof record.command === 'string'
      ? record.command
      : typeof record.file_path === 'string'
        ? record.file_path
        : typeof record.path === 'string'
          ? record.path
          : typeof record.pattern === 'string'
            ? record.pattern
            : ''
  return clipText(details ? `${tool}: ${details}` : tool, MAX_ACTIVITY_LINE_LENGTH)
}

function addClassicOutcome(result: unknown): {
  blocked: boolean
  additionalContext: number
  preventContinuation: boolean
} {
  if (typeof result !== 'object' || result === null) {
    return { blocked: false, additionalContext: 0, preventContinuation: false }
  }
  const value = result as Record<string, unknown>
  const blocked =
    (typeof value.block === 'string' && value.block.length > 0) ||
    (typeof value.deny === 'string' && value.deny.length > 0)
  const additionalContext = Array.isArray(value.additionalContext)
    ? value.additionalContext.length
    : 0
  return {
    blocked,
    additionalContext,
    preventContinuation: value.preventContinuation === true,
  }
}

type ToolCallOutcome = {
  denied: boolean
  isError: boolean
  backgroundTaskId?: string
  timedOutAfterMs?: number
}

function toolCallOutcome(result: unknown): ToolCallOutcome {
  if (typeof result !== 'object' || result === null) {
    return { denied: false, isError: false }
  }
  const value = result as Record<string, unknown>
  const isError = value.isError === true
  const nested = !isError && typeof value.result === 'object' && value.result !== null
    ? value.result as Record<string, unknown>
    : undefined
  return {
    denied: typeof value.deny === 'string',
    isError,
    backgroundTaskId: typeof nested?.backgroundTaskId === 'string'
      ? nested.backgroundTaskId
      : undefined,
    timedOutAfterMs: typeof nested?.timedOutAfterMs === 'number'
      ? nested.timedOutAfterMs
      : undefined,
  }
}

async function recordClassicActivity(
  $: EngineInterface,
  event: string,
  startedAt: number | undefined,
  result: unknown,
  isCurrent: IsCurrentSession,
): Promise<void> {
  try {
    if (startedAt === undefined || !isCurrent()) return
    const endedAt = await $.clock.now()
    if (!isCurrent()) return
    const elapsedMs = Math.max(0, endedAt - startedAt)
    const outcome = addClassicOutcome(result)
    await updateIfCurrent($, isCurrent, state => {
      const previous = state.hookStats[event] ?? {
        calls: 0,
        blocks: 0,
        additionalContext: 0,
        preventContinuation: 0,
        totalMs: 0,
        maxMs: 0,
        lastAt: endedAt,
      }
      return {
        ...state,
        hookStats: {
          ...state.hookStats,
          [event]: {
            calls: previous.calls + 1,
            blocks: previous.blocks + (outcome.blocked ? 1 : 0),
            additionalContext: previous.additionalContext + outcome.additionalContext,
            preventContinuation:
              previous.preventContinuation + (outcome.preventContinuation ? 1 : 0),
            totalMs: previous.totalMs + elapsedMs,
            maxMs: Math.max(previous.maxMs, elapsedMs),
            lastAt: endedAt,
          },
        },
      }
    })
  } catch (error) {
    safeDebug($, `could not record classic.${event} activity: ${String(error)}`)
  }
}

function lifecycleFromClassicEvent(
  event: string,
  input: unknown,
): AgentLifecycle | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = input as Record<string, unknown>
  const id = typeof value.agent_id === 'string' ? value.agent_id : undefined
  const type = typeof value.agent_type === 'string' ? value.agent_type : undefined
  if (!id || type === undefined) return undefined
  if (event === 'SubagentStart') {
    return {
      id,
      type,
      status: 'running',
    }
  }
  if (event === 'SubagentStop') {
    return {
      id,
      type,
      status: 'completed',
    }
  }
  return undefined
}

async function summarizeTurn(
  $: EngineInterface,
  snapshot: SummarySnapshot,
  isCurrent: () => boolean,
  excludedAgentIds: Set<string>,
  confirmedAgentIds: Set<string>,
): Promise<void> {
  if (!isCurrent()) return
  const surfaces = await $.session.surfaces()
  if (surfaces.length === 0 || !isCurrent()) return

  const state = await read($, brief)
  let language: string | undefined
  try {
    const settings = await $.settings.read()
    language = typeof settings.language === 'string' ? settings.language : undefined
  } catch (error) {
    safeDebug($, `could not read summary language setting: ${String(error)}`)
  }
  if (!isCurrent()) return

  const prompt = buildSummaryPrompt(snapshot, state.recentTurns, state.summary, language)
  await updateIfCurrent($, isCurrent, current => ({
    ...current,
    usage: { ...current.usage, calls: current.usage.calls + 1 },
  }))
  if (!isCurrent()) return

  try {
    const beforeAgentIds = await captureAgentIds($, 'before')
    let result: Awaited<ReturnType<EngineInterface['model']['complete']>>
    try {
      result = await $.model.complete({
        model: 'haiku',
        prompt,
        effort: 'low',
        maxTokens: 1000,
        timeoutMs: 12000,
      })
    } finally {
      await excludeAgentsCreatedBySummary(
        $,
        isCurrent,
        beforeAgentIds,
        excludedAgentIds,
        confirmedAgentIds,
      )
    }
    if (!isCurrent()) return

    await updateIfCurrent($, isCurrent, current => ({
      ...current,
      usage: {
        ...current.usage,
        inputTokens:
          current.usage.inputTokens +
          result.usage.input_tokens +
          result.usage.cache_read_input_tokens +
          result.usage.cache_creation_input_tokens,
        outputTokens: current.usage.outputTokens + result.usage.output_tokens,
        failures: current.usage.failures + (result.isAnswered ? 0 : 1),
      },
    }))
    if (!isCurrent()) return

    if (!result.isAnswered) {
      safeDebug($, `Haiku summary failed: ${result.reason}`)
      return
    }
    const parsed = parseSummary(result.text)
    if (!parsed.ok) {
      await updateIfCurrent($, isCurrent, current => ({
        ...current,
        usage: { ...current.usage, failures: current.usage.failures + 1 },
      }))
      safeDebug($, `summary JSON parse failed; kept previous summary: ${parsed.reason}`)
      return
    }
    await updateIfCurrent($, isCurrent, current =>
      applySummary(current, snapshot.turn, snapshot.request, parsed.value),
    )
  } catch (error) {
    if (!isCurrent()) return
    await updateIfCurrent($, isCurrent, current => ({
      ...current,
      usage: { ...current.usage, failures: current.usage.failures + 1 },
    }))
    safeDebug($, `Haiku summary request failed: ${String(error)}`)
  }
}

async function openPane($: EngineInterface): Promise<void> {
  const existing = await $.ui.panes()
  if (existing.some(pane => pane.id === PANE_ID)) return
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const existing = await $.ui.panes()
  if (existing.some(pane => pane.id === PANE_ID)) {
    await $.ui.close({ id: PANE_ID })
    return false
  }
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  return true
}

function formatAgentElapsed(agent: SessionBriefState['agents'][number], now: number): string {
  if (agent.startedAt === undefined) return '経過不明'
  return `経過 ${formatDuration(Math.max(0, (agent.endedAt ?? now) - agent.startedAt))}`
}

function formatBackgroundElapsed(
  task: SessionBriefState['backgroundTasks'][number],
  now: number,
): string {
  if (task.startedAt === undefined) return 'elapsed unknown'
  return `elapsed ${formatDuration(Math.max(0, (task.endedAt ?? now) - task.startedAt))}`
}

function formatBackgroundTask(task: SessionBriefState['backgroundTasks'][number], now: number): string {
  const description = task.description || task.command || task.id
  return `type:${task.type} · status:${task.status} · ${formatBackgroundElapsed(task, now)} · ${clipText(description, 160)}`
}

function formatCodexJobMetadata(job: SessionBriefState['codexJobs'][number], now: number): string {
  const elapsed = formatDuration(Math.max(0, (job.endedAt ?? now) - job.startedAt))
  return [
    `id:${truncateCells(job.runId, 6)}`,
    `model:${truncateCells(job.model ?? 'unknown', 8)}/${truncateCells(job.effort ?? 'unknown', 6)}`,
    `elapsed:${truncateCells(elapsed, 8)}`,
    `events:${truncateCells(String(job.eventLineCount), 4)}`,
    `tok:${truncateCells(String(job.totalTokens ?? '?'), 7)}`,
  ].join(' ')
}

function readBackgroundTaskSnapshot(input: unknown): {
  id: string
  type: string
  status: string
  description: string
  command?: string
}[] {
  if (typeof input !== 'object' || input === null) return []
  const backgroundTasks = (input as Record<string, unknown>).background_tasks
  if (!Array.isArray(backgroundTasks)) return []
  return backgroundTasks.filter((item): item is {
    id: string
    type: string
    status: string
    description: string
    command?: string
  } => {
    if (typeof item !== 'object' || item === null) return false
    const task = item as Record<string, unknown>
    return typeof task.id === 'string' &&
      typeof task.type === 'string' &&
      typeof task.status === 'string' &&
      typeof task.description === 'string' &&
      (task.command === undefined || typeof task.command === 'string')
  })
}

function hasBackgroundTaskSnapshot(input: unknown): boolean {
  return typeof input === 'object' && input !== null &&
    Array.isArray((input as Record<string, unknown>).background_tasks)
}

function codexArtifactPath(workDir: string, runId: string, suffix: string): string {
  const root = workDir.replace(/[\\/]+$/, '')
  return `${root}/codex-${runId}-${suffix}`
}

function lastResponseExcerpt(text: string): string {
  return text
    .split(/\r?\n/)
    .slice(0, MAX_LAST_RESPONSE_LINES)
    .map(line => clipText(line, MAX_LAST_RESPONSE_LINE_LENGTH))
    .filter(Boolean)
    .join(' · ')
}

function parseExitCode(text: string): number | undefined {
  const match = /^EXIT=(-?\d+)\r?\n?$/.exec(text)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

function markCodexUnavailable(
  job: SessionBriefState['codexJobs'][number],
  reason: string,
): SessionBriefState['codexJobs'][number] {
  return {
    ...job,
    status: 'unavailable',
    inspectionAttempted: true,
    unavailableReason: reason,
  }
}

class CodexStateWriteError extends Error {
  readonly original: unknown

  constructor(original: unknown) {
    super(String(original))
    this.name = 'CodexStateWriteError'
    this.original = original
  }
}

async function saveCodexJob(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  job: SessionBriefState['codexJobs'][number],
): Promise<void> {
  try {
    await updateIfCurrent($, isCurrent, state => ({
      ...state,
      codexJobs: retainCodexJobs(state.codexJobs.map(current => {
        if (current.id !== job.id || current.toolUseId !== job.toolUseId) return current
        const currentIsTerminal = current.status !== 'running'
        return {
          ...current,
          ...job,
          toolUseId: current.toolUseId ?? job.toolUseId,
          backgroundTaskId: current.backgroundTaskId ?? job.backgroundTaskId,
          runnerExited: current.runnerExited || job.runnerExited,
          inspectionAttempted: current.inspectionAttempted || job.inspectionAttempted,
          status: currentIsTerminal ? current.status : job.status,
          ...(currentIsTerminal ? {
            endedAt: current.endedAt,
            exitCode: current.exitCode,
            unavailableReason: current.unavailableReason,
          } : {}),
        }
      })),
    }))
  } catch (error) {
    throw new CodexStateWriteError(error)
  }
}

async function recordCodexInspectionFailure(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  job: SessionBriefState['codexJobs'][number],
  source: 'directory' | 'done' | 'progress',
): Promise<{ failedAt: number; timedOut: boolean } | undefined> {
  const now = await safeNow($)
  if (now === undefined) {
    safeDebug($, `could not check Codex inspection timeout for ${job.runId}`)
    return undefined
  }
  const failedAt = job.artifactInspectionFailedAt ?? now
  const observed = {
    ...job,
    artifactInspectionFailedAt: failedAt,
    artifactInspectionFailureSource: job.artifactInspectionFailureSource ?? source,
  }
  const timedOut = now - failedAt >= CODEX_NO_PROGRESS_TIMEOUT_MS
  if (timedOut) {
    await saveCodexJob(
      $,
      isCurrent,
      markCodexUnavailable(observed, 'runner artifact inspection unavailable for 30 min'),
    )
  } else if (
    job.artifactInspectionFailedAt === undefined ||
    job.artifactInspectionFailureSource === undefined
  ) {
    await saveCodexJob($, isCurrent, observed)
  }
  return { failedAt, timedOut }
}

async function resetCodexInspectionFailure(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  job: SessionBriefState['codexJobs'][number],
  source?: 'directory' | 'done' | 'progress',
): Promise<SessionBriefState['codexJobs'][number]> {
  if (job.artifactInspectionFailedAt === undefined) return job
  if (source !== undefined && job.artifactInspectionFailureSource !== source) return job
  const reset = {
    ...job,
    artifactInspectionFailedAt: undefined,
    artifactInspectionFailureSource: undefined,
  }
  await saveCodexJob($, isCurrent, reset)
  return reset
}

function hasCodexArtifactProgressChanged(
  previous: CodexArtifactProgress,
  current: CodexArtifactProgress,
): boolean {
  return CODEX_PROGRESS_ARTIFACTS.some(name => {
    const before = previous[name]
    const after = current[name]
    return before?.size !== after?.size || before?.mtimeMs !== after?.mtimeMs
  })
}

async function inspectExitedCodexProgress(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  job: SessionBriefState['codexJobs'][number],
  artifactRoot: string,
  preserveInspectionFailure = false,
): Promise<void> {
  const promptPath = codexArtifactPath(artifactRoot, job.runId, 'prompt.md')
  let promptExists: boolean
  try {
    promptExists = await $.fs.exists(promptPath)
  } catch (error) {
    safeDebug($, `could not check Codex prompt artifact for ${job.runId}: ${String(error)}`)
    await recordCodexInspectionFailure($, isCurrent, job, 'progress')
    return
  }
  const priorProgress = job.artifactProgress
  if (!promptExists && !job.runnerPromptObserved && priorProgress?.['prompt.md'] === undefined) {
    await saveCodexJob($, isCurrent, markCodexUnavailable(job, 'runner did not start'))
    return
  }
  if (promptExists && job.runnerPromptObserved !== true) {
    job = { ...job, runnerPromptObserved: true }
    await saveCodexJob($, isCurrent, job)
  }

  const progress: CodexArtifactProgress = {}
  let completeSnapshot = true
  for (const name of CODEX_PROGRESS_ARTIFACTS) {
    const path = codexArtifactPath(artifactRoot, job.runId, name)
    let exists: boolean
    if (name === 'prompt.md') {
      exists = promptExists
    } else {
      try {
        exists = await $.fs.exists(path)
      } catch (error) {
        completeSnapshot = false
        safeDebug($, `could not check Codex ${name} progress for ${job.runId}: ${String(error)}`)
        continue
      }
    }
    if (!exists) continue
    try {
      const stat = await $.fs.stat(path)
      progress[name] = { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch (error) {
      completeSnapshot = false
      safeDebug($, `could not stat Codex ${name} progress for ${job.runId}: ${String(error)}`)
    }
  }
  if (!completeSnapshot) {
    await recordCodexInspectionFailure($, isCurrent, job, 'progress')
    return
  }

  const now = await safeNow($)
  if (now === undefined) {
    safeDebug($, `could not check Codex progress timeout for ${job.runId}`)
    return
  }
  const changed = priorProgress !== undefined && hasCodexArtifactProgressChanged(priorProgress, progress)
  const newestArtifactMtime = Math.max(
    job.runnerExitedAt ?? now,
    ...Object.values(progress)
      .map(stat => stat.mtimeMs)
      .filter(mtimeMs => Number.isFinite(mtimeMs) && mtimeMs <= now),
  )
  const artifactProgressAt = changed
    ? now
    : job.artifactProgressAt ?? newestArtifactMtime
  const observed = {
    ...job,
    artifactProgress: progress,
    artifactProgressAt,
    artifactInspectionFailedAt: preserveInspectionFailure
      ? job.artifactInspectionFailedAt
      : undefined,
    artifactInspectionFailureSource: preserveInspectionFailure
      ? job.artifactInspectionFailureSource
      : undefined,
  }
  if (now - artifactProgressAt >= CODEX_NO_PROGRESS_TIMEOUT_MS) {
    await saveCodexJob($, isCurrent, markCodexUnavailable(observed, 'no runner progress for 30 min'))
    return
  }
  await saveCodexJob($, isCurrent, observed)
}

async function inspectCodexJob(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  initial: SessionBriefState['codexJobs'][number],
  exitInspection = false,
): Promise<void> {
  let job = initial
  let state: SessionBriefState
  try {
    state = await read($, brief)
  } catch (error) {
    safeDebug($, `Codex job ${initial.runId} state read failed; inspection will retry: ${String(error)}`)
    return
  }
  const latest = state.codexJobs.find(current => current.id === initial.id)
  if (!latest || latest.status !== 'running') return
  const runnerExited = latest.runnerExited || initial.runnerExited || exitInspection
  const runnerExitedAt = latest.runnerExitedAt ?? initial.runnerExitedAt ??
    (runnerExited ? await safeNow($) : undefined)
  job = {
    ...latest,
    runnerExited,
    runnerExitedAt,
    inspectionAttempted: latest.inspectionAttempted || initial.inspectionAttempted,
  }
  try {
    if (runnerExited && (latest.runnerExited !== true || latest.runnerExitedAt === undefined)) {
      await saveCodexJob($, isCurrent, job)
    }
    if (!isValidCodexRunnerIdentity(job.workDir, job.runId)) {
      await saveCodexJob($, isCurrent, markCodexUnavailable(job, 'invalid runner identity'))
      return
    }
    let workDirStat: Awaited<ReturnType<typeof $.fs.stat>>
    try {
      workDirStat = await $.fs.stat(job.workDir, { resolve: true })
    } catch (error) {
      if (job.runnerExited) {
        let workDirExists: boolean | undefined
        try {
          workDirExists = await $.fs.exists(job.workDir)
        } catch (existsError) {
          safeDebug($, `Codex job ${job.runId} work directory existence could not be checked after runner exit: ${String(existsError)}`)
        }
        if (workDirExists === false) {
          safeDebug($, `Codex job ${job.runId} work directory is missing after runner exit; runner did not start`)
          await saveCodexJob($, isCurrent, markCodexUnavailable(job, 'runner did not start'))
          return
        }
        safeDebug($, `Codex job ${job.runId} work directory could not be checked after runner exit: ${String(error)}`)
        await recordCodexInspectionFailure($, isCurrent, job, 'directory')
      } else {
        safeDebug($, `Codex job ${job.runId} work directory is not ready: ${String(error)}`)
      }
      return
    }
    if (workDirStat.kind !== 'dir' || typeof workDirStat.realPath !== 'string') {
      if (job.runnerExited) {
        safeDebug($, `Codex job ${job.runId} work directory is not ready after runner exit`)
        await recordCodexInspectionFailure($, isCurrent, job, 'directory')
      }
      return
    }
    if (job.runnerExited) {
      job = await resetCodexInspectionFailure($, isCurrent, job, 'directory')
    }
    const artifactRoot = workDirStat.realPath

    const eventsPath = codexArtifactPath(artifactRoot, job.runId, 'events.jsonl')
    let eventsExists = false
    try {
      eventsExists = await $.fs.exists(eventsPath)
    } catch (error) {
      job = { ...job, eventsUnavailableReason: `events artifact unavailable: ${String(error)}` }
      await saveCodexJob($, isCurrent, job)
    }
    if (eventsExists) {
      let stat: Awaited<ReturnType<typeof $.fs.stat>> | undefined
      try {
        stat = await $.fs.stat(eventsPath)
      } catch (error) {
        job = { ...job, eventsUnavailableReason: `events artifact unavailable: ${String(error)}` }
        await saveCodexJob($, isCurrent, job)
      }
      if (stat?.isLink || (stat && stat.kind !== 'file')) {
        job = { ...job, eventsUnavailableReason: 'events artifact is not a regular file' }
        await saveCodexJob($, isCurrent, job)
      } else if (stat && stat.size > MAX_CODEX_FILE_BYTES) {
        job = {
          ...job,
          eventsSize: stat.size,
          eventsMtimeMs: stat.mtimeMs,
          eventsUnavailableReason: 'events artifact exceeds the 4 MiB read limit',
        }
        await saveCodexJob($, isCurrent, job)
      } else if (stat && (
        stat.size !== job.eventsSize ||
        stat.mtimeMs !== job.eventsMtimeMs
      )) {
        try {
          const text = await $.fs.read(eventsPath)
          job = updateCodexJobFromEvents(job, text, stat.size, stat.mtimeMs)
          await saveCodexJob($, isCurrent, job)
        } catch (error) {
          job = { ...job, eventsUnavailableReason: `events artifact unavailable: ${String(error)}` }
          await saveCodexJob($, isCurrent, job)
        }
      }
    }

    const donePath = codexArtifactPath(artifactRoot, job.runId, 'done')
    const inspectProgressAfterDoneFailure = async (): Promise<void> => {
      if (!job.runnerExited) return
      const failure = await recordCodexInspectionFailure($, isCurrent, job, 'done')
      if (failure?.timedOut) return
      job = {
        ...job,
        artifactInspectionFailedAt: failure?.failedAt ?? job.artifactInspectionFailedAt,
        artifactInspectionFailureSource: job.artifactInspectionFailureSource ?? 'done',
      }
      await inspectExitedCodexProgress($, isCurrent, job, artifactRoot, true)
    }
    let doneExists: boolean
    try {
      doneExists = await $.fs.exists(donePath)
    } catch (error) {
      safeDebug($, `DONE lookup failed for Codex job ${job.runId}; inspection will retry: ${String(error)}`)
      await inspectProgressAfterDoneFailure()
      return
    }
    if (!doneExists) {
      if (job.runnerExited) {
        job = await resetCodexInspectionFailure($, isCurrent, job, 'done')
        await inspectExitedCodexProgress($, isCurrent, job, artifactRoot)
      }
      return
    }

    let doneStat: Awaited<ReturnType<typeof $.fs.stat>>
    try {
      doneStat = await $.fs.stat(donePath)
    } catch (error) {
      safeDebug($, `DONE stat failed for Codex job ${job.runId}; inspection will retry: ${String(error)}`)
      await inspectProgressAfterDoneFailure()
      return
    }
    if (doneStat.isLink || doneStat.kind !== 'file') {
      if (job.runnerExited) {
        job = await resetCodexInspectionFailure($, isCurrent, job, 'done')
        await inspectExitedCodexProgress($, isCurrent, job, artifactRoot)
      }
      return
    }
    if (doneStat.size > MAX_CODEX_FILE_BYTES) {
      if (job.runnerExited) {
        job = await resetCodexInspectionFailure($, isCurrent, job, 'done')
        await inspectExitedCodexProgress($, isCurrent, job, artifactRoot)
      }
      return
    }
    let doneText: string
    try {
      doneText = await $.fs.read(donePath)
    } catch (error) {
      safeDebug($, `DONE read failed for Codex job ${job.runId}; inspection will retry: ${String(error)}`)
      await inspectProgressAfterDoneFailure()
      return
    }
    if (job.runnerExited) job = await resetCodexInspectionFailure($, isCurrent, job, 'done')
    const exitCode = parseExitCode(doneText)
    if (exitCode === undefined) {
      if (job.runnerExited) await inspectExitedCodexProgress($, isCurrent, job, artifactRoot)
      return
    }
    const endedAt = await safeNow($)
    job = {
      ...job,
      status: exitCode === 0 ? 'completed' : 'failed',
      runnerExited: true,
      inspectionAttempted: true,
      exitCode,
      endedAt: endedAt ?? job.startedAt,
      unavailableReason: undefined,
    }
    await saveCodexJob($, isCurrent, job)

    const lastPath = codexArtifactPath(artifactRoot, job.runId, 'last.md')
    let lastExists = false
    try {
      lastExists = await $.fs.exists(lastPath)
    } catch (error) {
      job = { ...job, lastUnavailableReason: `last response unavailable: ${String(error)}` }
      await saveCodexJob($, isCurrent, job)
    }
    if (lastExists) {
      try {
        const lastStat = await $.fs.stat(lastPath)
        if (lastStat.isLink || lastStat.kind !== 'file' || lastStat.size > MAX_CODEX_FILE_BYTES) {
          throw new Error('last response artifact is not a readable regular file')
        }
        job = {
          ...job,
          lastExcerpt: lastResponseExcerpt(await $.fs.read(lastPath)),
          lastUnavailableReason: undefined,
        }
        await saveCodexJob($, isCurrent, job)
      } catch (error) {
        job = { ...job, lastUnavailableReason: `last response unavailable: ${String(error)}` }
        await saveCodexJob($, isCurrent, job)
      }
    }
  } catch (error) {
    if (error instanceof CodexStateWriteError) {
      safeDebug($, `Codex job ${job.runId} state update failed; inspection will retry: ${String(error.original)}`)
      return
    }
    await saveCodexJob($, isCurrent, markCodexUnavailable(job, String(error)))
    safeDebug($, `Codex job ${job.runId} monitoring unavailable: ${String(error)}`)
  }
}

const codexInspectionChains = new Map<string, Promise<void>>()

function queueCodexInspection(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  job: SessionBriefState['codexJobs'][number],
  exitInspection = false,
): Promise<void> {
  const previous = codexInspectionChains.get(job.id) ?? Promise.resolve()
  const inspection = previous
    .catch(() => {})
    .then(() => inspectCodexJob($, isCurrent, job, exitInspection))
  codexInspectionChains.set(job.id, inspection)
  void inspection.then(
    () => { if (codexInspectionChains.get(job.id) === inspection) codexInspectionChains.delete(job.id) },
    () => { if (codexInspectionChains.get(job.id) === inspection) codexInspectionChains.delete(job.id) },
  )
  return inspection
}

type CodexMonitorState = {
  timer?: Timer
  pollToken?: number
  nextPollToken: number
  ensureRevision: number
  pendingExitInspections: Set<string>
}

function codexExitInspectionKey(jobId: string, toolUseId: string | undefined): string {
  return `${jobId}\u0000${toolUseId ?? ''}`
}

function isTerminalBackgroundTask(task: SessionBriefState['backgroundTasks'][number]): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'killed'
}

function hasTerminalLinkedTask(
  job: SessionBriefState['codexJobs'][number],
  tasks: SessionBriefState['backgroundTasks'],
): boolean {
  return job.backgroundTaskId !== undefined && tasks.some(task =>
    task.backgroundTaskId === job.backgroundTaskId && isTerminalBackgroundTask(task),
  )
}

function cancelCodexMonitor(monitor: CodexMonitorState): void {
  monitor.timer?.cancel()
  monitor.timer = undefined
  monitor.pollToken = undefined
  monitor.pendingExitInspections.clear()
  monitor.ensureRevision += 1
}

async function pollCodexJobs(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  monitor: CodexMonitorState,
): Promise<void> {
  if (!isCurrent() || monitor.pollToken !== undefined) return
  const pollToken = ++monitor.nextPollToken
  monitor.pollToken = pollToken
  try {
    const state = await read($, brief)
    for (const job of state.codexJobs.filter(item => item.status === 'running')) {
      if (!isCurrent()) return
      const key = codexExitInspectionKey(job.id, job.toolUseId)
      const exitInspection = job.runnerExited === true ||
        monitor.pendingExitInspections.has(key) ||
        hasTerminalLinkedTask(job, state.backgroundTasks)
      await queueCodexInspection($, isCurrent, job, exitInspection)
      if (monitor.pendingExitInspections.has(key)) {
        try {
          const latest = await read($, brief)
          const saved = latest.codexJobs.find(item => item.id === job.id && item.toolUseId === job.toolUseId)
          if (!saved || saved.status !== 'running') monitor.pendingExitInspections.delete(key)
        } catch (error) {
          safeDebug($, `could not confirm Codex job ${job.runId} inspection: ${String(error)}`)
        }
      }
    }
  } catch (error) {
    safeDebug($, `Codex job polling failed: ${String(error)}`)
  } finally {
    if (monitor.pollToken === pollToken) {
      monitor.pollToken = undefined
      await ensureCodexMonitor($, isCurrent, monitor)
    }
  }
}

async function ensureCodexMonitor(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  monitor: CodexMonitorState,
): Promise<void> {
  if (!isCurrent()) return
  const revision = ++monitor.ensureRevision
  try {
    const state = await read($, brief)
    if (!isCurrent() || revision !== monitor.ensureRevision) return
    if (activeCodexJobCount(state.codexJobs) > 0) {
      if (!monitor.timer) {
        monitor.timer = $.clock.every(CODEX_POLL_INTERVAL_MS, () => {
          void pollCodexJobs($, isCurrent, monitor)
        })
      }
      return
    }
    monitor.timer?.cancel()
    monitor.timer = undefined
  } catch (error) {
    safeDebug($, `Codex job monitor could not be restored: ${String(error)}`)
  }
}

async function markCodexRunnerExited(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  jobId: string,
  toolUseId: string | undefined,
  monitor: CodexMonitorState,
): Promise<void> {
  const key = codexExitInspectionKey(jobId, toolUseId)
  monitor.pendingExitInspections.add(key)
  let currentJob: SessionBriefState['codexJobs'][number] | undefined
  try {
    const state = await read($, brief)
    currentJob = state.codexJobs.find(job =>
      job.id === jobId && job.status === 'running' && job.toolUseId === toolUseId,
    )
  } catch (error) {
    safeDebug($, `could not read Codex job ${jobId} after runner exit: ${String(error)}`)
    return
  }
  if (!currentJob) {
    monitor.pendingExitInspections.delete(key)
    return
  }
  const runnerExitedAt = currentJob.runnerExitedAt ?? await safeNow($)
  try {
    await updateIfCurrent($, isCurrent, state => ({
      ...state,
      codexJobs: state.codexJobs.map(job =>
        job.id === jobId && job.status === 'running' && job.toolUseId === toolUseId
          ? {
              ...job,
              runnerExited: true,
              runnerExitedAt: job.runnerExitedAt ?? runnerExitedAt,
              inspectionAttempted: false,
            }
          : job,
      ),
    }))
  } catch (error) {
    safeDebug($, `could not record Codex runner exit for ${currentJob.runId}; inspection will retry: ${String(error)}`)
  }
  await queueCodexInspection($, isCurrent, {
    ...currentJob,
    runnerExited: true,
    runnerExitedAt,
    inspectionAttempted: false,
  }, true)
  try {
    const latest = await read($, brief)
    const saved = latest.codexJobs.find(job => job.id === jobId && job.toolUseId === toolUseId)
    if (!saved || saved.status !== 'running') monitor.pendingExitInspections.delete(key)
  } catch (error) {
    safeDebug($, `could not confirm Codex job ${currentJob.runId} exit inspection: ${String(error)}`)
  }
  await ensureCodexMonitor($, isCurrent, monitor)
}

async function removeToolCallActivity(
  $: EngineInterface,
  isCurrent: IsCurrentSession,
  toolUseId: string | undefined,
  monitor: CodexMonitorState,
): Promise<void> {
  if (toolUseId === undefined) return
  await updateIfCurrent($, isCurrent, state => ({
    ...state,
    backgroundTasks: state.backgroundTasks.filter(task => task.toolUseId !== toolUseId),
    codexJobs: state.codexJobs.filter(job => job.toolUseId !== toolUseId),
  }))
  await ensureCodexMonitor($, isCurrent, monitor)
}

export const register: Register = on => {
  let sessionGeneration = 0
  let mainTurnNumber = 0
  let activeMainTurnId: string | undefined
  const mainTurns = new Map<string, MainTurn>()
  const summaryQueue = createSerialLatestQueue<SummarySnapshot>()
  const excludedAgentIds = new Set<string>()
  const confirmedAgentIds = new Set<string>()
  const codexMonitor: CodexMonitorState = {
    nextPollToken: 0,
    ensureRevision: 0,
    pendingExitInspections: new Set(),
  }
  let backgroundTaskSequence = 0
  // A fresh epoch makes persisted sequence values from an earlier module load older than this counter.
  const backgroundTaskSequenceEpoch = `${Date.now()}-${Math.random().toString(36).slice(2)}`

  on('session.start', async ($, e, next) => {
    const generation = sessionGeneration
    const isCurrent = () => generation === sessionGeneration
    await ensureCodexMonitor($, isCurrent, codexMonitor)
    try {
      await $.command.register({ name: 'brief', description: 'セッション概要を開閉します' })
    } catch (error) {
      safeDebug($, `the brief command could not be registered: ${String(error)}`)
    }
    const started = await next(e)
    scheduleBackground($, 'session setup', async () => {
      await refreshHookConfiguration($, isCurrent)
      await refreshAgents($, isCurrent, undefined, excludedAgentIds, confirmedAgentIds)
      await ensureCodexMonitor($, isCurrent, codexMonitor)
    })
    return started
  })

  on('command.run', { command: 'brief' }, async $ => {
    const opened = await togglePane($)
    return { text: opened ? 'セッション概要を開きました。' : 'セッション概要を閉じました。' }
  }).catch($ => {
    safeDebug($, 'the brief command could not open or close its pane')
    return { text: 'セッション概要を切り替えられませんでした。' }
  })

  on('turn.start', async ($, e, next) => {
    const monitorGeneration = sessionGeneration
    void ensureCodexMonitor($, () => monitorGeneration === sessionGeneration, codexMonitor)
    if (e.agentId === undefined) {
      const generation = sessionGeneration
      let currentState: SessionBriefState | undefined
      try {
        currentState = await read($, brief)
      } catch (error) {
        safeDebug($, `could not read the applied turn number: ${String(error)}`)
      }
      if (generation === sessionGeneration) {
        if (currentState) mainTurnNumber = Math.max(mainTurnNumber, currentState.latestAppliedTurn)
        const turn: MainTurn = {
          number: ++mainTurnNumber,
          request: clipText(e.text, 2200),
          activity: [],
        }
        mainTurns.set(e.turnId, turn)
        activeMainTurnId = e.turnId
      }
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    const generation = sessionGeneration
    const isCurrent = () => generation === sessionGeneration
    const isBash = e.tool === 'Bash'
    const bashCommand = e.tool === 'Bash' ? e.command : ''
    const isBackground = isBash && e.run_in_background === true
    const taskSequence = isBackground
      ? ++backgroundTaskSequence
      : undefined
    const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
    if (e.agentId === undefined && activeMainTurnId !== undefined) {
      const active = mainTurns.get(activeMainTurnId)
      if (active) {
        active.activity.push(formatToolActivity(e))
        if (active.activity.length > MAX_ACTIVITY_LINES) active.activity.shift()
      }
    }
    const codexArgs = isBash ? parseCodexRunnerCommand(e.command) : undefined
    const taskId = isBackground
      ? toolUseId ?? `shell-${backgroundTaskSequenceEpoch}-${taskSequence}`
      : undefined
    const codexJobId = codexArgs
      ? `${codexArgs.workDir.replace(/[\\/]+$/, '')}/codex-${codexArgs.runId}`
      : undefined
    let registeredAt: number | undefined
    const prepareActivity = async (): Promise<void> => {
      if ((!isBackground && !codexArgs) || !isCurrent()) return
      const now = await safeNow($)
      registeredAt = now
      await updateIfCurrent($, isCurrent, state => {
        let backgroundTasks = state.backgroundTasks
        if (isBackground && taskId) {
          backgroundTasks = [
            ...backgroundTasks,
            createBackgroundTask(
              taskId,
              e.command,
              now ?? 0,
              taskSequence,
              backgroundTaskSequenceEpoch,
              toolUseId,
            ),
          ].slice(-20)
        }
        let codexJobs = state.codexJobs
        if (codexArgs) {
          const newJob = createCodexJob(codexArgs, now ?? 0, toolUseId)
          const existingIndex = codexJobs.findIndex(job => job.id === newJob.id)
          codexJobs = existingIndex < 0
            ? retainCodexJobs([...codexJobs, newJob])
            : codexJobs
        }
        return { ...state, backgroundTasks, codexJobs }
      })
      if (codexArgs) await ensureCodexMonitor($, isCurrent, codexMonitor)
    }
    const recordBackgroundTaskId = async (
      backgroundTaskId: string,
      timedOutAfterMs: number | undefined,
    ): Promise<void> => {
      if (!isCurrent()) return
      const sequence = taskSequence ?? ++backgroundTaskSequence
      const hostKnownSequence = ++backgroundTaskSequence
      const hostKnownEpoch = backgroundTaskSequenceEpoch
      const now = await safeNow($)
      const recordId = taskId ?? toolUseId ?? backgroundTaskId
      const matchesCall = (task: SessionBriefState['backgroundTasks'][number]): boolean =>
        toolUseId !== undefined
          ? task.toolUseId === toolUseId
          : taskId !== undefined && task.id === taskId
      await updateIfCurrent($, isCurrent, state => {
        const callTasks = state.backgroundTasks.filter(matchesCall)
        const hostTasks = state.backgroundTasks.filter(task => task.backgroundTaskId === backgroundTaskId)
        const primaryTask = hostTasks[0] ?? callTasks[0]
        const alreadyKnownHostTask = primaryTask !== undefined &&
          primaryTask.backgroundTaskId === backgroundTaskId &&
          primaryTask.hostKnownSequence !== undefined &&
          Number.isSafeInteger(primaryTask.hostKnownSequence) &&
          primaryTask.hostKnownSequence > 0 &&
          primaryTask.hostKnownEpoch === backgroundTaskSequenceEpoch
        const mergedTask: SessionBriefState['backgroundTasks'][number] = primaryTask
          ? {
              ...primaryTask,
              id: hostTasks[0]?.id ?? primaryTask.id,
              description: primaryTask.description || callTasks[0]?.description || clipText(bashCommand, 240),
              command: callTasks[0]?.command ?? primaryTask.command ?? bashCommand,
              startedAt: callTasks[0]?.startedAt ?? primaryTask.startedAt,
              backgroundTaskId,
              hostKnownSequence: alreadyKnownHostTask ? primaryTask.hostKnownSequence : hostKnownSequence,
              hostKnownEpoch: alreadyKnownHostTask ? primaryTask.hostKnownEpoch : hostKnownEpoch,
              toolUseId: primaryTask.toolUseId ?? callTasks.find(task => task.toolUseId !== undefined)?.toolUseId ?? toolUseId,
              timedOutAfterMs: timedOutAfterMs ?? primaryTask.timedOutAfterMs ?? callTasks[0]?.timedOutAfterMs,
            }
          : {
              ...createBackgroundTask(
                recordId,
                bashCommand,
                registeredAt ?? now ?? 0,
                sequence,
                backgroundTaskSequenceEpoch,
                toolUseId,
              ),
              backgroundTaskId,
              hostKnownSequence,
              hostKnownEpoch,
              timedOutAfterMs,
            }
        const removedIds = new Set([...callTasks, ...hostTasks].map(task => task.id))
        const backgroundTasks = [
          ...state.backgroundTasks.filter(task => !removedIds.has(task.id)),
          mergedTask,
        ].slice(-20)
        const codexJobs = codexJobId === undefined
          ? state.codexJobs
          : state.codexJobs.map(job =>
              job.id === codexJobId && job.toolUseId === toolUseId
                ? { ...job, backgroundTaskId }
                : job,
            )
        return { ...state, backgroundTasks, codexJobs }
      })
    }
    let finishPreparation = () => {}
    const preparation = new Promise<void>(resolve => { finishPreparation = resolve })
    if (!scheduleBackground($, 'tool call registration', async () => {
      try {
        await prepareActivity()
      } catch (error) {
        safeDebug($, `could not register Bash activity: ${String(error)}`)
      } finally {
        finishPreparation()
      }
    })) finishPreparation()

    let result: ReturnType<typeof next>
    try {
      result = next(e)
    } catch (error) {
      scheduleBackground($, 'failed tool call cleanup', async () => {
        await preparation
        await removeToolCallActivity($, isCurrent, toolUseId, codexMonitor)
      })
      throw error
    }
    scheduleBackground($, 'tool call bookkeeping', async () => {
      await preparation
      let resolved: unknown
      try {
        resolved = await result
      } catch {
        await removeToolCallActivity($, isCurrent, toolUseId, codexMonitor)
        return
      }
      const outcome = toolCallOutcome(resolved)
      if (outcome.denied) {
        await removeToolCallActivity($, isCurrent, toolUseId, codexMonitor)
        return
      }
      if (outcome.backgroundTaskId) {
        await recordBackgroundTaskId(outcome.backgroundTaskId, outcome.timedOutAfterMs)
        if (codexArgs) await ensureCodexMonitor($, isCurrent, codexMonitor)
        return
      }
      if (isBackground && outcome.isError) {
        await removeToolCallActivity($, isCurrent, toolUseId, codexMonitor)
        return
      }
      if (isBackground) {
        if (codexArgs) await ensureCodexMonitor($, isCurrent, codexMonitor)
        return
      }
      if (codexJobId) {
        await markCodexRunnerExited($, isCurrent, codexJobId, toolUseId, codexMonitor)
      } else if (codexArgs) {
        await ensureCodexMonitor($, isCurrent, codexMonitor)
      }
    })
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const generation = sessionGeneration
    const isCurrent = () => generation === sessionGeneration
    const result = await next(e)
    if (typeof result.agentId === 'string' && isCurrent()) {
      recordAgentEvidence(result.agentId, excludedAgentIds, confirmedAgentIds)
      scheduleBackground($, 'subagent refresh', async () => {
        await refreshAgents($, isCurrent, {
          id: result.agentId!,
          type: e.subagentType,
          description: e.description,
        }, excludedAgentIds, confirmedAgentIds)
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    const generation = sessionGeneration
    const isCurrentSession = () => generation === sessionGeneration
    if (typeof e.agentId === 'string') {
      recordAgentEvidence(e.agentId, excludedAgentIds, confirmedAgentIds)
    }
    const result = next(e)
    if (typeof e.agentId === 'string') {
      const status = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      scheduleBackground($, 'subagent completion refresh', async () => {
        await refreshAgents(
          $,
          isCurrentSession,
          { id: e.agentId!, status },
          excludedAgentIds,
          confirmedAgentIds,
        )
      })
      return result
    }

    const active = mainTurns.get(e.turnId)
    mainTurns.delete(e.turnId)
    if (activeMainTurnId === e.turnId) activeMainTurnId = undefined
    const answer = clipText(e.answer, 2600)
    scheduleBackground($, 'completed main turn summary', async () => {
      let latestAppliedTurn = 0
      try {
        latestAppliedTurn = (await read($, brief)).latestAppliedTurn
      } catch (error) {
        safeDebug($, `could not align the completed turn number: ${String(error)}`)
      }
      if (!isCurrentSession()) return
      const turn = active && active.number > latestAppliedTurn
        ? active.number
        : Math.max(mainTurnNumber, latestAppliedTurn) + 1
      mainTurnNumber = Math.max(mainTurnNumber, latestAppliedTurn, turn)
      const snapshot: SummarySnapshot = {
        turn,
        request: active?.request ?? '',
        answer,
        activity: active?.activity.slice(-MAX_ACTIVITY_LINES) ?? [],
      }
      summaryQueue.enqueue({
        value: snapshot,
        schedule: callback => {
          const timer = $.clock.after(0, callback)
          return () => timer.cancel()
        },
        run: (value, isCurrentQueueTask) =>
          summarizeTurn(
            $,
            value,
            () => isCurrentSession() && isCurrentQueueTask(),
            excludedAgentIds,
            confirmedAgentIds,
          ),
        onError: error => safeDebug($, `summary queue failed: ${String(error)}`),
      })
    })
    return result
  })

  on('classic.*', ($, e, next) => {
    const generation = sessionGeneration
    const isCurrent = () => generation === sessionGeneration
    const event = next.event.slice('classic.'.length)
    const lifecycle = lifecycleFromClassicEvent(event, e)
    if (lifecycle) recordAgentEvidence(lifecycle.id, excludedAgentIds, confirmedAgentIds)
    const hasTaskSnapshot = (event === 'Stop' || event === 'SubagentStop') &&
      hasBackgroundTaskSnapshot(e)
    const snapshotSequence = hasTaskSnapshot ? ++backgroundTaskSequence : backgroundTaskSequence
    const snapshotEpoch = backgroundTaskSequenceEpoch
    const startedAt = safeNow($)
    let result: ReturnType<typeof next>
    try {
      result = next(e)
    } catch (error) {
      scheduleBackground($, `classic.${event} bookkeeping`, async () => {
        await recordClassicActivity($, event, await startedAt, undefined, isCurrent)
      })
      throw error
    }
    scheduleBackground($, `classic.${event} bookkeeping`, async () => {
      const [startedAtValue, resultValue] = await Promise.all([startedAt, result])
      await recordClassicActivity($, event, startedAtValue, resultValue, isCurrent)
      if (event === 'ConfigChange') {
        await refreshHookConfiguration($, isCurrent)
      }
      if (lifecycle) {
        await refreshAgents($, isCurrent, lifecycle, excludedAgentIds, confirmedAgentIds)
      }
      if (!hasTaskSnapshot || !isCurrent()) return

      const now = await safeNow($)
      if (now === undefined || !isCurrent()) return
      await updateIfCurrent($, isCurrent, state => {
        const backgroundTasks = reconcileBackgroundTasks(
          state.backgroundTasks,
          readBackgroundTaskSnapshot(e),
          now,
          snapshotSequence,
          snapshotEpoch,
        )
        return { ...state, backgroundTasks }
      })
      let latest: SessionBriefState
      try {
        latest = await read($, brief)
      } catch (error) {
        safeDebug($, `could not read background task state after classic.${event}: ${String(error)}`)
        return
      }
      const exitedJobs = latest.codexJobs.filter(job =>
        job.status === 'running' && hasTerminalLinkedTask(job, latest.backgroundTasks),
      )
      for (const job of exitedJobs) {
        await queueCodexInspection($, isCurrent, job, true)
        try {
          const latest = await read($, brief)
          const saved = latest.codexJobs.find(item => item.id === job.id && item.toolUseId === job.toolUseId)
          if (!saved || saved.status !== 'running') {
            codexMonitor.pendingExitInspections.delete(codexExitInspectionKey(job.id, job.toolUseId))
          }
        } catch (error) {
          safeDebug($, `could not confirm Codex job ${job.runId} task exit inspection: ${String(error)}`)
        }
      }
      await ensureCodexMonitor($, isCurrent, codexMonitor)
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    const result = next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      sessionGeneration += 1
      excludedAgentIds.clear()
      confirmedAgentIds.clear()
      cancelCodexMonitor(codexMonitor)
      summaryQueue.reset()
      mainTurnNumber = 0
      activeMainTurnId = undefined
      mainTurns.clear()
      try {
        await update($, brief, () => initialState())
      } catch (error) {
        safeDebug($, `could not reset session brief state: ${String(error)}`)
      }
      const generation = sessionGeneration
      const isCurrent = () => generation === sessionGeneration
      scheduleBackground($, 'session reset hook refresh', () => refreshHookConfiguration($, isCurrent))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const monitorGeneration = sessionGeneration
    void ensureCodexMonitor($, () => monitorGeneration === sessionGeneration, codexMonitor)
    if (e.props.hasSurvey) return next(e)
    let state: SessionBriefState
    try {
      state = await read($, brief)
    } catch (error) {
      safeDebug($, `could not read session brief state for the prompt band: ${String(error)}`)
      return next(e)
    }
    let paneOpen: boolean
    try {
      paneOpen = (await $.ui.panes()).some(pane => pane.id === PANE_ID)
    } catch (error) {
      safeDebug($, `could not read open panes for the prompt band: ${String(error)}`)
      return next(e)
    }
    const hookStats = visibleHookStats(state)
    const hasData =
      state.summary !== null ||
      state.agents.length > 0 ||
      state.backgroundTasks.length > 0 ||
      state.codexJobs.length > 0 ||
      hookStats.length > 0 ||
      state.usage.calls > 0
    if (!hasData || paneOpen) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const runningCodexJob = state.codexJobs
      .filter(job => job.status === 'running')
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    let overview =
      `agents ${activeAgentCount(state.agents)} running · background ${activeBackgroundTaskCount(state.backgroundTasks)} · Codex ${activeCodexJobCount(state.codexJobs)} · hooks ${formatHookOverview(state)}`
    if (runningCodexJob) {
      const now = await safeNow($) ?? 0
      overview =
        `codex · bg ${activeBackgroundTaskCount(state.backgroundTasks)} · jobs ${activeCodexJobCount(state.codexJobs)} · ${truncateCells(runningCodexJob.runId, 7)} ${truncateCells(runningCodexJob.model ?? '?', 10)}/${truncateCells(runningCodexJob.effort ?? '?', 6)} elapsed ${truncateCells(formatDuration(Math.max(0, now - runningCodexJob.startedAt)), 8)} ${truncateCells(String(runningCodexJob.totalTokens ?? '?'), 8)}t`
    }
    return (
      <Box flexDirection="column" key="session-brief-band">
        <Text wrap="truncate">
          {truncateCells(`目的: ${state.summary?.purpose ?? '要約待ち'}`, columns)}
        </Text>
        <Text wrap="truncate">
          {truncateCells(`現状: ${state.summary?.status ?? '要約待ち'}${e.props.isWorking ? ' (作業中)' : ''}`, columns)}
        </Text>
        <Box flexDirection="row">
          <Text dimColor wrap="truncate">
            {truncateCells(overview, Math.max(0, columns - 10))}
          </Text>
          <Button
            key="open-details"
            label=" · 詳細"
            plain
            onPress={async () => {
              try {
                await openPane($)
              } catch (error) {
                safeDebug($, `could not open Session Brief from the prompt band: ${String(error)}`)
              }
            }}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const monitorGeneration = sessionGeneration
    void ensureCodexMonitor($, () => monitorGeneration === sessionGeneration, codexMonitor)
    const { Box, Button, Text } = $.ui.resolve(e)
    let state: SessionBriefState
    try {
      state = await read($, brief)
    } catch (error) {
      safeDebug($, `could not read session brief state for the pane: ${String(error)}`)
      return next(e)
    }
    const now = await safeNow($) ?? 0
    const summary = state.summary
    const hookStats = visibleHookStats(state)
    const agentRows = state.agents.slice(-20)
    const backgroundRows = state.backgroundTasks.slice(-20)
    const codexRows = retainCodexJobs(state.codexJobs)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text size="heading" weight="semibold">セッション概要</Text>
          <Button
            key="close-brief"
            label="閉じる"
            plain
            onPress={() => $.ui.close({ id: PANE_ID })}
          />
        </Box>
        <Text weight="semibold">目的</Text>
        <Text>{summary?.purpose ?? '要約はまだありません。'}</Text>
        <Text weight="semibold">現状</Text>
        <Text>{summary?.status ?? '要約はまだありません。'}</Text>
        <Text weight="semibold">完了（最新5）</Text>
        {(summary?.done.length ?? 0) === 0
          ? <Text dimColor>なし</Text>
          : summary?.done.slice(-5).map((item, index) => <Text key={`done-${index}`}>• {item}</Text>)}
        <Text weight="semibold">決定（最新5）</Text>
        {(summary?.decisions.length ?? 0) === 0
          ? <Text dimColor>なし</Text>
          : summary?.decisions.slice(-5).map((item, index) => <Text key={`decision-${index}`}>• {item}</Text>)}
        <Text weight="semibold">あなた待ち（最新5）</Text>
        {(summary?.waiting.length ?? 0) === 0
          ? <Text dimColor>なし</Text>
          : summary?.waiting.slice(-5).map((item, index) => <Text key={`waiting-${index}`}>• {item}</Text>)}
        <Text weight="semibold">次の一手</Text>
        <Text>{summary?.next ?? '要約ができると表示されます。'}</Text>
        <Text weight="semibold">サブエージェント</Text>
        {agentRows.length === 0
          ? <Text dimColor>なし</Text>
          : agentRows.map(agent => (
              <Text key={`agent-${agent.id}`} wrap="truncate">
                {agent.type} · {agent.description || agent.id} · {agent.status} · {formatAgentElapsed(agent, now)}
              </Text>
            ))}
        <Text weight="semibold">バックグラウンド作業</Text>
        <Text>実行中 {activeBackgroundTaskCount(state.backgroundTasks)}件</Text>
        {backgroundRows.length === 0
          ? <Text dimColor>なし</Text>
          : backgroundRows.map(task => (
              <Text key={`background-${task.id}`} wrap="truncate">
                {formatBackgroundTask(task, now)}
              </Text>
            ))}
        <Text weight="semibold">Codex job</Text>
        <Text>実行中 {activeCodexJobCount(state.codexJobs)}件</Text>
        {codexRows.length === 0
          ? <Text dimColor>なし</Text>
          : codexRows.map(job => (
              <Text key={`codex-${job.id}`} wrap="truncate">
                {formatCodexJobMetadata(job, now)}
              </Text>
            ))}
        {codexRows.map(job => (
          <Text key={`codex-status-${job.id}`} wrap="truncate">
            status:{job.status}
          </Text>
        ))}
        {codexRows.map(job => job.unavailableReason ? (
          <Text key={`codex-unavailable-${job.id}`} wrap="truncate">
            Unavailable: {clipText(job.unavailableReason, 120)}
          </Text>
        ) : null)}
        {codexRows.map(job => job.exitCode === undefined ? null : (
          <Text key={`codex-exit-${job.id}`} wrap="truncate">
            EXIT={job.exitCode}
          </Text>
        ))}
        {codexRows.map(job => (
          <Text key={`codex-event-${job.id}`} wrap="truncate">
            Last event: {clipText(job.lastEvent ?? 'unavailable', 100)}
          </Text>
        ))}
        {codexRows.map(job => job.eventsUnavailableReason ? (
          <Text key={`codex-events-unavailable-${job.id}`} wrap="truncate">
            Events unavailable: {clipText(job.eventsUnavailableReason, 120)}
          </Text>
        ) : null)}
        {codexRows.map(job => (
          <Text key={`codex-last-${job.id}`} wrap="truncate">
            last.md: {clipText(job.lastExcerpt ?? 'unavailable', 120)}
          </Text>
        ))}
        {codexRows.map(job => job.lastUnavailableReason ? (
          <Text key={`codex-last-unavailable-${job.id}`} wrap="truncate">
            last.md unavailable: {clipText(job.lastUnavailableReason, 120)}
          </Text>
        ) : null)}
        {codexRows.map(job => job.sandbox ? (
          <Text key={`codex-sandbox-${job.id}`} wrap="truncate">
            Sandbox: {clipText(job.sandbox, 80)}
          </Text>
        ) : null)}
        <Text weight="semibold">settings hook 統計（イベント別）</Text>
        {hookStats.length === 0
          ? <Text dimColor>設定済みhookの活動はありません。</Text>
          : hookStats.map(([event, stat]) => <Text key={`hook-${event}`} wrap="truncate">{formatHookStat(event, stat)}</Text>)}
        <Text weight="semibold">Haiku usage 累計</Text>
        <Text>
          呼出 {state.usage.calls}回 · 入力 {state.usage.inputTokens} tokens · 出力 {state.usage.outputTokens} tokens · 失敗 {state.usage.failures}回
        </Text>
      </Box>
    )
  })
}
