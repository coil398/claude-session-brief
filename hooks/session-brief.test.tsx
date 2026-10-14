import type { AgentInfo, HookFor, ModelCompleteResult, On, RenderPropsOf, ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import {
  applySummary,
  buildSummaryPrompt,
  initialState,
  mergeAgents,
  parseCodexRunnerCommand,
  parseSummary,
  reconcileBackgroundTasks,
  truncateCells,
} from './summary'
import type { SessionBriefState } from '../types'

const PLUGIN = 'session-brief'
const PANE_ID = 'session-brief-pane'
const BRIEF_REF = { plugin: PLUGIN, key: 'brief' } as const

function captureBriefState(on: On): () => SessionBriefState | undefined {
  let latest: SessionBriefState | undefined
  on('state.set', BRIEF_REF, (_$, event, next) => {
    latest = event.value
    return next(event)
  })
  return () => latest
}

function answered(text: string): ModelCompleteResult {
  return {
    isAnswered: true,
    text,
    usage: {
      input_tokens: 9,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  }
}

const summaryText = JSON.stringify({
  purpose: 'ユーザーの作業を引き継ぐ',
  status: '要約を表示する',
  done: ['目的を整理した'],
  decisions: ['日本語で表示する'],
  waiting: ['なし'],
  next: '実装を確認する',
})

function completeTurn(turnId: string, answer: string) {
  return {
    answer,
    durationMs: 1,
    isAborted: false,
    turnId,
    reason: 'answer' as const,
  }
}

function abovePromptProps(isWorking = false, bodyColumns = 84): RenderPropsOf['AbovePrompt'] {
  return {
    hasSurvey: false,
    isWorking,
    bodyColumns,
    maxRows: 3,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  }
}

function paneProps(): RenderPropsOf['Pane'] {
  return {
    title: 'セッション概要',
    isFocused: false,
    bodyColumns: 84,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  }
}

function isCodexArtifactPath(path: string): boolean {
  return path.endsWith('-events.jsonl') ||
    path.endsWith('-err.txt') ||
    path.endsWith('-state.txt') ||
    path.endsWith('-pid') ||
    path.endsWith('-helper-done') ||
    path.endsWith('-prompt.md') ||
    path.endsWith('-done') ||
    path.endsWith('-last.md')
}

function mockWorkDirStat(
  path: string,
  realPath = path,
): { kind: 'dir'; size: number; mtimeMs: number; isLink: boolean; realPath: string } {
  return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath }
}

function mockSummaryOperations(on: On, response: () => string): void {
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('settings.read', () => ({ value: {} }))
  on('model.complete', async () => ({ value: answered(response()) }))
}

function mockTurnOperations(on: On): void {
  on('turn.start', (_$, event) => ({ turnId: event.turnId }))
  on('turn.complete', (_$, event) => ({ text: event.answer }))
}

function mockSessionEnd(on: On): void {
  on('session.end', (_$, event) => ({ sessionId: event.sessionId }))
}

async function createSummary($: Engine, clock: MockClock): Promise<void> {
  await $.turn.start({ text: '引き継ぎを表示', turnId: 'seed-turn' })
  await $.turn.complete(completeTurn('seed-turn', '要約を表示してください'))
  await clock.settle()
}

test('band and pane render on terminal and desktop', async ($, on) => {
  on('tool.call', () => ({ result: 'started' }))
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  mockTurnOperations(on)
  mockSummaryOperations(on, () => summaryText)
  on('ui.panes', () => ({ value: [] }))
  await createSummary($, clock)
  expect(currentState()?.summary?.purpose).toBe('ユーザーの作業を引き継ぐ')

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/scripts/codex-run.py --work-dir /tmp/jobs --run-id run-1 --cwd /repo --model gpt-6-luna --effort medium',
    run_in_background: true,
  })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: abovePromptProps(true),
    })
    expect(await band.find({ type: 'Text', text: /目的:/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /作業中/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /codex · bg 1 · jobs 1 · run-1 gpt-6-luna\/medium elapsed \d+ms \?t/ })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'open-details' })).toBeDefined()

    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: PANE_ID,
      props: paneProps(),
    })
    expect(await pane.find({ type: 'Text', text: /完了（最新5）/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /決定（最新5）/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /あなた待ち（最新5）/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /サブエージェント/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'バックグラウンド作業' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Codex job' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /settings hook 統計/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Haiku usage 累計/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  }
})

test('long background and Codex values keep state and completion metadata visible', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const longRunId = 'r'.repeat(80)
  const longModel = 'm'.repeat(80)
  const completedRunId = 'done-1'
  const eventText: Record<string, string> = {
    [longRunId]: `${JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { total: { totalTokens: 77 } } },
    })}\n`,
    [completedRunId]: `${JSON.stringify({ method: 'thread/started', params: {} })}\n${JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { total: { totalTokens: 1234 } } },
    })}\n`,
  }
  const longCommand = `echo ${'long description '.repeat(40)}`

  on('tool.call', () => ({ result: 'started' }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) return { value: true }
    if (event.path.endsWith('-done')) return { value: event.path.includes(`codex-${completedRunId}-`) }
    if (event.path.endsWith('-last.md')) return { value: event.path.includes(`codex-${completedRunId}-`) }
    return { value: false }
  })
  on('fs.stat', (_$, event) => {
    if (!isCodexArtifactPath(event.path)) return { value: mockWorkDirStat(event.path) }
    const runId = event.path.includes(`codex-${longRunId}-`) ? longRunId : completedRunId
    if (event.path.endsWith('-events.jsonl')) {
      const text = eventText[runId] ?? ''
      return { value: { kind: 'file', size: text.length, mtimeMs: 1, isLink: false } }
    }
    if (event.path.endsWith('-done')) return { value: { kind: 'file', size: 7, mtimeMs: 2, isLink: false } }
    if (event.path.endsWith('-last.md')) return { value: { kind: 'file', size: 28, mtimeMs: 3, isLink: false } }
    return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) {
      const runId = event.path.includes(`codex-${longRunId}-`) ? longRunId : completedRunId
      return { value: eventText[runId] ?? '' }
    }
    if (event.path.endsWith('-done')) return { value: 'EXIT=0\n' }
    if (event.path.endsWith('-last.md')) return { value: 'Codex finished\nSaved result\n' }
    throw new Error('unexpected artifact read')
  })

  await $.tool.call({ tool: 'Bash', command: longCommand, run_in_background: true })
  await $.tool.call({
    tool: 'Bash',
    command: `python3 /opt/codex/codex-run.py --work-dir /tmp/long --run-id ${longRunId} --model ${longModel} --effort medium`,
    run_in_background: true,
  })
  await $.tool.call({
    tool: 'Bash',
    command: `python3 /opt/codex/codex-run.py --work-dir /tmp/completed --run-id ${completedRunId} --model gpt-6-luna --effort medium --sandbox read-only`,
    run_in_background: true,
  })
  await clock.advance(15000)
  await clock.settle()

  expect(currentState()?.backgroundTasks[0]?.description.length).toBeLessThanOrEqual(240)
  expect(currentState()?.codexJobs.find(job => job.runId === completedRunId)?.status).toBe('completed')
  expect(currentState()?.codexJobs.find(job => job.runId === completedRunId)?.totalTokens).toBe(1234)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: abovePromptProps(true),
    })
    expect(await band.find({ type: 'Text', text: /codex · bg 3 · jobs 1 · r{6}… m{9}…\/medium elapsed \d+\.\d+s 77t/ })).toBeDefined()

    const narrowBand = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: abovePromptProps(true, 30),
    })
    expect(await narrowBand.find({ type: 'Text', text: /^codex · bg 3/ })).toBeDefined()

    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: PANE_ID,
      props: paneProps(),
    })
    expect(await pane.find({ type: 'Text', text: 'バックグラウンド作業' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Codex job' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /type:shell · status:running · elapsed 15\.0s · echo long/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /id:done-1 model:gpt-6-l…\/medium elapsed:15\.0s events:2 tok:1234/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'status:completed' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'EXIT=0' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Last event: thread\/tokenUsage\/updated/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /last\.md: Codex finished · Saved result/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Sandbox: read-only/ })).toBeDefined()
    await pane.unmount()
    await narrowBand.unmount()
    await band.unmount()
  }
})

test('turn summaries are serialized and only the newest dirty turn is retried', async ($, on) => {
  const clock = mock.clock(on)
  mockTurnOperations(on)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('settings.read', () => ({ value: {} }))

  let callCount = 0
  let activeCalls = 0
  let maximumActiveCalls = 0
  let firstStartedResolve: () => void = () => {}
  let secondStartedResolve: () => void = () => {}
  let firstResolve: (result: ModelCompleteResult) => void = () => {}
  const firstStarted = new Promise<void>(resolve => { firstStartedResolve = resolve })
  const secondStarted = new Promise<void>(resolve => { secondStartedResolve = resolve })
  const prompts: string[] = []

  on('model.complete', async (_$, event) => {
    callCount += 1
    activeCalls += 1
    maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls)
    prompts.push(event.prompt)
    if (callCount === 1) {
      firstStartedResolve()
      const result = await new Promise<ModelCompleteResult>(resolve => { firstResolve = resolve })
      activeCalls -= 1
      return { value: result }
    }
    activeCalls -= 1
    secondStartedResolve()
    return { value: answered(summaryText) }
  })

  await $.turn.start({ text: 'first request', turnId: 'turn-1' })
  await $.turn.complete(completeTurn('turn-1', 'first answer'))
  await clock.settle()
  await firstStarted

  await $.turn.start({ text: 'middle request', turnId: 'turn-2' })
  await $.turn.complete(completeTurn('turn-2', 'middle answer'))
  await $.turn.start({ text: 'latest request', turnId: 'turn-3' })
  await $.turn.complete(completeTurn('turn-3', 'latest answer'))
  await clock.settle()
  expect(callCount).toBe(1)

  firstResolve(answered(summaryText))
  await secondStarted
  expect(callCount).toBe(2)
  expect(maximumActiveCalls).toBe(1)
  expect(prompts[1]).toContain('latest request')
  expect(prompts[1]).not.toContain('middle request')
})

