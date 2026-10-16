# Session Brief

Session Brief is a Claude Code function-hook plugin that keeps a short handoff view of the current session.

## Features

- The band above the prompt shows the current purpose and status, running subagents and background tasks, active Codex jobs, and recent settings-hook activity. Open the **Session Brief** pane with `/brief` or the band button.
- The pane shows the purpose, current status, recent completed items, decisions, items waiting on you, and the next step. It also lists subagents with elapsed time, background tasks, Codex runner jobs, per-event settings-hook statistics, and cumulative summary-call usage.
- Background Bash tasks appear as soon as Claude Code starts them. The plugin links them to Claude Code background snapshots by the host task ID returned from Bash. An explicit terminal status is recorded immediately; absence in a later snapshot marks a task completed if it was observed earlier or if the snapshot began after its host task ID was recorded in the same module epoch. Subagent entries are omitted from the background-task list.
- Codex jobs are recognized when a Bash command contains `codex-run.py`. The plugin keeps the job running when Bash returns a host background task ID, including when the command is moved to the background. After the runner exits, a missing `prompt.md` means it did not start only if the plugin has never observed that prompt; a previously observed prompt prevents a later absence from being treated as a preflight failure. A missing work directory after runner exit is reported immediately as `runner did not start`. A valid `DONE` sets the final status immediately; without one, the job becomes unavailable after 30 minutes without artifact progress or after 30 minutes when work-directory presence cannot be established or runner artifact inspection otherwise keeps failing. The pane reads the runner's model, effort, sandbox, event count, latest event, token total, exit code, and a short excerpt from the final response when those artifacts are available.
- The compact summary uses the configured Haiku alias at low effort and is requested once for each eligible completed main turn. Subagent completions are ignored; the pane and band render on terminal and desktop surfaces.

## Install

At a terminal Claude Code prompt, run these commands in order:

```text
/plugin marketplace add coil398/claude-session-brief
/plugin install session-brief@claude-session-brief
/reload-plugins
```

Confirm adding the marketplace and choose the user scope when prompted for the plugin installation.

In Claude Code Desktop, click **+** beside the prompt, choose **Plugins**, choose **Add marketplace**, enter `coil398/claude-session-brief`, and then choose **Add plugin**. The terminal plugin command is not available inside Desktop's Code session; a user-scope installation made in a terminal is also loaded by the local Desktop Code session.

## Usage and data

For each completed main turn, Session Brief requests one summary using the configured Haiku alias at low effort when the turn is eligible; subagent completions are ignored. Its data contains the user prompt, final answer, short tool activity (including Bash excerpts and paths), and previous summary. Requests run serially. If turns complete while one request is active, only the newest waiting turn is kept, so earlier waiting turns do not result in separate calls. A headless session skips a request when `session.surfaces()` returns an empty list; any nonempty surface list permits the call. The provider and account configured for Claude Code handle the request and its normal usage or billing. The pane shows input tokens, output tokens, calls, and failures; it does not estimate a dollar amount. `/brief` opens Session Brief when it is closed, closes it when it is the visible pane, and brings it to the front when it is behind another pane. The band's **詳細** button opens or brings the pane to the front without closing it.

The plugin observes Claude Code's `classic.*` settings-hook events, records elapsed time and selected outcome counts, and returns the result from the hooks beneath it unchanged. Hook statistics fold calls by event name across the session: each event row accumulates its call count, block count, added-context count, continuation-prevention count, total and maximum duration, and last-call time. The settings summary reads configured event names from the session's settings; the plugin does not replace or rewrite configured hook entries. Claude Code raises these events when a classic hook event runs even when no settings hook is configured for that event.

Organizations that enforce `allowManagedHooksOnly` do not load hooks from user-scope plugins. An administrator must allow or install this plugin as managed for its band, pane, and `classic.*` observations to run in those sessions.

Codex monitoring follows the artifact layout of `scripts/codex-run.py`: the files `codex-<RUN_ID>-events.jsonl`, `codex-<RUN_ID>-done`, and `codex-<RUN_ID>-last.md` must be directly inside the command's `--work-dir`. The plugin checks `DONE` and `events.jsonl` every 15 seconds while a tracked job is running. The engine exposes whole-file reads with a 4 MiB limit and no range reads. If `events.jsonl` exceeds that limit or cannot be read, event details are unavailable while the last parsed event metadata is kept. After the runner exits without a valid `DONE`, the plugin checks the size and modification time of `events.jsonl`, `err.txt`, `state.txt`, `pid`, `helper-done`, and `prompt.md` for progress. Without a valid `EXIT`, 30 minutes without artifact progress makes the job unavailable. If the work directory is confirmed missing after runner exit, the job is immediately reported as `runner did not start`. The 30-minute inspection timeout applies when work-directory presence or existence cannot be established, or when inspection of the runner directory, `DONE`, or progress artifacts otherwise continues to fail. `DONE` lookup, stat, and read errors are retried. The plugin reads `last.md` only after a valid `DONE`; an oversized or unreadable file makes the final response excerpt unavailable. The plugin does not launch or retry Codex jobs.

The function-hook plugin API is early access. This plugin was built against the Claude Code 2.1.299 API declarations; event and manifest details can change in later builds.

## Development

Load the plugin once with `claude --plugin-dir .` from the plugin root to generate the gitignored `.claude-plugin/types/` declarations. Exit Claude Code, then run these commands from the plugin root:

```sh
claude plugin validate .
claude plugin test .
tsc -p .
```
