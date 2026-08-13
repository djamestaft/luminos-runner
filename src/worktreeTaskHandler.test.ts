import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { RunnerConfig, TaskView } from "./types.js";
import { TaskExecutionError, WorktreeTaskHandler } from "./worktreeTaskHandler.js";

test("WorktreeTaskHandler creates a worktree, writes context, invokes wrapper, and requires a commit", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "luminos-runner-"));
  const repoRoot = path.join(tempRoot, "repo");
  const worktreeRoot = path.join(tempRoot, "worktrees");
  const wrapperPath = path.join(tempRoot, "wrapper-success.mjs");

  await initializeRepo(repoRoot);
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(
    wrapperPath,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
writeFileSync(join(process.cwd(), "implemented.txt"), process.argv.slice(2).join("\\n"));
for (const args of [["add", "."], ["commit", "-m", "Implement task"]]) {
  const result = spawnSync("git", args, { cwd: process.cwd(), stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
`
  );

  const config = createConfig({
    repoRoot,
    worktreeRoot,
    piCommand: `"${process.execPath}" "${wrapperPath}"`
  });
  const handler = new WorktreeTaskHandler(config);
  const task = createTask();

  const result = await handler.run(task);

  assert.equal(result.status, "in_review");
  assert.match(result.branchName, /^luminos\//);
  assert.match(result.commitSha, /^[0-9a-f]{40}$/);
  assert.ok(result.summary.includes(result.branchName));
  assert.ok(result.summary.includes(result.worktreePath));

  const taskPayload = JSON.parse(await readFile(path.join(result.worktreePath, "luminos-task.json"), "utf8"));
  const runnerMetadata = JSON.parse(await readFile(path.join(result.worktreePath, "luminos-runner.json"), "utf8"));
  const brief = await readFile(path.join(result.worktreePath, "TASK_BRIEF.md"), "utf8");
  const wrapperOutput = await readFile(path.join(result.worktreePath, "implemented.txt"), "utf8");

  assert.equal(taskPayload._id, task._id);
  assert.equal(runnerMetadata.branchName, result.branchName);
  assert.ok(brief.includes(task.title));
  assert.ok(wrapperOutput.includes("--task-id"));
  assert.equal(
    (await runCommand("git", ["-C", result.worktreePath, "rev-list", "--count", "main..HEAD"])).trim(),
    "1"
  );
});

test("WorktreeTaskHandler fails the task when the wrapper exits non-zero and leaves the worktree on disk", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "luminos-runner-"));
  const repoRoot = path.join(tempRoot, "repo");
  const worktreeRoot = path.join(tempRoot, "worktrees");
  const wrapperPath = path.join(tempRoot, "wrapper-fail.mjs");

  await initializeRepo(repoRoot);
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(wrapperPath, `process.exit(7);\n`);

  const config = createConfig({
    repoRoot,
    worktreeRoot,
    piCommand: `"${process.execPath}" "${wrapperPath}"`
  });
  const handler = new WorktreeTaskHandler(config);
  const task = createTask();

  await assert.rejects(
    () => handler.run(task),
    (error: unknown) => {
      assert.ok(error instanceof TaskExecutionError);
      assert.match(error.message, /exited with code 7/);
      assert.ok(error.worktreePath);
      return true;
    }
  );

  const entries = await readDirNames(worktreeRoot);
  assert.equal(entries.length, 1);
});

test("WorktreeTaskHandler fails the task when the wrapper exits zero without creating a commit", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "luminos-runner-"));
  const repoRoot = path.join(tempRoot, "repo");
  const worktreeRoot = path.join(tempRoot, "worktrees");
  const wrapperPath = path.join(tempRoot, "wrapper-no-commit.mjs");

  await initializeRepo(repoRoot);
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(wrapperPath, `process.exit(0);\n`);

  const config = createConfig({
    repoRoot,
    worktreeRoot,
    piCommand: `"${process.execPath}" "${wrapperPath}"`
  });
  const handler = new WorktreeTaskHandler(config);

  await assert.rejects(
    () => handler.run(createTask()),
    (error: unknown) => {
      assert.ok(error instanceof TaskExecutionError);
      assert.match(error.message, /without creating a commit/);
      return true;
    }
  );
});

test("WorktreeTaskHandler keeps branch and worktree names short for Windows-heavy repos", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "luminos-runner-"));
  const repoRoot = path.join(tempRoot, "repo");
  const worktreeRoot = path.join(tempRoot, "worktrees");
  const wrapperPath = path.join(tempRoot, "wrapper-success.mjs");

  await initializeRepo(repoRoot);
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(
    wrapperPath,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
writeFileSync(join(process.cwd(), "implemented.txt"), "ok");
for (const args of [["add", "."], ["commit", "-m", "Implement task"]]) {
  const result = spawnSync("git", args, { cwd: process.cwd(), stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
`
  );

  const config = createConfig({
    repoRoot,
    worktreeRoot,
    piCommand: `"${process.execPath}" "${wrapperPath}"`
  });
  const handler = new WorktreeTaskHandler(config);

  const result = await handler.run({
    ...createTask(),
    _id: "jd793rmae8j7s4hrzeqt8et20s890ty2",
    title: "Analyze codebase and refactor with clean architecture boundaries"
  });

  assert.ok(result.branchName.length <= 58, `branch too long: ${result.branchName.length}`);
  assert.ok(result.worktreePath.length < 120, `worktree path too long: ${result.worktreePath.length}`);
});

test("WorktreeTaskHandler uses a distinct branch per attempt for the same task", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "luminos-runner-"));
  const repoRoot = path.join(tempRoot, "repo");
  const worktreeRoot = path.join(tempRoot, "worktrees");
  const wrapperPath = path.join(tempRoot, "wrapper-success.mjs");

  await initializeRepo(repoRoot);
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(
    wrapperPath,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
writeFileSync(join(process.cwd(), "implemented.txt"), "ok");
for (const args of [["add", "."], ["commit", "-m", "Implement task"]]) {
  const result = spawnSync("git", args, { cwd: process.cwd(), stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
`
  );

  const config = createConfig({
    repoRoot,
    worktreeRoot,
    piCommand: `"${process.execPath}" "${wrapperPath}"`
  });
  const handler = new WorktreeTaskHandler(config);

  const attemptOne = await handler.run({
    ...createTask(),
    _id: "same-task-id",
    title: "Analyze codebase and refactor",
    attempt: 1
  });

  const attemptTwo = await handler.run({
    ...createTask(),
    _id: "same-task-id",
    title: "Analyze codebase and refactor",
    attempt: 2
  });

  assert.notEqual(attemptOne.branchName, attemptTwo.branchName);
  assert.match(attemptOne.branchName, /-a1-/);
  assert.match(attemptTwo.branchName, /-a2-/);
});

test("WorktreeTaskHandler pushes the task branch when configured", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "luminos-runner-"));
  const repoRoot = path.join(tempRoot, "repo");
  const remoteRoot = path.join(tempRoot, "remote.git");
  const worktreeRoot = path.join(tempRoot, "worktrees");
  const wrapperPath = path.join(tempRoot, "wrapper-success.mjs");

  await initializeRepo(repoRoot);
  await runCommand("git", ["init", "--bare", remoteRoot]);
  await runCommand("git", ["-C", repoRoot, "remote", "add", "origin", remoteRoot]);
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(
    wrapperPath,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
writeFileSync(join(process.cwd(), "implemented.txt"), "ok");
for (const args of [["add", "."], ["commit", "-m", "Implement task"]]) {
  const result = spawnSync("git", args, { cwd: process.cwd(), stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
`
  );

  const config = createConfig({
    repoRoot,
    worktreeRoot,
    piCommand: `"${process.execPath}" "${wrapperPath}"`,
    pushOnSuccess: true
  });
  const handler = new WorktreeTaskHandler(config);

  const result = await handler.run(createTask());
  const remoteHead = (
    await runCommand("git", ["--git-dir", remoteRoot, "rev-parse", result.branchName])
  ).trim();

  assert.equal(remoteHead, result.commitSha);
  assert.ok(result.summary.includes(`Pushed: origin/${result.branchName}`));
});

const createConfig = (overrides: Partial<RunnerConfig>): RunnerConfig => ({
  convexUrl: "https://example.convex.cloud",
  convexToken: undefined,
  runnerId: "runner-1",
  hostName: "host-1",
  version: "0.1.0",
  pollIntervalMs: 10,
  heartbeatIntervalMs: 10,
  leaseDurationMs: 1_000,
  repoRoot: "",
  worktreeRoot: "",
  baseBranch: "main",
  piCommand: "",
  pushOnSuccess: false,
  pushRemote: "origin",
  ...overrides
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

const initializeRepo = async (repoRoot: string): Promise<void> => {
  await mkdir(repoRoot, { recursive: true });
  await runCommand("git", ["init", "-b", "main", repoRoot]);
  await runCommand("git", ["-C", repoRoot, "config", "user.email", "runner@example.com"]);
  await runCommand("git", ["-C", repoRoot, "config", "user.name", "Luminos Runner"]);
  await writeFile(path.join(repoRoot, "README.md"), "# Test Repo\n");
  await runCommand("git", ["-C", repoRoot, "add", "."]);
  await runCommand("git", ["-C", repoRoot, "commit", "-m", "Initial commit"]);
};

const readDirNames = async (targetPath: string): Promise<string[]> => {
  const { readdir } = await import("node:fs/promises");
  return readdir(targetPath);
};

const runCommand = async (file: string, args: string[]): Promise<string> => {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(Buffer.concat(stderrChunks).toString("utf8"));
  }

  return Buffer.concat(stdoutChunks).toString("utf8");
};