test('headless turns never call the summary model', async ($, on) => {
  const clock = mock.clock(on)
  mockTurnOperations(on)
  let modelCalls = 0
  on('session.surfaces', () => ({ value: [] }))
  on('model.complete', async () => {
    modelCalls += 1
    return { value: answered(summaryText) }
  })
  await $.turn.start({ text: 'headless request', turnId: 'headless-turn' })
  await $.turn.complete(completeTurn('headless-turn', 'answer'))
  await clock.settle()
  expect(modelCalls).toBe(0)
})

test('classic settings hooks preserve next results and record activity', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const expected = { block: 'hold', additionalContext: ['keep this context'] }
  on('classic.UserPromptSubmit', async () => {
    await clock.advance(7)
    return expected
  })
  const result = await $.classic.UserPromptSubmit({ prompt: 'hello' })
  expect(result).toEqual(expected)
  await clock.settle()
  expect(currentState()?.hookStats.UserPromptSubmit?.calls).toBe(1)
  expect(currentState()?.hookStats.UserPromptSubmit?.blocks).toBe(1)
  expect(currentState()?.hookStats.UserPromptSubmit?.additionalContext).toBe(1)
  expect(currentState()?.hookStats.UserPromptSubmit?.maxMs).toBe(7)
})

test('background Bash tasks reconcile against Stop snapshots and exclude subagents', async ($, on) => {
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  on('tool.call', () => ({ result: { backgroundTaskId: 'shell-task-1', interrupted: false } }))

  await $.tool.call({
    tool: 'Bash',
    command: 'echo background work',
    run_in_background: true,
  })
  await clock.settle()
  const provisional = currentState()?.backgroundTasks[0]
  expect(provisional?.status).toBe('running')
  expect(provisional?.command).toBe('echo background work')

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      {
        id: 'shell-task-1',
        type: 'shell',
        status: 'running',
        description: 'background shell',
        command: 'echo background work',
      },
      {
        id: 'agent-task-1',
        type: 'subagent',
        status: 'running',
        description: 'subagent work',
        agent_type: 'general-purpose',
      },
    ],
  })
  await clock.settle()
  let tasks = currentState()?.backgroundTasks ?? []
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.id).toBe('shell-task-1')
  expect(tasks[0]?.status).toBe('running')
  expect(tasks[0]?.startedAt).toBe(provisional?.startedAt)

  await clock.advance(25)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.settle()
  tasks = currentState()?.backgroundTasks ?? []
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.status).toBe('completed')
  expect(tasks[0]?.endedAt).toBe(25)
})

test('a short host task completes on the first empty Stop snapshot after its id is known', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  on('tool.call', () => ({ result: { backgroundTaskId: 'short-codex-host', interrupted: false } }))
  on('classic.Stop', () => ({}))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 0, mtimeMs: 0, isLink: false }
    : mockWorkDirStat(event.path) }))

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/short-host --run-id short-host',
    run_in_background: true,
    tool_use_id: 'short-host-call',
  })
  await clock.settle()
  expect(currentState()?.backgroundTasks[0]?.status).toBe('running')
  expect(currentState()?.backgroundTasks[0]?.hostKnownSequence).toBeDefined()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.settle()

  expect(currentState()?.backgroundTasks[0]?.status).toBe('completed')
  expect(currentState()?.backgroundTasks[0]?.latestSnapshotSequence).toBeGreaterThan(
    currentState()?.backgroundTasks[0]?.hostKnownSequence ?? 0,
  )
  expect(currentState()?.codexJobs[0]?.status).toBe('unavailable')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBe('runner did not start')
})

test('an empty Stop snapshot captured before a host id is recorded does not finish the task', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let resolveToolCall: ((result: ToolCallResult) => void) | undefined
  const toolResult = new Promise<ToolCallResult>(resolve => { resolveToolCall = resolve })
  let releaseStop: () => void = () => {}
  let stopStartedResolve: () => void = () => {}
  let hostIdRecordedResolve: () => void = () => {}
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  const stopStarted = new Promise<void>(resolve => { stopStartedResolve = resolve })
  const hostIdRecorded = new Promise<void>(resolve => { hostIdRecordedResolve = resolve })
  on('tool.call', () => toolResult)
  on('classic.Stop', async () => {
    stopStartedResolve()
    await stopGate
    return {}
  })
  on('state.set', BRIEF_REF, (_$, event, next) => {
    if (event.value.backgroundTasks.some(task => task.backgroundTaskId === 'late-host-id')) {
      hostIdRecordedResolve()
    }
    return next(event)
  })

  const pendingCall = $.tool.call({
    tool: 'Bash',
    command: 'echo delayed host id',
    run_in_background: true,
    tool_use_id: 'late-host-id-call',
  })
  await clock.settle()
  const olderEmptyStop = $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await stopStarted

  const result = { result: { backgroundTaskId: 'late-host-id', interrupted: false } }
  resolveToolCall?.(result)
  expect(await pendingCall).toEqual(result)
  await hostIdRecorded
  releaseStop()
  await olderEmptyStop
  await clock.settle()

  const task = currentState()?.backgroundTasks[0]
  expect(task?.backgroundTaskId).toBe('late-host-id')
  expect(task?.status).toBe('running')
  expect(currentState()?.hookStats.Stop?.calls).toBe(1)
})

test('an empty Stop started while host id recording awaits the clock sees the known task', async ($, on) => {
  const currentState = captureBriefState(on)
  let gateNextClockNow = false
  let resolveClockNowStarted: () => void = () => {}
  let releaseClockNow: () => void = () => {}
  let resolveToolCall: ((result: ToolCallResult) => void) | undefined
  let resolveStopStarted: () => void = () => {}
  let releaseStop: () => void = () => {}
  let resolveHostIdSaved: () => void = () => {}
  const clockNowStarted = new Promise<void>(resolve => { resolveClockNowStarted = resolve })
  const clockNowGate = new Promise<void>(resolve => { releaseClockNow = resolve })
  const toolResult = new Promise<ToolCallResult>(resolve => { resolveToolCall = resolve })
  const stopStarted = new Promise<void>(resolve => { resolveStopStarted = resolve })
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  const hostIdSaved = new Promise<void>(resolve => { resolveHostIdSaved = resolve })
  const gatedClockOn = ((...args: unknown[]) => {
    const [pattern, hook] = args
    if (pattern === 'clock.now' && args.length === 2 && typeof hook === 'function') {
      const clockNowHook = hook as HookFor<'clock.now'>
      return on('clock.now', async ($$, event, next) => {
        if (gateNextClockNow) {
          gateNextClockNow = false
          resolveClockNowStarted()
          await clockNowGate
        }
        return clockNowHook($$, event, next)
      })
    }
    return (on as unknown as (...forwarded: unknown[]) => unknown)(...args)
  }) as unknown as On
  const clock = mock.clock(gatedClockOn)
  on('tool.call', () => toolResult)
  on('classic.Stop', async () => {
    resolveStopStarted()
    await stopGate
    return {}
  })
  on('state.set', BRIEF_REF, async (_$, event, next) => {
    const result = await next(event)
    if (event.value.backgroundTasks.some(task => task.backgroundTaskId === 'clock-race-host')) {
      resolveHostIdSaved()
    }
    return result
  })

  const pendingCall = $.tool.call({
    tool: 'Bash',
    command: 'echo clock race',
    run_in_background: true,
    tool_use_id: 'clock-race-call',
  })
  await clock.settle()
  expect(currentState()?.backgroundTasks[0]?.backgroundTaskId).toBeUndefined()
  expect(currentState()?.backgroundTasks[0]?.status).toBe('running')

  gateNextClockNow = true
  const result = { result: { backgroundTaskId: 'clock-race-host', interrupted: false } }
  resolveToolCall?.(result)
  expect(await pendingCall).toEqual(result)
  await clock.settle()
  await clockNowStarted

  const stopping = $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await stopStarted
  releaseClockNow()
  await hostIdSaved
  expect(currentState()?.backgroundTasks[0]?.hostKnownSequence).toBeDefined()

  releaseStop()
  await stopping
  await clock.settle()

  expect(currentState()?.backgroundTasks[0]?.backgroundTaskId).toBe('clock-race-host')
  expect(currentState()?.backgroundTasks[0]?.status).toBe('completed')
})

test('a partial persisted host observation gets a fresh sequence and epoch pair', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const restoredState: SessionBriefState = {
    ...initialState(),
    backgroundTasks: [{
      id: 'partial-host-call',
      type: 'shell',
      description: 'partial host observation',
      command: 'echo partial host observation',
      status: 'running',
      startedAt: 0,
      sequence: 1,
      sequenceEpoch: 'old-epoch',
      hostKnownSequence: 999,
      backgroundTaskId: 'partial-host',
      toolUseId: 'partial-host-call',
    }],
  }
  let restoreOnce = true
  on('state.get', BRIEF_REF, async (_$, event, next) => {
    if (!restoreOnce) return next(event)
    restoreOnce = false
    return { value: { value: restoredState, version: 1 } }
  })
  on('tool.call', () => ({ result: { backgroundTaskId: 'partial-host', interrupted: false } }))

  await $.tool.call({
    tool: 'Bash',
    command: 'echo partial host observation',
    run_in_background: true,
    tool_use_id: 'partial-host-call',
  })
  await clock.settle()

  const task = currentState()?.backgroundTasks.find(item => item.backgroundTaskId === 'partial-host')
  expect(currentState()?.backgroundTasks).toHaveLength(1)
  expect(task?.hostKnownSequence).not.toBe(999)
  expect(task?.hostKnownSequence).toBeGreaterThan(0)
  expect(task?.hostKnownEpoch).toBeDefined()
})

