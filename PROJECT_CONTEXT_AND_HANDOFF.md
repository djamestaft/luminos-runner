# Luminos Project Context And Runner Handoff

Created: 2026-06-17
Purpose: carry enough project context into the `luminos-runner` repo so a fresh agent can continue implementation without relying on prior chat history.

## Recommended Next Working Repo

Primary repo for the next session:
- `C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner`

Related live gateway repo:
- `C:\Users\dev.one\Documents\Projects\Products\discord-gateway`

Legacy planning/orchestration workspace:
- `C:\Users\dev.one\Documents\Projects\Contracts\Luminos`

## Executive Summary

The Luminos project is building an AI-assisted task intake and execution workflow centered around Discord, Convex, a hosted Fastify gateway, and a local Windows runner.

Current real state is ahead of the original June 17 planning assumptions:
- a dedicated `discord-gateway` repo exists
- the Fastify gateway is deployed
- a Discord bot is installed in the server and guild commands are working
- the Discord command surface is currently minimal: `/task <title> <body>` and `/status <task_id>`
- Convex is running
- `/task` already creates a task in Convex
- the missing piece is the machine-local runner that only executes when the Windows machine is online

The next implementation focus should be the runner repo, not the gateway repo, unless runner work reveals a missing queue/status contract that must be added to the gateway's Convex functions.

## End Goal

The intended end state is a practical delivery pipeline for Greg and Devon:
- Greg posts work into Discord
- the system captures the task into a durable queue
- the system can ask clarifying questions or request structure when needed
- once the task is sufficiently defined and approved, a local Windows runner performs the implementation workflow only when that machine is online
- the implementation result is packaged for Greg to apply manually in his environment
- status is visible in Discord

The broader workflow notes currently captured in `C:\Users\dev.one\Documents\Projects\Contracts\Luminos\Todos.md` suggest this future process:
- standup/task text goes into a Discord channel
- Devon/agents analyze the task and gather more information
- follow-up questions may be sent back to Greg
- Greg may provide pseudocode guidance
- implementation is produced
- output may be zipped and uploaded to Google Drive or another handoff location
- Greg is notified in an ongoing tasks channel

That broader vision is not implemented yet. The current live system is only the task intake/status foundation.

## Current Architecture

### 1. Hosted gateway

Repo:
- `C:\Users\dev.one\Documents\Projects\Products\discord-gateway`

Role:
- receives Discord interactions
- verifies Discord signatures
- handles guild command requests
- reads and writes task state in Convex
- exposes health/status endpoints

Important files:
- `src/gatewayApp.ts`
- `src/services/convexTaskStore.ts`
- `src/lib/discord.ts`
- `src/lib/signatures.ts`
- `convex/schema.ts`
- `convex/tasks.ts`
- `convex/runnerStatus.ts`

### 2. Convex backend

Lives inside `discord-gateway`.

Current role:
- stores tasks
- stores task events
- stores runner heartbeat/presence
- exposes task queue mutations and queries

Observed task statuses in code:
- `new`
- `approved`
- `working`
- `in_review`
- `done`
- `needs_info`
- `blocked`
- `failed`

### 3. Local Windows runner

Repo:
- `C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner`

Current state:
- scaffolded during this session
- builds successfully
- typechecks successfully
- loads config from `.env`
- heartbeats to Convex
- polls for approved tasks
- claims one task at a time
- runs a placeholder handler
- releases the claim back to `approved`

Important files:
- `src/index.ts`
- `src/config.ts`
- `src/runner.ts`
- `src/convexRunnerClient.ts`
- `src/placeholderTaskHandler.ts`
- `README.md`

## What Is Live Today

Live and working:
- Fastify gateway deployment exists
- Discord guild commands exist
- `/task` creates tasks in Convex
- `/status` exists
- Convex deployment is active

Not yet complete:
- no real runner execution path
- no code checkout/worktree logic in the runner
- no PI/Codex implementation workflow in the runner
- no durable `done` / `failed` completion path wired from runner execution
- no packaging/upload handoff flow implemented
- no clarification/triage workflow implemented beyond the high-level vision

## Original Plan Versus Actual State

Original plan artifact:
- `C:\Users\dev.one\Documents\Projects\Contracts\Luminos\orchestration\plans\20260617-fastify-convex-discord-gateway.md`

That plan assumed hosted Discord HTTP interactions would likely be the first intake path and that deployment was still pending.

Actual state now differs in these ways:
- the gateway is already deployed
- the Discord bot and guild commands are already configured
- the intake path is already functioning at least for `/task`
- the runner is now the primary missing component

This means future work should not restart gateway planning from zero. The gateway should be treated as the live control plane and the runner as the active implementation target.

## Review History That Still Matters

Review artifact:
- `C:\Users\dev.one\Documents\Projects\Contracts\Luminos\orchestration\reviews\20260617-1428-review-summary.md`

Important historical concerns from that review:
1. tasks could be stranded in `working`
2. claim logic was not safe under multiple runners

Current status of those concerns:
- concern 1 has been partially addressed in the gateway repo because `convex/tasks.ts` now includes lease-expiry reclaim logic and a `releaseTaskClaim` mutation
- concern 2 still matters conceptually because the claim flow is still effectively read-then-patch and should be treated as single-runner-only for V1

