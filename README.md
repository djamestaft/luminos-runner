# Luminos Runner

This repo runs the local Windows task runner for the Luminos workflow.

## What it does now

- loads runner config from `.env`
- heartbeats runner presence to Convex
- polls for approved tasks
- claims at most one task at a time
- creates a task-specific Git branch and worktree from a configured local repo
- writes task context files into that worktree
- invokes one configured PI wrapper command inside the worktree
- validates that the wrapper left at least one commit on the task branch
- marks successful local implementation as `in_review`
- marks execution failures as `failed`

This is intentionally a V1 single-machine runner.

## Environment

Create `.env` from `.env.example` and set:

- `CONVEX_URL`
- `RUNNER_ID`
- `RUNNER_HOST_NAME`
- `SOURCE_REPO_ROOT`
- `PI_COMMAND`

Optional:

- `CONVEX_TOKEN`
- `RUNNER_VERSION`
- `POLL_INTERVAL_MS`
- `HEARTBEAT_INTERVAL_MS`
- `LEASE_DURATION_MS`
- `WORKTREE_ROOT`
- `BASE_BRANCH=main`
- `CODEX_COMMAND=codex.cmd`
- `CODEX_MODEL`
- `CODEX_PROFILE`
- `POST_PLANNER_TO_DISCORD=true`
- `POST_TASK_UPDATES_TO_DISCORD=true`
- `DISCORD_BOT_TOKEN`
- `DISCORD_TASKS_CHANNEL_ID`
- `DISCORD_WEBHOOK_URL`
- `PI_AUTO_COMMIT=true`
- `PI_AUTO_COMMIT_MESSAGE`
- `PUSH_ON_SUCCESS=false`
- `PUSH_REMOTE=origin`

## Commands

```bash
npm install
npm run typecheck
npm run build
npm run start
```

## Current execution slice

When the runner claims a task, it creates a branch and worktree from the configured repo base branch, then writes:

- `luminos-task.json`
- `TASK_BRIEF.md`
- `luminos-runner.json`

The runner then executes `PI_COMMAND --worktree <path> --task-id <id> --branch <branch>`.

## Wrapper

Use the Codex wrapper as the preferred POC runner command:

```env
PI_COMMAND=C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner\scripts\codex-wrapper.cmd
```

The Codex wrapper runs one non-interactive `codex exec` session inside the task worktree and writes:

- `LUMINOS_TASK_ID`
- `LUMINOS_TASK_BRANCH`
- `LUMINOS_WORKTREE_PATH`
- `LUMINOS_RUNNER_ROOT`

It also stores:

- `.luminos/codex-run-context.json`
- `.luminos/codex-prompt.md`
- `.luminos/codex-last-message.md`

If `PI_AUTO_COMMIT=true`, the wrapper runs `git add -A` and creates a commit after the phases complete, but only if there are actual changes.

If `PUSH_ON_SUCCESS=true`, the runner pushes the successful task branch after the wrapper has created a commit:

```bash
git push -u <PUSH_REMOTE> <task-branch>
```

The default remote is `origin`. Push failures fail the task instead of marking it `in_review`.

If `POST_TASK_UPDATES_TO_DISCORD=true`, the wrapper posts progress updates into the task's Discord thread/channel throughout the run:

- task started
- codex started
- codex finished
- local execution complete
- failure details if Codex or the wrapper errors

If `DISCORD_TASKS_CHANNEL_ID` is set and the task does not already carry a `discordThreadId`, the wrapper creates a dedicated thread under that channel and uses it for all runner updates in the current run.

Status updates are posted in 1900-character chunks so long messages still arrive intact.

## Legacy PI Wrapper

The older PI multi-phase wrapper is still available at:

```env
PI_COMMAND=C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner\scripts\pi-wrapper.cmd
```

That path is now considered legacy compared with the simpler Codex POC flow above.

## Smoke Test

For a full local end-to-end proof before wiring real PI, point the implementor phase at the included smoke script:

```env
PI_COMMAND=C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner\scripts\pi-wrapper.cmd
PI_IMPLEMENTOR_COMMAND=node "{runnerRoot}\scripts\pi-smoke-implementor.mjs"
PI_AUTO_COMMIT=true
```

When a task is approved, the smoke implementor writes `PI_SMOKE_OUTPUT.md` inside the task worktree and the wrapper commits it. That is enough for the runner to move the task to `in_review`.

Success requires both:

- zero exit from the PI wrapper
- at least one commit on the task branch beyond the configured base branch

If either condition fails, the task transitions to `failed`. Worktrees remain on disk after both success and failure for manual inspection.