test('a Stop snapshot completes only background tasks created before it began', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  on('tool.call', (_$, event) => ({ result: {
    backgroundTaskId: event.tool === 'Bash' && event.command === 'echo older'
      ? 'older-host-task'
      : 'newer-host-task',
    interrupted: false,
  } }))

  let stopStartedResolve: () => void = () => {}
  let releaseStop: () => void = () => {}
  const stopStarted = new Promise<void>(resolve => { stopStartedResolve = resolve })
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  let stopCalls = 0
  on('classic.Stop', async () => {
    stopCalls += 1
    if (stopCalls === 2) {
      stopStartedResolve()
      await stopGate
    }
    return {}
  })

  await $.tool.call({ tool: 'Bash', command: 'echo older', run_in_background: true })
  await clock.settle()
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'older-host-task', type: 'shell', status: 'running',
      description: 'older task', command: 'echo older',
    }],
  })
  await clock.settle()
  const stopping = $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await stopStarted
  await clock.advance(25)
  await $.tool.call({ tool: 'Bash', command: 'echo newer', run_in_background: true })
  releaseStop()
  await stopping
  await clock.settle()

  const tasks = currentState()?.backgroundTasks ?? []
  expect(tasks).toHaveLength(2)
  expect(tasks[0]?.sequence).toBeLessThan(tasks[1]?.sequence ?? 0)
  expect(tasks[0]?.status).toBe('completed')
  expect(tasks[0]?.endedAt).toBe(25)
  expect(tasks[1]?.status).toBe('running')
  expect(tasks[1]?.startedAt).toBe(25)
})

test('an older Stop snapshot cannot restore a task updated by a newer snapshot', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  on('tool.call', () => ({ result: { backgroundTaskId: 'host-task-A', interrupted: false } }))

  let firstStopStartedResolve: () => void = () => {}
  let releaseFirstStop: () => void = () => {}
  const firstStopStarted = new Promise<void>(resolve => { firstStopStartedResolve = resolve })
  const firstStopGate = new Promise<void>(resolve => { releaseFirstStop = resolve })
  let stopCalls = 0
  on('classic.Stop', async () => {
    stopCalls += 1
    if (stopCalls === 2) {
      firstStopStartedResolve()
      await firstStopGate
    }
    return {}
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'echo task A',
    run_in_background: true,
  })
  await clock.settle()
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'host-task-A',
      type: 'shell',
      status: 'running',
      description: 'task A',
      command: 'echo task A',
    }],
  })
  await clock.settle()
  const firstStop = $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'host-task-A',
      type: 'shell',
      status: 'running',
      description: 'task A',
      command: 'echo task A',
    }],
  })
  await firstStopStarted

  await clock.advance(10)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.settle()
  const completedAt = currentState()?.backgroundTasks[0]?.endedAt
  expect(currentState()?.backgroundTasks[0]?.status).toBe('completed')
  expect(completedAt).toBe(10)

  await clock.advance(20)
  releaseFirstStop()
  await firstStop
  await clock.settle()
  const task = currentState()?.backgroundTasks[0]
  expect(currentState()?.backgroundTasks).toHaveLength(1)
  expect(task?.status).toBe('completed')
  expect(task?.backgroundTaskId).toBe('host-task-A')
  expect(task?.endedAt).toBe(completedAt)
})

test('Codex runner arguments parse quoted and unquoted commands', async () => {
  expect(parseCodexRunnerCommand(
    'python3 /opt/codex/scripts/codex-run.py --work-dir /tmp/jobs --run-id run-1 --cwd /repo --model gpt-6-luna --effort medium --sandbox read-only',
  )).toEqual({
    workDir: '/tmp/jobs',
    runId: 'run-1',
    cwd: '/repo',
    model: 'gpt-6-luna',
    effort: 'medium',
    sandbox: 'read-only',
  })
  expect(parseCodexRunnerCommand(
    'python3 "/opt/tools/codex-run.py" --work-dir="/tmp/codex jobs" --run-id run-2 --cwd "/repo with spaces" --model=gpt-6.1-sol --effort=high --sandbox read-only',
  )).toEqual({
    workDir: '/tmp/codex jobs',
    runId: 'run-2',
    cwd: '/repo with spaces',
    model: 'gpt-6.1-sol',
    effort: 'high',
    sandbox: 'read-only',
  })
  expect(parseCodexRunnerCommand('python3 other-script.py --run-id run-3')).toBeUndefined()
  expect(parseCodexRunnerCommand(
    'python3 /opt/codex/scripts/codex-run.py --work-dir relative/jobs --run-id run-4',
  )).toBeUndefined()
  expect(parseCodexRunnerCommand(
    'python3 /opt/codex/scripts/codex-run.py --work-dir /tmp/jobs --run-id ../outside',
  )).toBeUndefined()
  expect(parseCodexRunnerCommand(
    'python3 C:\\tools\\codex-run.py --work-dir C:\\jobs --run-id run_5',
  )?.workDir).toBe('C:\\jobs')
})

test('Codex job polling reads changed events, completion artifacts, then stops its timer', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const workDir = '/tmp/codex-jobs/../codex-jobs'
  let eventsText = ''
  let eventsMtimeMs = 1
  let doneExists = false
  let doneText = ''
  let lastExists = false
  let lastText = ''
  let existsCalls = 0
  let stateReads = 0

  on('state.get', BRIEF_REF, async (_$, event, next) => {
    stateReads += 1
    return next(event)
  })
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => {
    existsCalls += 1
    if (event.path.endsWith('-events.jsonl')) return { value: true }
    if (event.path.endsWith('-done')) return { value: doneExists }
    if (event.path.endsWith('-last.md')) return { value: lastExists }
    return { value: false }
  })
  on('fs.stat', (_$, event) => {
    if (!isCodexArtifactPath(event.path)) {
      const realPath = event.path === workDir ? '/tmp/codex-jobs' : event.path
      return { value: mockWorkDirStat(event.path, realPath) }
    }
    if (event.path.endsWith('-events.jsonl')) {
      return { value: { kind: 'file', size: eventsText.length, mtimeMs: eventsMtimeMs, isLink: false } }
    }
    if (event.path.endsWith('-done')) {
      return { value: { kind: 'file', size: doneText.length, mtimeMs: 2, isLink: false } }
    }
    if (event.path.endsWith('-last.md')) {
      return { value: { kind: 'file', size: lastText.length, mtimeMs: 3, isLink: false } }
    }
    return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) return { value: eventsText }
    if (event.path.endsWith('-done')) return { value: doneText }
    if (event.path.endsWith('-last.md')) return { value: lastText }
    throw new Error('unexpected artifact read')
  })

  await $.tool.call({
    tool: 'Bash',
    command: `python3 /opt/codex/scripts/codex-run.py --work-dir ${workDir} --run-id run-1 --cwd /repo --model gpt-6-luna --effort medium --sandbox read-only`,
    run_in_background: true,
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')

  eventsText = `${JSON.stringify({
    method: 'thread/tokenUsage/updated',
    params: { tokenUsage: { total: { totalTokens: 1234 } } },
  })}\n`
  eventsMtimeMs = 2
  await clock.advance(15000)
  expect(currentState()?.codexJobs[0]?.totalTokens).toBe(1234)
  expect(currentState()?.codexJobs[0]?.eventLineCount).toBe(1)

  doneExists = true
  doneText = 'EXIT=0\n'
  lastExists = true
  lastText = 'Codex finished\nResult saved\nExtra details\n'
  await clock.advance(15000)
  await clock.settle()
  const completed = currentState()?.codexJobs[0]
  expect(completed?.status).toBe('completed')
  expect(completed?.exitCode).toBe(0)
  expect(completed?.lastExcerpt).toBe('Codex finished · Result saved · Extra details')

  const callsAfterCompletion = existsCalls
  const stateReadsAfterCompletion = stateReads
  await clock.advance(15000)
  await clock.settle()
  expect(existsCalls).toBe(callsAfterCompletion)
  expect(stateReads).toBe(stateReadsAfterCompletion)
})

test('a stale Codex monitor state read cannot cancel a newer job timer', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  mockTurnOperations(on)
  on('tool.call', () => ({ result: 'started' }))

  let delayNextRead = true
  let staleReadStartedResolve: () => void = () => {}
  let releaseStaleRead: () => void = () => {}
  let staleReadFinishedResolve: () => void = () => {}
  const staleReadStarted = new Promise<void>(resolve => { staleReadStartedResolve = resolve })
  const staleReadGate = new Promise<void>(resolve => { releaseStaleRead = resolve })
  const staleReadFinished = new Promise<void>(resolve => { staleReadFinishedResolve = resolve })
  on('state.get', BRIEF_REF, async (_$, event, next) => {
    if (!delayNextRead) return next(event)
    delayNextRead = false
    const result = await next(event)
    staleReadStartedResolve()
    await staleReadGate
    staleReadFinishedResolve()
    return result
  })

  let eventChecks = 0
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) eventChecks += 1
    return { value: false }
  })
  on('fs.stat', (_$, event) => ({ value: mockWorkDirStat(event.path) }))

  await $.turn.start({ text: 'start a turn', turnId: 'monitor-stale-read' })
  await staleReadStarted
  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/new-job --run-id new-job',
    run_in_background: true,
  })
  releaseStaleRead()
  await staleReadFinished
  await clock.settle()
  await clock.advance(15000)

  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(eventChecks).toBeGreaterThan(0)
})