Practical conclusion:
- assume exactly one runner machine for now
- do not design for multiple concurrent runners yet
- keep runner behavior conservative and explicit

## Current Queue Contract

Based on the current `discord-gateway` Convex code:
- tasks are created as `new`
- approval moves a task to `approved`
- the runner claims an approved task and moves it to `working`
- a working task whose lease expires can be reclaimed later
- the runner can explicitly release a claim back to `approved`

What is still missing for a real executor:
- a mutation to mark a task `failed`
- a mutation to mark a task `done` or `in_review`
- likely a mutation to refresh lease/heartbeat per claimed task if execution can run longer than the initial lease
- possibly a place to store execution logs, artifact locations, zip URLs, or PR metadata depending on the final handoff model

## Runner Repo Work Completed In This Session

The runner repo was scaffolded at:
- `C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner`

Current behavior:
- `npm install` completed successfully
- `npm run typecheck` passed
- `npm run build` passed
- `.env` loading is wired through `dotenv`
- the placeholder runner will not strand tasks because it releases claims after logging them

This scaffold is intentionally safe but not useful for real execution yet.

## Immediate Next Engineering Goal

Build the first real local execution slice in `luminos-runner`.

Recommended scope for the next slice:
1. decide what one claimed task should actually do on the machine
2. add missing terminal task status mutations in `discord-gateway/convex/tasks.ts`
3. replace the placeholder task handler with a real executor
4. keep single-task, single-machine semantics
5. log enough state to understand failures without overengineering persistence

## Recommended First Real Runner Behavior

The safest first non-placeholder behavior is probably:
- claim task
- write local working directory for that task
- serialize task details into a local prompt/context file
- run the chosen implementation toolchain locally
- collect output logs and artifact paths
- update Convex to either `failed`, `in_review`, or `done`
- if execution cannot continue, release or fail explicitly rather than leaving ambiguous state

Whether that implementation toolchain is PI, Codex CLI, zip generation, repo patching, or a hybrid should be decided before coding further.

## Open Product And Technical Questions

These are not blockers for starting runner work, but they should be resolved soon.

### Product / workflow
- Is Discord still the only intake path, or will ClickUp become a parallel or upstream source?
- Is the intended deliverable a Git branch/PR, a zip file, or both?
- Does Greg apply changes manually in another private Azure repo, or should the runner eventually integrate directly with that repo?
- Should the runner implement tasks only after an explicit approval state, or should some tasks auto-run?
- Do follow-up questions happen in Discord manually, or should the system send them automatically later?

### Runner execution
- What exact command or workflow should be run per approved task?
- Where should local work directories live?
- Does the runner need access to a local repo clone, Azure credentials, Google Drive CLI, or all three?
- What is the minimum viable artifact for handoff: log, patch, zip, or branch?
- Should task completion transition to `in_review` first or straight to `done`?

### Queue contract
- Should a claimed task heartbeat/renew its lease while long work is in progress?
- Should repeated failures increment retry counts and auto-requeue?
- What status should represent "implemented and waiting for Greg"?

## Suggested Direction

Short answer: yes, it is smart to move continuation into the runner repo.

Reason:
- the gateway is already live enough to support runner work
- the next highest-value work is local execution on the Windows machine
- keeping the runner in its own repo matches the deployment split and reduces accidental coupling

Use the gateway repo only when the runner requires contract changes, especially task completion/failure mutations.

## Existing Artifacts To Reference Instead Of Recreating

Gateway repo:
- `C:\Users\dev.one\Documents\Projects\Products\discord-gateway\README.md`
- `C:\Users\dev.one\Documents\Projects\Products\discord-gateway\src\gatewayApp.ts`
- `C:\Users\dev.one\Documents\Projects\Products\discord-gateway\convex\tasks.ts`
- `C:\Users\dev.one\Documents\Projects\Products\discord-gateway\convex\runnerStatus.ts`

Runner repo:
- `C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner\README.md`
- `C:\Users\dev.one\Documents\Projects\Contracts\luminos-runner\src\runner.ts`

Legacy planning docs:
- `C:\Users\dev.one\Documents\Projects\Contracts\Luminos\orchestration\plans\20260617-fastify-convex-discord-gateway.md`
- `C:\Users\dev.one\Documents\Projects\Contracts\Luminos\orchestration\reviews\20260617-1428-review-summary.md`
- `C:\Users\dev.one\Documents\Projects\Contracts\Luminos\Todos.md`

## Suggested Skills For The Next Agent Session

Recommended skills:
- `handoff`: if another fresh handoff snapshot is needed later
- `convex`: for any queue/status contract changes in the gateway repo
- `convex-migration-helper`: if schema/status fields need a careful migration
- `openai-docs`: only if the next session needs current official OpenAI/Codex product guidance

## Recommended Prompt To Resume Work

A good next-session opener would be:

"Read `PROJECT_CONTEXT_AND_HANDOFF.md` in `luminos-runner`, inspect the current runner scaffold, inspect the queue mutations in `discord-gateway/convex/tasks.ts`, and implement the next real runner slice. Assume single-machine V1 only. Add explicit completion and failure status handling if missing."
