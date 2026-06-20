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
- `PI_PLANNER_COMMAND`
- `PI_IMPLEMENTOR_COMMAND`
- `PI_REVIEWER_COMMAND`
- `POST_PLANNER_TO_DISCORD=true`
- `DISCORD_BOT_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `PI_AUTO_COMMIT=true`
- `PI_AUTO_COMMIT_MESSAGE`

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

Use the checked-in wrapper as the stable runner command:

```env
PI_COMMAND=C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner\scripts\pi-wrapper.cmd
```

The wrapper runs up to three internal phases:

- planner via `PI_PLANNER_COMMAND`
- implementor via `PI_IMPLEMENTOR_COMMAND`
- reviewer via `PI_REVIEWER_COMMAND`

Each phase command is optional. If a phase command is empty, that phase is skipped.

Command templates can use:

- `{runnerRoot}`
- `{worktree}`
- `{taskId}`
- `{branch}`
- `{phase}`

The wrapper also sets:

- `LUMINOS_TASK_ID`
- `LUMINOS_TASK_BRANCH`
- `LUMINOS_WORKTREE_PATH`
- `LUMINOS_RUNNER_ROOT`
- `LUMINOS_PI_PHASE`

If `PI_AUTO_COMMIT=true`, the wrapper runs `git add -A` and creates a commit after the phases complete, but only if there are actual changes.

If `POST_PLANNER_TO_DISCORD=true`, the wrapper also looks for the newest changed markdown file under `orchestration/plans/` after the planner phase and posts it to Discord:

- preferred: the original task channel via `DISCORD_BOT_TOKEN` plus the task's stored `discordChannelId`
- fallback: `DISCORD_WEBHOOK_URL`

The planner markdown is posted in 1900-character chunks so long plans still arrive intact.

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