test('an old Codex poll cannot clear a newer poll token after clear', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  mockSessionEnd(on)
  on('tool.call', () => ({ result: 'started' }))

  let releaseOldStat: () => void = () => {}
  let releaseNewStat: () => void = () => {}
  let oldStatStartedResolve: () => void = () => {}
  let newStatStartedResolve: () => void = () => {}
  let oldDoneCheckedResolve: () => void = () => {}
  const oldStatGate = new Promise<void>(resolve => { releaseOldStat = resolve })
  const newStatGate = new Promise<void>(resolve => { releaseNewStat = resolve })
  const oldStatStarted = new Promise<void>(resolve => { oldStatStartedResolve = resolve })
  const newStatStarted = new Promise<void>(resolve => { newStatStartedResolve = resolve })
  const oldDoneChecked = new Promise<void>(resolve => { oldDoneCheckedResolve = resolve })
  let newStatCalls = 0

  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) return { value: true }
    if (event.path.includes('old-poll') && event.path.endsWith('-done')) {
      oldDoneCheckedResolve()
    }
    return { value: false }
  })
  on('fs.stat', async (_$, event) => {
    if (!isCodexArtifactPath(event.path)) return { value: mockWorkDirStat(event.path) }
    if (event.path.includes('old-poll')) {
      oldStatStartedResolve()
      await oldStatGate
    } else if (event.path.includes('new-poll')) {
      newStatCalls += 1
      newStatStartedResolve()
      await newStatGate
    }
    return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) return { value: '' }
    throw new Error('unexpected artifact read')
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/old-poll --run-id old-poll',
    run_in_background: true,
  })
  await clock.settle()
  const firstAdvance = clock.advance(15000)
  await oldStatStarted
  await $.session.end({
    reason: 'clear',
    sessionId: 'old-session',
    resume: { id: 'old-session' },
  })
  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/new-poll --run-id new-poll',
    run_in_background: true,
  })
  const secondAdvance = clock.advance(15000)
  await newStatStarted

  releaseOldStat()
  await oldDoneChecked
  await Promise.resolve()
  await Promise.resolve()
  await clock.advance(15000)
  expect(newStatCalls).toBe(1)

  releaseNewStat()
  await Promise.all([firstAdvance, secondAdvance])
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
})

test('Codex artifact read failures are swallowed and mark monitoring unavailable', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-events.jsonl') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 1, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', () => { throw new Error('read denied') })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/scripts/codex-run.py --work-dir /tmp/jobs --run-id denied --cwd /repo --model gpt-6-luna --effort medium',
  })
  await clock.advance(15000)
  const job = currentState()?.codexJobs[0]
  expect(job?.status).toBe('unavailable')
  expect(job?.eventLineCount).toBe(0)
  expect(job?.totalTokens).toBeUndefined()
})

test('Codex monitoring rejects symlink artifacts but keeps a valid events-linked DONE status', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const readPaths: string[] = []
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => {
    const path = event.path
    if (path.endsWith('-events.jsonl')) return { value: path.includes('events-link') }
    if (path.endsWith('-done')) return { value: path.includes('events-link') || path.includes('done-link') || path.includes('last-link') }
    if (path.endsWith('-last.md')) return { value: path.includes('last-link') }
    return { value: false }
  })
  on('fs.stat', (_$, event) => {
    const path = event.path
    if (!isCodexArtifactPath(path)) return { value: mockWorkDirStat(path) }
    const isLink =
      (path.includes('events-link') && path.endsWith('-events.jsonl')) ||
      (path.includes('done-link') && path.endsWith('-done')) ||
      (path.includes('last-link') && path.endsWith('-last.md'))
    return { value: { kind: 'file', size: 8, mtimeMs: 1, isLink } }
  })
  on('fs.read', (_$, event) => {
    readPaths.push(event.path)
    if (event.path.endsWith('-done')) return { value: 'EXIT=0\n' }
    throw new Error('a symlink artifact must not be read')
  })

  for (const runId of ['events-link', 'done-link', 'last-link']) {
    await $.tool.call({
      tool: 'Bash',
      command: `python3 /opt/codex/codex-run.py --work-dir /tmp/${runId} --run-id ${runId}`,
    })
  }
  await clock.advance(15000)
  await clock.settle()

  const jobs = currentState()?.codexJobs ?? []
  expect(jobs).toHaveLength(3)
  expect(jobs.find(job => job.runId === 'events-link')?.status).toBe('completed')
  expect(jobs.find(job => job.runId === 'events-link')?.exitCode).toBe(0)
  expect(jobs.find(job => job.runId === 'events-link')?.eventsUnavailableReason).toContain('not a regular file')
  expect(jobs.find(job => job.runId === 'done-link')?.status).toBe('unavailable')
  expect(jobs.find(job => job.runId === 'last-link')?.status).toBe('completed')
  expect(jobs.find(job => job.runId === 'last-link')?.exitCode).toBe(0)
  expect(jobs.find(job => job.runId === 'last-link')?.lastUnavailableReason).toContain('last response unavailable')
  expect(readPaths.sort()).toEqual([
    '/tmp/events-link/codex-events-link-done',
    '/tmp/last-link/codex-last-link-done',
  ])

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(),
  })
  expect(await pane.find({ type: 'Text', text: 'status:unavailable' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'status:completed' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'EXIT=0' })).toBeDefined()
  await pane.unmount()
})

test('Codex inspection preserves a host task id recorded while events are being read', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let resolveToolCall: ((result: ToolCallResult) => void) | undefined
  const toolResult = new Promise<ToolCallResult>(resolve => { resolveToolCall = resolve })
  let releaseEventsRead: () => void = () => {}
  let eventsReadStartedResolve: () => void = () => {}
  const eventsReadGate = new Promise<void>(resolve => { releaseEventsRead = resolve })
  const eventsReadStarted = new Promise<void>(resolve => { eventsReadStartedResolve = resolve })
  let eventsReadCalls = 0
  on('tool.call', () => toolResult)
  on('classic.Stop', () => ({}))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-events.jsonl') || event.path.endsWith('-prompt.md') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 0, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', async (_$, event) => {
    if (!event.path.endsWith('-events.jsonl')) throw new Error('unexpected artifact read')
    eventsReadCalls += 1
    if (eventsReadCalls === 1) {
      eventsReadStartedResolve()
      await eventsReadGate
    }
    return { value: '' }
  })

  const pendingCall = $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/events-host-race --run-id events-host-race',
    run_in_background: true,
    tool_use_id: 'events-host-race-call',
  })
  await clock.settle()
  const firstPoll = clock.advance(15000)
  await eventsReadStarted

  const resolved = { result: { backgroundTaskId: 'events-host-race-host', interrupted: false } }
  resolveToolCall?.(resolved)
  expect(await pendingCall).toEqual(resolved)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.backgroundTaskId).toBe('events-host-race-host')

  releaseEventsRead()
  await firstPoll
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.backgroundTaskId).toBe('events-host-race-host')
  expect(currentState()?.codexJobs[0]?.status).toBe('running')

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'events-host-race-host',
      type: 'shell',
      status: 'failed',
      description: 'Codex task failed',
      command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/events-host-race --run-id events-host-race',
    }],
  })
  await clock.settle()

  expect(currentState()?.backgroundTasks[0]?.status).toBe('failed')
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.runnerExited).toBe(true)
  expect(currentState()?.codexJobs[0]?.backgroundTaskId).toBe('events-host-race-host')
})

test('invalid restored Codex jobs are rejected before filesystem access', async ($, on) => {
  const clock = mock.clock(on)
  const restoredState: SessionBriefState = {
    ...initialState(),
    codexJobs: [
      {
        id: 'restore-relative-work-dir',
        runId: 'valid-id',
        workDir: 'relative/jobs',
        status: 'running',
        startedAt: 0,
        eventLineCount: 0,
      },
      {
        id: 'restore-invalid-run-id',
        runId: '../outside',
        workDir: '/tmp/jobs',
        status: 'running',
        startedAt: 0,
        eventLineCount: 0,
      },
    ],
  }
  let filesystemCalls = 0
  on('state.get', BRIEF_REF, () => ({ value: { value: restoredState, version: 1 } }))
  on('fs.exists', () => { filesystemCalls += 1; return { value: false } })
  on('fs.stat', () => { filesystemCalls += 1; return { value: mockWorkDirStat('/tmp/jobs') } })
  on('fs.read', () => { filesystemCalls += 1; return { value: '' } })

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(),
  })
  await clock.settle()
  await clock.advance(15000)
  await clock.settle()
  expect(filesystemCalls).toBe(0)
  await pane.unmount()
})

test('Codex monitoring uses the resolved work directory as the artifact base', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const workDir = '/tmp/link-parent/jobs'
  const artifactPaths: string[] = []
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-events.jsonl') || event.path.endsWith('-done') }))
  on('fs.stat', (_$, event) => {
    if (event.path === workDir) {
      return { value: { ...mockWorkDirStat(workDir), realPath: '/tmp/real-parent/jobs' } }
    }
    artifactPaths.push(event.path)
    return { value: { kind: 'file', size: 8, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', (_$, event) => {
    artifactPaths.push(event.path)
    return { value: event.path.endsWith('-done') ? 'EXIT=0\n' : '' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: `python3 /opt/codex/codex-run.py --work-dir ${workDir} --run-id symlink-parent`,
  })
  await clock.advance(15000)
  await clock.settle()

  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
  expect(artifactPaths.length).toBeGreaterThan(0)
  expect(artifactPaths.every(path => path.startsWith('/tmp/real-parent/jobs/'))).toBe(true)
})

test('invalid summary JSON keeps the previous summary', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  mockTurnOperations(on)
  let response = summaryText
  mockSummaryOperations(on, () => response)
  await createSummary($, clock)
  const before = currentState()
  expect(before?.summary).toBeDefined()

  response = 'not JSON'
  await $.turn.start({ text: 'new request', turnId: 'parse-failure-turn' })
  await $.turn.complete(completeTurn('parse-failure-turn', 'new answer'))
  await clock.settle()
  const after = currentState()
  expect(after?.summary).toEqual(before?.summary)
  expect(after?.usage.failures).toBe((before?.usage.failures ?? 0) + 1)
})

test('late summary writes cannot restore state after clear or resume', async ($, on) => {
  const clock = mock.clock(on)
  let latestState: SessionBriefState | undefined
  mockTurnOperations(on)
  mockSessionEnd(on)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('settings.read', () => { throw new Error('settings unavailable') })
  on('ui.panes', () => ({ value: [] }))

  let modelStartedResolve: () => void = () => {}
  let modelStarted = Promise.resolve()
  let resolveModel: (result: ModelCompleteResult) => void = () => {}
  on('model.complete', async () => {
    modelStartedResolve()
    const result = await new Promise<ModelCompleteResult>(resolve => { resolveModel = resolve })
    return { value: result }
  })

  let delayTokenWrite = false
  let tokenWriteStartedResolve: () => void = () => {}
  let tokenWriteStarted = Promise.resolve()
  let releaseTokenWrite: () => void = () => {}
  on('state.set', BRIEF_REF, async (_$, event, next) => {
    if (delayTokenWrite && event.value.usage.inputTokens > 0) {
      delayTokenWrite = false
      tokenWriteStartedResolve()
      await new Promise<void>(resolve => { releaseTokenWrite = resolve })
    }
    latestState = event.value
    return next(event)
  })

  for (const reason of ['clear', 'resume'] as const) {
    modelStarted = new Promise<void>(resolve => { modelStartedResolve = resolve })
    tokenWriteStarted = new Promise<void>(resolve => { tokenWriteStartedResolve = resolve })
    delayTokenWrite = true

    await $.turn.start({ text: `${reason} request`, turnId: `${reason}-turn` })
    await $.turn.complete(completeTurn(`${reason}-turn`, 'answer'))
    await clock.settle()
    await modelStarted

    resolveModel(answered(summaryText))
    await tokenWriteStarted
    await $.session.end({
      reason,
      sessionId: `${reason}-session`,
      resume: { id: `${reason}-session` },
    })
    expect(latestState).toEqual(initialState())

    releaseTokenWrite()
    await clock.settle()
    expect(latestState).toEqual(initialState())
  }

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(),
  })
  expect(await pane.find({ type: 'Text', text: '要約はまだありません。' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /呼出 0回/ })).toBeDefined()
  await pane.unmount()
})

