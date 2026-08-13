import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunnerConfig, TaskView } from "./types.js";
import type { RunnerClient } from "./convexRunnerClient.js";
import { Runner } from "./runner.js";
import type { TaskExecutionResult, TaskHandler } from "./worktreeTaskHandler.js";
import { TaskExecutionError } from "./worktreeTaskHandler.js";

test("Runner idles cleanly when no approved task is available", async () => {
  const calls = { complete: 0, fail: 0, heartbeat: 0, claim: 0 };
  const client: RunnerClient = {
    heartbeat: async () => {
      calls.heartbeat += 1;
      return "ok";
    },
    claimNextApprovedTask: async () => {
      calls.claim += 1;
      return null;
    },
    releaseTaskClaim: async () => ({ taskId: "unused", status: "approved" }),
    completeClaimedTask: async () => {
      calls.complete += 1;
      return { taskId: "unused", status: "in_review" };
    },
    failClaimedTask: async () => {
      calls.fail += 1;
      return { taskId: "unused", status: "failed" };
    },
    listRunnerPresence: async () => []
  };

  const handler: TaskHandler = {
    run: async () => {
      throw new Error("handler should not run");
    }
  };

  const runner = new Runner(createConfig(), { client, handler });
  await runner.runOnce();

  assert.equal(calls.claim, 1);
  assert.equal(calls.complete, 0);
  assert.equal(calls.fail, 0);
  assert.equal(calls.heartbeat, 1);
});

test("Runner completes a claimed task when the handler succeeds", async () => {
  const task = createTask();
  const completed: Array<{ taskId: string; status: string; summary?: string }> = [];
  const client: RunnerClient = {
    heartbeat: async () => "ok",
    claimNextApprovedTask: async () => task,
    releaseTaskClaim: async () => ({ taskId: task._id, status: "approved" }),
    completeClaimedTask: async (input) => {
      completed.push({ taskId: input.taskId, status: input.status, summary: input.summary });
      return { taskId: input.taskId, status: input.status };
    },
    failClaimedTask: async () => ({ taskId: task._id, status: "failed" }),
    listRunnerPresence: async () => []
  };

  const handler: TaskHandler = {
    run: async () =>
      ({
        status: "in_review",
        summary: "Branch: luminos/task\nWorktree: C:\\tmp\\task\nCommit: abc",
        branchName: "luminos/task",
        worktreePath: "C:\\tmp\\task",
        commitSha: "abc"
      }) satisfies TaskExecutionResult
  };

  const runner = new Runner(createConfig(), { client, handler });
  await runner.runOnce();

  assert.deepEqual(completed, [
    {
      taskId: task._id,
      status: "in_review",
      summary: "Branch: luminos/task\nWorktree: C:\\tmp\\task\nCommit: abc"
    }
  ]);
});

test("Runner marks a task failed and includes branch/worktree metadata when execution fails", async () => {
  const task = createTask();
  const failures: string[] = [];
  const client: RunnerClient = {
    heartbeat: async () => "ok",
    claimNextApprovedTask: async () => task,
    releaseTaskClaim: async () => ({ taskId: task._id, status: "approved" }),
    completeClaimedTask: async () => ({ taskId: task._id, status: "in_review" }),
    failClaimedTask: async (input) => {
      failures.push(input.errorMessage);
      return { taskId: input.taskId, status: "failed" };
    },
    listRunnerPresence: async () => []
  };

  const handler: TaskHandler = {
    run: async () => {
      throw new TaskExecutionError("Wrapper failed", {
        branchName: "luminos/task",
        worktreePath: "C:\\tmp\\task"
      });
    }
  };

  const runner = new Runner(createConfig(), { client, handler });
  await runner.runOnce();

  assert.equal(failures.length, 1);
  assert.match(failures[0], /Wrapper failed/);
  assert.match(failures[0], /Branch: luminos\/task/);
  assert.match(failures[0], /Worktree: C:\\tmp\\task/);
});

test("Runner releases the claim when failure status update is unavailable in Convex", async () => {
  const task = createTask();
  const releases: string[] = [];
  const client: RunnerClient = {
    heartbeat: async () => "ok",
    claimNextApprovedTask: async () => task,
    releaseTaskClaim: async (input) => {
      releases.push(input.reason ?? "");
      return { taskId: input.taskId, status: "approved" };
    },
    completeClaimedTask: async () => ({ taskId: task._id, status: "in_review" }),
    failClaimedTask: async () => {
      throw new Error(
        '{"code":"FunctionPathNotFound","message":"Could not find public function for \\"tasks:failClaimedTask\\"."}'
      );
    },
    listRunnerPresence: async () => []
  };

  const handler: TaskHandler = {
    run: async () => {
      throw new TaskExecutionError("Wrapper failed", {
        branchName: "luminos/task",
        worktreePath: "C:\\tmp\\task"
      });
    }
  };

  const runner = new Runner(createConfig(), { client, handler });
  await runner.runOnce();

  assert.equal(releases.length, 1);
  assert.match(releases[0], /Execution failed before terminal status update could be persisted/);
  assert.match(releases[0], /Wrapper failed/);
  assert.match(releases[0], /FunctionPathNotFound/);
});

const createConfig = (): RunnerConfig => ({
  convexUrl: "https://example.convex.cloud",
  convexToken: undefined,
  runnerId: "runner-1",
  hostName: "host-1",
  version: "0.1.0",
  pollIntervalMs: 10,
  heartbeatIntervalMs: 10,
  leaseDurationMs: 1_000,
  repoRoot: "C:\\repo",
  worktreeRoot: "C:\\worktrees",
  baseBranch: "main",
  piCommand: "pi-wrapper",
  pushOnSuccess: false,
  pushRemote: "origin"
});

const createTask = (): TaskView => ({
  _id: "tasks:abc123",
  title: "Implement PI runner",
  body: "Replace the artifact flow with a PI worktree flow.",
  status: "working",
  createdBy: "greg",
  approvedBy: "greg",
  claimedBy: "runner-1",
  leaseExpiresAt: Date.now() + 60_000,
  lastHeartbeatAt: Date.now(),
  attempt: 1
});
