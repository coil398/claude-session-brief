export type BriefSummary = {
  purpose: string
  status: string
  done: string[]
  decisions: string[]
  waiting: string[]
  next: string
  turn: number
}

export type RecentBriefTurn = {
  turn: number
  request: string
  purpose: string
}

export type HookActivity = {
  calls: number
  blocks: number
  additionalContext: number
  preventContinuation: number
  totalMs: number
  maxMs: number
  lastAt: number
}

export type AgentActivity = {
  id: string
  type: string
  description: string
  status: string
  startedAt?: number
  endedAt?: number
}

export type BackgroundTaskActivity = {
  id: string
  type: string
  description: string
  command?: string
  status: string
  startedAt?: number
  endedAt?: number
  sequence?: number
  sequenceEpoch?: string
  hostKnownSequence?: number
  hostKnownEpoch?: string
  latestSnapshotSequence?: number
  toolUseId?: string
  backgroundTaskId?: string
  timedOutAfterMs?: number
}

export type CodexJobStatus = 'running' | 'completed' | 'failed' | 'unavailable'

export type CodexJobActivity = {
  id: string
  runId: string
  workDir: string
  cwd?: string
  model?: string
  effort?: string
  sandbox?: string
  toolUseId?: string
  backgroundTaskId?: string
  status: CodexJobStatus
  startedAt: number
  runnerExited?: boolean
  runnerExitedAt?: number
  runnerPromptObserved?: boolean
  artifactProgress?: Record<string, { size: number; mtimeMs: number }>
  artifactProgressAt?: number
  artifactInspectionFailedAt?: number
  artifactInspectionFailureSource?: 'directory' | 'done' | 'progress'
  inspectionAttempted?: boolean
  endedAt?: number
  eventsSize?: number
  eventsMtimeMs?: number
  eventsUnavailableReason?: string
  eventLineCount: number
  lastEvent?: string
  totalTokens?: number
  exitCode?: number
  lastExcerpt?: string
  lastUnavailableReason?: string
  unavailableReason?: string
}

export type BriefUsage = {
  calls: number
  inputTokens: number
  outputTokens: number
  failures: number
}

export type SessionBriefState = {
  summary: BriefSummary | null
  latestAppliedTurn: number
  recentTurns: RecentBriefTurn[]
  hookStats: Record<string, HookActivity>
  configuredHookEvents: string[] | null
  agents: AgentActivity[]
  backgroundTasks: BackgroundTaskActivity[]
  codexJobs: CodexJobActivity[]
  usage: BriefUsage
}

declare module 'claude-code' {
  interface PluginState {
    'session-brief': { brief: SessionBriefState }
  }
}