test('late agent list refresh cannot restore agents after clear', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  mockSessionEnd(on)
  on('ui.panes', () => ({ value: [] }))

  let listStartedResolve: () => void = () => {}
  const listStarted = new Promise<void>(resolve => { listStartedResolve = resolve })
  let resolveAgentList: (agents: AgentInfo[]) => void = () => {}
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('agent.list', async () => {
    listStartedResolve()
    const agents = await new Promise<AgentInfo[]>(resolve => { resolveAgentList = resolve })
    return { value: agents }
  })

  await $.agent.spawn({
    tool_use_id: 'tool-agent-1',
    prompt: 'inspect this task',
    description: 'inspect task',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'sonnet',
    background: false,
    fork: false,
  })
  await clock.settle()
  await listStarted
  await $.session.end({
    reason: 'clear',
    sessionId: 'agent-session',
    resume: { id: 'agent-session' },
  })
  expect(currentState()).toEqual(initialState())

  resolveAgentList([{
    id: 'agent-1',
    type: 'general-purpose',
    description: 'inspect task',
    status: 'running',
  }])
  await clock.settle()
  expect(currentState()).toEqual(initialState())

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(),
  })
  expect(await pane.find({ type: 'Text', text: /inspect task/ })).toEqual(undefined)
  await pane.unmount()
})

test('summary parser rejects invalid JSON and stale summaries cannot replace a newer one', async $ => {
  const before: SessionBriefState = {
    ...initialState(),
    summary: {
      purpose: '新しい要約',
      status: '新しい状態',
      done: [],
      decisions: [],
      waiting: [],
      next: '継続',
      turn: 2,
    },
    latestAppliedTurn: 2,
  }
  expect(parseSummary('{').ok).toBe(false)
  const parsed = parseSummary(summaryText)
  expect(parsed.ok).toBe(true)
  if (parsed.ok) {
    const after = applySummary(before, 1, 'old request', parsed.value)
    expect(after.summary).toEqual(before.summary)
  }
})

test('cell truncation reserves space for ellipsis at ASCII and Japanese boundaries', async $ => {
  expect(truncateCells('abc', 0)).toBe('')
  expect(truncateCells('abc', 1)).toBe('…')
  expect(truncateCells('abc', 3)).toBe('abc')
  expect(truncateCells('abc', 2)).toBe('a…')

  expect(truncateCells('日本語', 0)).toBe('')
  expect(truncateCells('日本語', 1)).toBe('…')
  expect(truncateCells('日本', 4)).toBe('日本')
  expect(truncateCells('日本語', 4)).toBe('日…')
})

test('subagent completion refreshes agent status without requesting a summary', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let modelCalls = 0
  on('turn.start', (_$, event) => ({ turnId: event.turnId }))
  on('turn.complete', (_$, event) => ({ text: event.answer }))
  on('agent.list', () => ({ value: [{
    id: 'agent-finished',
    type: 'general-purpose',
    description: 'inspect task',
    status: 'running',
  }] }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('settings.read', () => ({ value: {} }))
  on('model.complete', async () => {
    modelCalls += 1
    return { value: answered(summaryText) }
  })

  await $.turn.start({ text: 'agent request', turnId: 'agent-turn', agentId: 'agent-finished' })
  await $.turn.complete({ ...completeTurn('agent-turn', 'agent answer'), agentId: 'agent-finished' })
  await clock.settle()

  expect(modelCalls).toBe(0)
  expect(currentState()?.usage.calls).toBe(0)
  expect(currentState()?.agents.find(agent => agent.id === 'agent-finished')?.status).toBe('completed')
})

test('classic and tool call results are returned unchanged when state writes fail', async ($, on) => {
  const clock = mock.clock(on)
  const stopResult = { block: 'keep this block', additionalContext: ['stop context'] }
  const startResult = { additionalContext: ['session context'], preventContinuation: true as const }
  const notificationResult = { block: 'notification block' }
  const toolResult = { result: 'runner started', metadata: { request: 'unchanged' } }
  on('state.set', BRIEF_REF, () => { throw new Error('state writes unavailable') })
  on('classic.Stop', () => stopResult)
  on('classic.SessionStart', () => startResult)
  on('classic.Notification', () => notificationResult)
  on('tool.call', () => toolResult)

  expect(await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })).toEqual(stopResult)
  expect(await $.classic.SessionStart({ source: 'startup' })).toEqual(startResult)
  expect(await $.classic.Notification({ message: 'notice', notification_type: 'test' })).toEqual(notificationResult)
  expect(await $.tool.call({
    tool: 'Bash',
    command: 'echo background',
    run_in_background: true,
    tool_use_id: 'write-failure-call',
  })).toEqual(toolResult)
  await clock.settle()
})

test('clear and resume schedule a configured hook refresh after resetting state', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  mockSessionEnd(on)
  on('settings.read', () => ({ value: { hooks: {
    Notification: [{ hooks: [{ type: 'command', command: 'echo notice' }] }],
  } } }))

  for (const reason of ['clear', 'resume'] as const) {
    const sessionId = `reset-hooks-${reason}`
    await $.session.end({ reason, sessionId, resume: { id: sessionId } })
    expect(currentState()).toEqual(initialState())
    await clock.settle()
    expect(currentState()?.configuredHookEvents).toEqual(['Notification'])
  }
})

test('a reloaded main turn number starts after the persisted applied turn', async ($, on) => {
  const clock = mock.clock(on)
  mockTurnOperations(on)
  let firstRead = true
  const debugMessages: string[] = []
  on('ui.log', (_$, event, next) => {
    debugMessages.push(event.text)
    return next(event)
  })
  on('state.get', BRIEF_REF, async (_$, event, next) => {
    if (!firstRead) return next(event)
    firstRead = false
    return { value: { value: { ...initialState(), latestAppliedTurn: 6 }, version: 1 } }
  })
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('settings.read', () => ({ value: {} }))
  let prompt = ''
  on('model.complete', async (_$, event) => {
    prompt = event.prompt
    return { value: answered(summaryText) }
  })

  await $.turn.complete(completeTurn('completed-after-reload', 'answer'))
  await clock.settle()
  await clock.settle()
  expect(debugMessages).toEqual([])
  expect(prompt).toContain('"turn":7')
})

test('summary prompt wraps turn content in one untrusted JSON data block', async $ => {
  const prompt = buildSummaryPrompt({
    turn: 3,
    request: 'change the summary',
    answer: 'summary updated',
    activity: ['Bash: cat /tmp/report.txt'],
  }, [{ turn: 2, request: 'earlier request', purpose: 'earlier purpose' }], {
    purpose: 'previous purpose',
    status: 'previous status',
    done: [],
    decisions: [],
    waiting: [],
    next: 'previous next',
    turn: 2,
  }, undefined)
  const encoded = prompt.split('DATA_JSON:\n')[1]
  expect(encoded).toBeDefined()
  const data = JSON.parse(encoded!) as Record<string, unknown>
  expect(data.userRequest).toBe('change the summary')
  expect(data.finalAnswer).toBe('summary updated')
  expect(data.shortToolActivity).toEqual(['Bash: cat /tmp/report.txt'])
  expect(data.previousSummary).toEqual(expect.objectContaining({ purpose: 'previous purpose' }))
  expect(prompt).toContain('未信頼のデータ')
})

test('mergeAgents preserves a terminal status when the list still says running', async $ => {
  const current: SessionBriefState['agents'] = [{
    id: 'agent-1', type: 'general-purpose', description: 'task', status: 'completed', startedAt: 1, endedAt: 2,
  }]
  const listed: AgentInfo[] = [{
    id: 'agent-1', type: 'general-purpose', description: 'task', status: 'running',
  }]
  expect(mergeAgents(current, listed, 10)[0]).toEqual(current[0])
})

test('denied background Codex calls remove their linked activity and stop monitoring', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let artifactChecks = 0
  let hostResult: ToolCallResult = { deny: 'runner denied' }
  on('tool.call', () => hostResult)
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-events.jsonl') || event.path.endsWith('-done')) artifactChecks += 1
    return { value: false }
  })
  on('fs.stat', (_$, event) => ({ value: mockWorkDirStat(event.path) }))

  for (const [index, value] of [
    { deny: 'runner denied' },
    { isError: true as const, result: 'runner start failed' },
  ].entries()) {
    hostResult = value
    const result = await $.tool.call({
      tool: 'Bash',
      command: `python3 /opt/codex/codex-run.py --work-dir /tmp/denied-${index} --run-id denied-${index}`,
      run_in_background: true,
      tool_use_id: `tool-denied-${index}`,
    })
    await clock.settle()
    expect(result).toEqual(value)
  }
  await clock.advance(15000)
  await clock.settle()

  expect(currentState()?.backgroundTasks).toHaveLength(0)
  expect(currentState()?.codexJobs).toHaveLength(0)
  expect(artifactChecks).toBe(0)
})

test('foreground Codex runner without a prompt is reported as not started', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneChecks = 0
  const hostResult = { isError: true as const, result: 'runner invocation failed before creating prompt.md' }
  on('tool.call', () => hostResult)
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-done')) doneChecks += 1
    return { value: false }
  })
  on('fs.stat', (_$, event) => ({ value: mockWorkDirStat(event.path) }))

  const result = await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/foreground --run-id foreground',
    tool_use_id: 'foreground-call',
  })
  await clock.settle()

  const job = currentState()?.codexJobs[0]
  expect(result).toEqual(hostResult)
  expect(job?.status).toBe('unavailable')
  expect(job?.unavailableReason).toBe('runner did not start')
  expect(doneChecks).toBe(1)

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(),
  })
  expect(await pane.find({ type: 'Text', text: /Unavailable: runner did not start/ })).toBeDefined()
  await pane.unmount()
})

test('a foreground Codex runner with a missing work directory is immediately not started and stops polling', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const workDir = '/tmp/missing-foreground-work-dir'
  let workDirStatCalls = 0
  let workDirExistsCalls = 0
  const hostResult = { isError: true as const, result: 'runner invocation failed before creating its work directory' }
  on('tool.call', () => hostResult)
  on('fs.exists', (_$, event) => {
    if (event.path === workDir) workDirExistsCalls += 1
    return { value: false }
  })
  on('fs.stat', (_$, event) => {
    if (event.path === workDir) {
      workDirStatCalls += 1
      throw new Error('work directory does not exist')
    }
    return { value: mockWorkDirStat(event.path) }
  })

  const result = await $.tool.call({
    tool: 'Bash',
    command: `python3 /opt/codex/codex-run.py --work-dir ${workDir} --run-id missing-work-dir`,
    tool_use_id: 'missing-work-dir-call',
  })
  await clock.settle()

  const job = currentState()?.codexJobs[0]
  expect(result).toEqual(hostResult)
  expect(job?.runnerExited).toBe(true)
  expect(job?.status).toBe('unavailable')
  expect(job?.unavailableReason).toBe('runner did not start')
  expect(workDirStatCalls).toBe(1)
  expect(workDirExistsCalls).toBe(1)

  await clock.advance(15000)
  await clock.settle()
  expect(workDirStatCalls).toBe(1)
  expect(workDirExistsCalls).toBe(1)
})

test('foreground Codex runner rejects an invalid EXIT marker after next completes', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneText = 'EXIT=x\n'
  on('tool.call', () => ({ result: 'finished' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') || event.path.endsWith('-prompt.md') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 8, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected read')
    return { value: doneText }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/invalid-marker --run-id invalid-marker',
    tool_use_id: 'invalid-marker-call',
  })
  await clock.settle()

  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBeUndefined()

  doneText = 'EXIT=0\n'
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
})

test('a signed integer EXIT marker is accepted as a failed Codex exit', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  on('tool.call', () => ({ result: 'finished' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 8, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected read')
    return { value: 'EXIT=-1\n' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/signed-exit --run-id signed-exit',
    tool_use_id: 'signed-exit-call',
  })
  await clock.settle()

  expect(currentState()?.codexJobs[0]?.status).toBe('failed')
  expect(currentState()?.codexJobs[0]?.exitCode).toBe(-1)
})

test('terminal background task reports preflight failure when its prompt is absent', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneChecks = 0
  const stopResult = { additionalContext: ['kept'] }
  on('tool.call', () => ({ result: {
    backgroundTaskId: 'host-bg-run',
    interrupted: false,
  } }))
  on('classic.Stop', () => stopResult)
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-done')) doneChecks += 1
    return { value: false }
  })
  on('fs.stat', (_$, event) => ({ value: mockWorkDirStat(event.path) }))

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/background-runner --run-id bg-run',
    run_in_background: true,
    tool_use_id: 'tool-bg-run',
  })
  await clock.settle()
  const observed = $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'host-bg-run',
      type: 'shell',
      status: 'running',
      description: 'Codex background run',
      command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/background-runner --run-id bg-run',
    }],
  })
  await observed
  const stop = $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(await stop).toEqual(stopResult)
  await clock.settle()

  expect(currentState()?.backgroundTasks[0]?.status).toBe('completed')
  expect(currentState()?.codexJobs[0]?.status).toBe('unavailable')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBe('runner did not start')
  expect(doneChecks).toBe(1)
})

test('an explicit terminal host snapshot immediately inspects its linked Codex job', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneChecks = 0
  on('tool.call', () => ({ result: { backgroundTaskId: 'explicit-terminal-host', interrupted: false } }))
  on('classic.Stop', () => ({}))
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-done')) doneChecks += 1
    return { value: false }
  })
  on('fs.stat', (_$, event) => ({ value: mockWorkDirStat(event.path) }))

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/explicit-terminal --run-id explicit-terminal',
    run_in_background: true,
    tool_use_id: 'explicit-terminal-call',
  })
  await clock.settle()
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'explicit-terminal-host',
      type: 'shell',
      status: 'failed',
      description: 'failed Codex task',
      command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/explicit-terminal --run-id explicit-terminal',
    }],
  })
  await clock.settle()

  expect(currentState()?.backgroundTasks[0]?.status).toBe('failed')
  expect(currentState()?.codexJobs[0]?.status).toBe('unavailable')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBe('runner did not start')
  expect(doneChecks).toBe(1)
})

test('a partial DONE marker is retried while the runner is still active', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneText = ''
  let doneReads = 0
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: doneText.length, mtimeMs: doneReads + 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected read')
    doneReads += 1
    return { value: doneText }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/partial --run-id partial',
    run_in_background: true,
    tool_use_id: 'tool-partial',
  })
  await clock.settle()
  await clock.advance(15000)
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(doneReads).toBe(1)

  doneText = 'EXIT=0\n'
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
  expect(currentState()?.codexJobs[0]?.exitCode).toBe(0)
  expect(doneReads).toBe(2)
})

test('Codex inspection retries after a transient state read failure', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let armInspectionReadFailure = false
  let failNextStateRead = false
  let failedStateReads = 0
  const debugMessages: string[] = []
  on('state.get', BRIEF_REF, async (_$, event, next) => {
    if (failNextStateRead) {
      failNextStateRead = false
      failedStateReads += 1
      return { deny: 'transient state read failure' } as never
    }
    const result = await next(event)
    if (armInspectionReadFailure) {
      armInspectionReadFailure = false
      failNextStateRead = true
    }
    return result
  })
  on('ui.log', (_$, event, next) => {
    debugMessages.push(event.text)
    return next(event)
  })
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 7, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected read')
    return { value: 'EXIT=0\n' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/transient-state --run-id transient-state',
    run_in_background: true,
    tool_use_id: 'transient-state-call',
  })
  await clock.settle()
  armInspectionReadFailure = true
  await clock.advance(15000)
  await clock.settle()

  expect(failedStateReads).toBe(1)
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(debugMessages.some(message => message.includes('state read failed; inspection will retry'))).toBe(true)

  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
  expect(currentState()?.codexJobs[0]?.exitCode).toBe(0)
})

test('an exited Codex runner with no artifact progress times out and stops polling', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const progressArtifacts = [
    'events.jsonl',
    'err.txt',
    'state.txt',
    'pid',
    'helper-done',
    'prompt.md',
  ]
  const observedArtifacts = new Set<string>()
  let doneChecks = 0
  on('tool.call', () => ({ isError: true, result: 'runner wait timed out' }))
  on('fs.exists', (_$, event) => {
    const artifact = progressArtifacts.find(name => event.path.endsWith(`-${name}`))
    if (artifact) {
      observedArtifacts.add(artifact)
      return { value: true }
    }
    if (event.path.endsWith('-done')) {
      doneChecks += 1
      return { value: false }
    }
    return { value: false }
  })
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 0, mtimeMs: 0, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) return { value: '' }
    throw new Error('unexpected artifact read')
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/stalled-runner --run-id stalled-runner',
    tool_use_id: 'stalled-runner-call',
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.runnerExited).toBe(true)

  await clock.advance(30 * 60 * 1000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('unavailable')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBe('no runner progress for 30 min')
  expect([...observedArtifacts].sort()).toEqual([...progressArtifacts].sort())
  const checksAfterTimeout = doneChecks

  await clock.advance(60000)
  await clock.settle()
  expect(doneChecks).toBe(checksAfterTimeout)
})

test('persistent Codex progress inspection failures time out and stop polling', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneChecks = 0
  on('tool.call', () => ({ isError: true, result: 'runner wait timed out' }))
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-done')) {
      doneChecks += 1
      return { value: false }
    }
    return { value: event.path.endsWith('-prompt.md') || event.path.endsWith('-events.jsonl') }
  })
  on('fs.stat', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) throw new Error('persistent progress stat failure')
    return { value: isCodexArtifactPath(event.path)
      ? { kind: 'file', size: 0, mtimeMs: 0, isLink: false }
      : mockWorkDirStat(event.path) }
  })
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-events.jsonl')) throw new Error('unexpected artifact read')
    return { value: '' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/inspection-failure --run-id inspection-failure',
    tool_use_id: 'inspection-failure-call',
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.artifactInspectionFailedAt).toBeDefined()

  await clock.advance(30 * 60 * 1000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('unavailable')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBe(
    'runner artifact inspection unavailable for 30 min',
  )
  const checksAfterTimeout = doneChecks

  await clock.advance(60000)
  await clock.settle()
  expect(doneChecks).toBe(checksAfterTimeout)
})

test('persistent DONE read failures time out despite artifact progress and stop polling', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const progressArtifacts = ['events.jsonl', 'err.txt', 'state.txt', 'pid', 'helper-done', 'prompt.md']
  const observedProgressArtifacts = new Set<string>()
  let doneChecks = 0
  let doneReadFailures = 0
  let progressStatVersion = 0
  on('tool.call', () => ({ isError: true, result: 'runner wait timed out' }))
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-helper-done')) return { value: true }
    if (event.path.endsWith('-done')) {
      doneChecks += 1
      return { value: true }
    }
    return { value: progressArtifacts.some(name => event.path.endsWith(`-${name}`)) }
  })
  on('fs.stat', (_$, event) => {
    if (!isCodexArtifactPath(event.path)) return { value: mockWorkDirStat(event.path) }
    if (event.path.endsWith('-helper-done')) {
      observedProgressArtifacts.add('helper-done')
      progressStatVersion += 1
      return { value: { kind: 'file', size: progressStatVersion, mtimeMs: progressStatVersion, isLink: false } }
    }
    if (event.path.endsWith('-done')) {
      return { value: { kind: 'file', size: 7, mtimeMs: 1, isLink: false } }
    }
    const artifact = progressArtifacts.find(name => event.path.endsWith(`-${name}`))
    if (artifact) observedProgressArtifacts.add(artifact)
    progressStatVersion += 1
    return { value: { kind: 'file', size: progressStatVersion, mtimeMs: progressStatVersion, isLink: false } }
  })
  on('fs.read', (_$, event) => {
    if (event.path.endsWith('-done')) {
      doneReadFailures += 1
      throw new Error('persistent DONE read failure')
    }
    if (event.path.endsWith('-events.jsonl')) return { value: '' }
    throw new Error('unexpected artifact read')
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/done-read-progress --run-id done-read-progress',
    tool_use_id: 'done-read-progress-call',
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.artifactInspectionFailedAt).toBeDefined()
  expect([...observedProgressArtifacts].sort()).toEqual([...progressArtifacts].sort())
  expect(doneReadFailures).toBeGreaterThan(0)

  await clock.advance(30 * 60 * 1000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('unavailable')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBe(
    'runner artifact inspection unavailable for 30 min',
  )
  const checksAfterTimeout = doneChecks

  await clock.advance(60000)
  await clock.settle()
  expect(doneChecks).toBe(checksAfterTimeout)
})

test('a recovered DONE read clears the inspection timer and honors a valid EXIT', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneReadable = false
  on('tool.call', () => ({ isError: true, result: 'runner wait timed out' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') || event.path.endsWith('-prompt.md') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 7, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected artifact read')
    if (!doneReadable) throw new Error('transient DONE read failure')
    return { value: 'EXIT=0\n' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/done-read-recovery --run-id done-read-recovery',
    tool_use_id: 'done-read-recovery-call',
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.artifactInspectionFailedAt).toBeDefined()

  doneReadable = true
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
  expect(currentState()?.codexJobs[0]?.exitCode).toBe(0)
  expect(currentState()?.codexJobs[0]?.artifactInspectionFailedAt).toBeUndefined()
})

test('artifact progress resets the quiet timer for another 30 minutes', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneChecks = 0
  let eventsSize = 0
  let eventsMtimeMs = 0
  on('tool.call', () => ({ isError: true, result: 'runner wait timed out' }))
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-done')) {
      doneChecks += 1
      return { value: false }
    }
    return { value: event.path.endsWith('-prompt.md') || event.path.endsWith('-events.jsonl') }
  })
  on('fs.stat', (_$, event) => ({ value: event.path.endsWith('-events.jsonl')
    ? { kind: 'file', size: eventsSize, mtimeMs: eventsMtimeMs, isLink: false }
    : isCodexArtifactPath(event.path)
      ? { kind: 'file', size: 0, mtimeMs: 0, isLink: false }
      : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-events.jsonl')) throw new Error('unexpected artifact read')
    return { value: '' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/progress-reset --run-id progress-reset',
    tool_use_id: 'progress-reset-call',
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.artifactProgressAt).toBeDefined()

  await clock.advance(29 * 60 * 1000 + 30000)
  eventsSize = 1
  eventsMtimeMs = clock.now()
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.artifactProgressAt).toBe(clock.now())

  await clock.advance(30 * 60 * 1000 - 15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('unavailable')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBe('no runner progress for 30 min')
  const checksAfterTimeout = doneChecks

  await clock.advance(60000)
  await clock.settle()
  expect(doneChecks).toBe(checksAfterTimeout)
})

test('a missing work directory keeps an active Codex runner in the monitor', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const workDir = '/tmp/not-ready-yet'
  let workDirReady = false
  let doneExists = false
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') && doneExists }))
  on('fs.stat', (_$, event) => {
    if (event.path === workDir) {
      if (!workDirReady) throw new Error('directory has not been created')
      return { value: mockWorkDirStat(workDir) }
    }
    return { value: { kind: 'file', size: 7, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected read')
    return { value: 'EXIT=0\n' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: `python3 /opt/codex/codex-run.py --work-dir ${workDir} --run-id starts-later`,
    run_in_background: true,
    tool_use_id: 'tool-starts-later',
  })
  await clock.settle()
  await clock.advance(15000)
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBeUndefined()

  workDirReady = true
  doneExists = true
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
})

test('oversized events preserve prior metadata while a valid DONE completes the job', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const eventText = `${JSON.stringify({
    method: 'thread/tokenUsage/updated',
    params: { tokenUsage: { total: { totalTokens: 55 } } },
  })}\n`
  let eventSize = eventText.length
  let eventMtime = 1
  let eventsRead = 0
  let doneExists = false
  on('tool.call', () => ({ result: 'started' }))
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-events.jsonl') || (event.path.endsWith('-done') && doneExists) }))
  on('fs.stat', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) return { value: { kind: 'file', size: eventSize, mtimeMs: eventMtime, isLink: false } }
    if (event.path.endsWith('-done')) return { value: { kind: 'file', size: 7, mtimeMs: 2, isLink: false } }
    if (isCodexArtifactPath(event.path)) return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }
    return { value: mockWorkDirStat(event.path) }
  })
  on('fs.read', (_$, event) => {
    if (event.path.endsWith('-events.jsonl')) {
      eventsRead += 1
      return { value: eventText }
    }
    if (event.path.endsWith('-done')) return { value: 'EXIT=0\n' }
    throw new Error('unexpected artifact read')
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/large-events --run-id large-events',
    run_in_background: true,
    tool_use_id: 'tool-large-events',
  })
  await clock.settle()
  await clock.advance(15000)
  expect(currentState()?.codexJobs[0]?.totalTokens).toBe(55)
  eventSize = 4 * 1024 * 1024 + 1
  eventMtime = 2
  doneExists = true
  await clock.advance(15000)
  await clock.settle()

  const job = currentState()?.codexJobs[0]
  expect(job?.status).toBe('completed')
  expect(job?.eventLineCount).toBe(1)
  expect(job?.lastEvent).toBe('thread/tokenUsage/updated')
  expect(job?.totalTokens).toBe(55)
  expect(job?.eventsSize).toBe(4 * 1024 * 1024 + 1)
  expect(job?.eventsUnavailableReason).toContain('4 MiB')
  expect(eventsRead).toBe(1)

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(),
  })
  expect(await pane.find({ type: 'Text', text: /Events unavailable: events artifact exceeds the 4 MiB read limit/ })).toBeDefined()
  await pane.unmount()
})

test('a foreground Codex call that auto-backgrounds stays running until its host task writes DONE', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneExists = false
  const hostResult = { result: { backgroundTaskId: 'host-auto-background', timedOutAfterMs: 5000 } }
  on('tool.call', () => hostResult)
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') && doneExists }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 7, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected artifact read')
    return { value: 'EXIT=0\n' }
  })

  const result = await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/auto-background --run-id auto-background',
    tool_use_id: 'auto-background-call',
  })
  await clock.settle()

  expect(result).toEqual(hostResult)
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.backgroundTaskId).toBe('host-auto-background')
  expect(currentState()?.backgroundTasks[0]?.backgroundTaskId).toBe('host-auto-background')
  expect(currentState()?.backgroundTasks[0]?.timedOutAfterMs).toBe(5000)

  doneExists = true
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
  expect(currentState()?.codexJobs[0]?.exitCode).toBe(0)
})

test('a foreground Bash error with EXIT 1 remains as a failed Codex job', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const hostResult = { isError: true as const, result: 'exit 1' }
  on('tool.call', () => hostResult)
  on('fs.exists', (_$, event) => ({ value: event.path.endsWith('-done') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 7, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected artifact read')
    return { value: 'EXIT=1\n' }
  })

  const result = await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/exit-one --run-id exit-one',
    tool_use_id: 'exit-one-call',
  })
  await clock.settle()

  expect(result).toEqual(hostResult)
  expect(currentState()?.codexJobs).toHaveLength(1)
  expect(currentState()?.codexJobs[0]?.status).toBe('failed')
  expect(currentState()?.codexJobs[0]?.exitCode).toBe(1)
})

test('an errored foreground Codex job with a prompt stays running and completes on a later poll', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneExists = false
  on('tool.call', () => ({ isError: true, result: 'runner timed out while helper continues' }))
  on('fs.exists', (_$, event) => ({ value: (event.path.endsWith('-done') && doneExists) || event.path.endsWith('-prompt.md') }))
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 7, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected artifact read')
    return { value: 'EXIT=0\n' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/interrupted --run-id interrupted',
    tool_use_id: 'interrupted-call',
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.runnerExited).toBe(true)

  doneExists = true
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
})

test('a transient prompt lookup error does not imply the runner failed preflight', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let doneExists = false
  let failPromptLookup = true
  on('tool.call', () => ({ isError: true, result: 'runner wait timed out' }))
  on('fs.exists', (_$, event) => {
    if (event.path.endsWith('-done')) return { value: doneExists }
    if (event.path.endsWith('-prompt.md') && failPromptLookup) {
      failPromptLookup = false
      return { deny: 'transient prompt lookup failure' } as never
    }
    return { value: event.path.endsWith('-prompt.md') }
  })
  on('fs.stat', (_$, event) => ({ value: isCodexArtifactPath(event.path)
    ? { kind: 'file', size: 7, mtimeMs: 1, isLink: false }
    : mockWorkDirStat(event.path) }))
  on('fs.read', (_$, event) => {
    if (!event.path.endsWith('-done')) throw new Error('unexpected artifact read')
    return { value: 'EXIT=0\n' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/prompt-lookup --run-id prompt-lookup',
    tool_use_id: 'prompt-lookup-call',
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.unavailableReason).toBeUndefined()

  doneExists = true
  await clock.advance(15000)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('completed')
})

test('empty Stop and SubagentStop snapshots do not finish a pending call before it gets a host task id', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let resolveToolCall: ((result: ToolCallResult) => void) | undefined
  const toolResult = new Promise<ToolCallResult>(resolve => { resolveToolCall = resolve })
  on('tool.call', () => toolResult)
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}))

  const pendingCall = $.tool.call({
    tool: 'Bash',
    command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/pending --run-id pending',
    run_in_background: true,
    tool_use_id: 'pending-call',
  })
  await clock.settle()
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.classic.SubagentStop({
    stop_hook_active: false,
    agent_id: 'pending-agent',
    agent_transcript_path: '/tmp/pending-agent.jsonl',
    agent_type: 'general-purpose',
    background_tasks: [],
  })
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.backgroundTasks[0]?.status).toBe('running')
  expect(currentState()?.backgroundTasks[0]?.backgroundTaskId).toBeUndefined()

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'pending-host-task',
      type: 'shell',
      status: 'running',
      description: 'pending Codex task',
      command: 'python3 /opt/codex/codex-run.py --work-dir /tmp/pending --run-id pending',
    }],
  })
  await clock.settle()

  const resolved = { result: { backgroundTaskId: 'pending-host-task', interrupted: false } }
  resolveToolCall?.(resolved)
  expect(await pendingCall).toEqual(resolved)
  await clock.settle()
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.codexJobs[0]?.backgroundTaskId).toBe('pending-host-task')
  expect(currentState()?.backgroundTasks).toHaveLength(1)
  expect(currentState()?.backgroundTasks[0]?.backgroundTaskId).toBe('pending-host-task')
  expect(currentState()?.backgroundTasks[0]?.hostKnownSequence).toBeDefined()
  expect(currentState()?.backgroundTasks[0]?.toolUseId).toBe('pending-call')
})

test('an older empty Stop snapshot cannot finish a task seen in a newer running snapshot', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let resolveToolCall: ((result: ToolCallResult) => void) | undefined
  const toolResult = new Promise<ToolCallResult>(resolve => { resolveToolCall = resolve })
  let releaseOlderStop: () => void = () => {}
  let olderStopStartedResolve: () => void = () => {}
  const olderStopGate = new Promise<void>(resolve => { releaseOlderStop = resolve })
  const olderStopStarted = new Promise<void>(resolve => { olderStopStartedResolve = resolve })
  let stopCalls = 0
  on('tool.call', () => toolResult)
  on('classic.Stop', async () => {
    stopCalls += 1
    if (stopCalls === 1) {
      olderStopStartedResolve()
      await olderStopGate
    }
    return {}
  })

  const pendingCall = $.tool.call({
    tool: 'Bash',
    command: 'echo pending permission',
    run_in_background: true,
    tool_use_id: 'stale-absence-call',
  })
  await clock.settle()
  const olderEmptyStop = $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await olderStopStarted

  const resolved = { result: { backgroundTaskId: 'stale-absence-host', interrupted: false } }
  resolveToolCall?.(resolved)
  expect(await pendingCall).toEqual(resolved)
  await clock.settle()
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'stale-absence-host',
      type: 'shell',
      status: 'running',
      description: 'permission granted task',
      command: 'echo pending permission',
    }],
  })
  await clock.settle()
  expect(currentState()?.backgroundTasks[0]?.status).toBe('running')
  const latestSnapshotSequence = currentState()?.backgroundTasks[0]?.latestSnapshotSequence

  releaseOlderStop()
  await olderEmptyStop
  await clock.settle()

  expect(currentState()?.backgroundTasks[0]?.status).toBe('running')
  expect(currentState()?.backgroundTasks[0]?.latestSnapshotSequence).toBe(latestSnapshotSequence)
})

test('a truncated long command reconciles by host task id', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  const command = `echo ${'long-command '.repeat(110)}`
  on('tool.call', () => ({ result: { backgroundTaskId: 'host-long-command', interrupted: false } }))
  on('classic.Stop', () => ({}))

  await $.tool.call({
    tool: 'Bash',
    command,
    run_in_background: true,
    tool_use_id: 'long-command-call',
  })
  await clock.settle()
  const startedAt = currentState()?.backgroundTasks[0]?.startedAt
  expect(command.length).toBeGreaterThan(1000)

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{
      id: 'host-long-command',
      type: 'shell',
      status: 'running',
      description: 'long command',
      command: command.slice(0, 1000),
    }],
  })
  await clock.settle()

  const tasks = currentState()?.backgroundTasks ?? []
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.toolUseId).toBe('long-command-call')
  expect(tasks[0]?.backgroundTaskId).toBe('host-long-command')
  expect(tasks[0]?.startedAt).toBe(startedAt)
  expect(tasks[0]?.status).toBe('running')
})

test('a later denied or errored call with a duplicate run id cannot remove the first job', async ($, on) => {
  const clock = mock.clock(on)
  const currentState = captureBriefState(on)
  let callNumber = 0
  on('tool.call', () => {
    callNumber += 1
    if (callNumber === 1) return { result: { backgroundTaskId: 'first-host-task', interrupted: false } }
    if (callNumber === 2) return { deny: 'second call denied' }
    return { isError: true, result: 'runner start failed' }
  })

  const command = 'python3 /opt/codex/codex-run.py --work-dir /tmp/duplicate-run --run-id same-run'
  await $.tool.call({ tool: 'Bash', command, run_in_background: true, tool_use_id: 'first-call' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command, run_in_background: true, tool_use_id: 'denied-second-call' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command, run_in_background: true, tool_use_id: 'errored-third-call' })
  await clock.settle()

  expect(currentState()?.codexJobs).toHaveLength(1)
  expect(currentState()?.codexJobs[0]?.toolUseId).toBe('first-call')
  expect(currentState()?.codexJobs[0]?.backgroundTaskId).toBe('first-host-task')
  expect(currentState()?.codexJobs[0]?.status).toBe('running')
  expect(currentState()?.backgroundTasks).toHaveLength(1)
  expect(currentState()?.backgroundTasks[0]?.toolUseId).toBe('first-call')
})

test('session end and both UI renderers tolerate state I/O failures', async ($, on) => {
  const clock = mock.clock(on)
  const endResult = { sessionId: 'state-write-failure' }
  on('session.end', (_$, event) => ({ sessionId: event.sessionId }))
  on('state.set', BRIEF_REF, () => { throw new Error('state writes unavailable') })
  on('state.get', BRIEF_REF, () => { throw new Error('state reads unavailable') })
  on('ui.panes', () => ({ value: [] }))
  const fallbacks: string[] = []
  on('ui.render', ($$, e) => {
    fallbacks.push(e.component)
    const { Text } = $$.ui.resolve(e)
    return <Text>{e.component} fallback</Text>
  })

  const ended = await $.session.end({
    reason: 'clear',
    sessionId: endResult.sessionId,
    resume: { id: endResult.sessionId },
  })
  expect(ended).toEqual(endResult)

  const band = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: abovePromptProps(),
  })
  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(),
  })
  await clock.settle()
  expect(band).toBeDefined()
  expect(pane).toBeDefined()
  expect(fallbacks).toContain('AbovePrompt')
  await pane.unmount()
  await band.unmount()
})

test('session start returns its result when command registration is refused', async ($, on) => {
  on('command.register', () => ({ deny: 'command registration unavailable' }) as never)
  on('session.start', (_$, event) => ({ cwd: event.cwd }))
  const started = await $.session.start({
    cwd: '/repo',
    surface: 'terminal',
    isInteractive: true,
  })
  expect(started).toEqual({ cwd: '/repo' })
})

test('the prompt band falls back when open-pane lookup is refused', async ($, on) => {
  on('ui.panes', () => ({ deny: 'pane list unavailable' }) as never)
  const fallbacks: string[] = []
  on('ui.render', ($$, event) => {
    fallbacks.push(event.component)
    const { Text } = $$.ui.resolve(event)
    return <Text>prompt band fallback</Text>
  })

  const band = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: abovePromptProps(),
  })
  expect(fallbacks).toContain('AbovePrompt')
  expect(await band.find({ type: 'Text', text: 'prompt band fallback' })).toBeDefined()
  await band.unmount()
})

test('the prompt band detail button absorbs a rejected open-pane lookup', async ($, on) => {
  const clock = mock.clock(on)
  let rejectPaneList = false
  const debugMessages: string[] = []
  on('tool.call', () => ({ result: 'started' }))
  on('ui.panes', () => rejectPaneList
    ? ({ deny: 'pane list unavailable during press' } as never)
    : { value: [] })
  on('ui.log', (_$, event) => {
    debugMessages.push(event.text)
    return { value: undefined }
  })
  await $.tool.call({ tool: 'Bash', command: 'echo show the prompt band', run_in_background: true })
  await clock.settle()

  const band = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: abovePromptProps(),
  })
  expect(await band.find({ type: 'Button', key: 'open-details' })).toBeDefined()

  rejectPaneList = true
  expect(await band.press({ key: 'open-details' })).toEqual({ element: 'open-details' })
  expect(debugMessages.some(message => message.includes('could not open Session Brief from the prompt band'))).toBe(true)
  await band.unmount()
})

