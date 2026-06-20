import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { RunnerConfig, TaskView } from "./types.js";

export interface TaskExecutionResult {
  status: "in_review";
  summary: string;
  branchName: string;
  worktreePath: string;
  commitSha: string;
}

export interface TaskHandler {
  run(task: TaskView): Promise<TaskExecutionResult>;
}

export class TaskExecutionError extends Error {
  public readonly branchName?: string;
  public readonly worktreePath?: string;
  public readonly commitSha?: string;

  public constructor(
    message: string,
    metadata: { branchName?: string; worktreePath?: string; commitSha?: string } = {}
  ) {
    super(message);
    this.name = "TaskExecutionError";
    this.branchName = metadata.branchName;
    this.worktreePath = metadata.worktreePath;
    this.commitSha = metadata.commitSha;
  }
}

export class WorktreeTaskHandler implements TaskHandler {
  public constructor(private readonly config: RunnerConfig) {}

  public async run(task: TaskView): Promise<TaskExecutionResult> {
    await this.ensureRepoLooksValid();
    await mkdir(this.config.worktreeRoot, { recursive: true });

    const branchName = buildBranchName(task);
    const worktreePath = buildWorktreePath(this.config.worktreeRoot, task);
    const baseCommit = await this.resolveBaseCommit();

    await assertPathMissing(worktreePath, `Worktree path already exists: ${worktreePath}`);
    await this.assertBranchMissing(branchName);
    await this.createWorktree(branchName, worktreePath);

    const preparedAt = new Date().toISOString();
    await writeContextFiles({
      config: this.config,
      task,
      branchName,
      worktreePath,
      preparedAt
    });

    const wrapperStartedAt = new Date().toISOString();
    const wrapperResult = await this.runWrapper(worktreePath, task._id, branchName);
    if (wrapperResult.exitCode !== 0) {
      throw new TaskExecutionError(
        `PI wrapper exited with code ${wrapperResult.exitCode} for task ${task._id}. Branch: ${branchName}. Worktree: ${worktreePath}.`,
        { branchName, worktreePath }
      );
    }

    const commitCountRaw = await this.git([
      "-C",
      worktreePath,
      "rev-list",
      "--count",
      `${baseCommit}..HEAD`
    ]);
    const commitCount = Number.parseInt(commitCountRaw.trim(), 10);
    if (!Number.isFinite(commitCount) || commitCount < 1) {
      throw new TaskExecutionError(
        `PI wrapper completed without creating a commit on branch ${branchName}. Worktree: ${worktreePath}.`,
        { branchName, worktreePath }
      );
    }

    const commitSha = (await this.git(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
    const summary = [
      `PI finished task "${task.title}" locally and left committed work ready for review.`,
      `Branch: ${branchName}`,
      `Worktree: ${worktreePath}`,
      `Commit: ${commitSha}`,
      `Base branch: ${this.config.baseBranch}`,
      `Wrapper started: ${wrapperStartedAt}`
    ].join("\n");

    console.log(
      JSON.stringify({
        event: "task_execution_succeeded",
        taskId: task._id,
        branchName,
        worktreePath,
        commitSha,
        baseBranch: this.config.baseBranch
      })
    );

    return {
      status: "in_review",
      summary,
      branchName,
      worktreePath,
      commitSha
    };
  }

  private async ensureRepoLooksValid(): Promise<void> {
    const repoRootStat = await stat(this.config.repoRoot).catch(() => null);
    if (!repoRootStat?.isDirectory()) {
      throw new TaskExecutionError(`Configured repo root does not exist: ${this.config.repoRoot}`);
    }

    const isWorkTree = (await this.git(["-C", this.config.repoRoot, "rev-parse", "--is-inside-work-tree"])).trim();
    if (isWorkTree !== "true") {
      throw new TaskExecutionError(`Configured repo root is not a Git work tree: ${this.config.repoRoot}`);
    }
  }

  private async resolveBaseCommit(): Promise<string> {
    return (
      await this.git([
        "-C",
        this.config.repoRoot,
        "rev-parse",
        "--verify",
        this.config.baseBranch
      ])
    ).trim();
  }

  private async assertBranchMissing(branchName: string): Promise<void> {
    try {
      await this.git(["-C", this.config.repoRoot, "show-ref", "--verify", `refs/heads/${branchName}`]);
    } catch {
      return;
    }
    throw new TaskExecutionError(`Task branch already exists: ${branchName}`);
  }

  private async createWorktree(branchName: string, worktreePath: string): Promise<void> {
    await this.git([
      "-C",
      this.config.repoRoot,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      this.config.baseBranch
    ]);
  }

  private async runWrapper(worktreePath: string, taskId: string, branchName: string): Promise<{ exitCode: number }> {
    const command = splitCommand(this.config.piCommand);
    if (command.length === 0) {
      throw new TaskExecutionError("PI wrapper command is empty");
    }

    const [file, ...args] = command;
    const wrapperArgs = [
      ...args,
      "--worktree",
      worktreePath,
      "--task-id",
      taskId,
      "--branch",
      branchName
    ];

    console.log(
      JSON.stringify({
        event: "task_wrapper_started",
        taskId,
        branchName,
        worktreePath,
        command: [file, ...wrapperArgs]
      })
    );

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(file, wrapperArgs, {
        cwd: worktreePath,
        stdio: "inherit",
        env: {
          ...process.env,
          LUMINOS_TASK_ID: taskId,
          LUMINOS_TASK_BRANCH: branchName,
          LUMINOS_WORKTREE_PATH: worktreePath
        },
        shell: shouldUseShell(file)
      });

      child.on("error", (error) =>
        reject(
          new TaskExecutionError(
            `Failed to start PI wrapper for task ${taskId}. Branch: ${branchName}. Worktree: ${worktreePath}. ${error.message}`,
            { branchName, worktreePath }
          )
        )
      );
      child.on("exit", (code) => resolve(code ?? 1));
    });

    return { exitCode };
  }

  private async git(args: string[]): Promise<string> {
    return runCommand("git", args);
  }
}

const buildBranchName = (task: TaskView): string => {
  const idPart = sanitizeSegment(task._id).slice(0, 36);
  const titlePart = sanitizeSegment(task.title).slice(0, 48);
  return `luminos/${idPart}-${titlePart}`.replace(/\/-+$/, "/task");
};

const buildWorktreePath = (worktreeRoot: string, task: TaskView): string =>
  path.join(
    worktreeRoot,
    `${sanitizeSegment(task._id).slice(0, 24)}-a${task.attempt}-${sanitizeSegment(task.title).slice(0, 48)}`
  );

const sanitizeSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-") || "task";

const assertPathMissing = async (targetPath: string, message: string): Promise<void> => {
  const exists = await access(targetPath)
    .then(() => true)
    .catch(() => false);

  if (exists) {
    throw new TaskExecutionError(message);
  }
};

const writeContextFiles = async ({
  config,
  task,
  branchName,
  worktreePath,
  preparedAt
}: {
  config: RunnerConfig;
  task: TaskView;
  branchName: string;
  worktreePath: string;
  preparedAt: string;
}): Promise<void> => {
  const taskPayload = {
    ...task,
    generatedAt: preparedAt
  };

  const runnerMetadata = {
    taskId: task._id,
    runnerId: config.runnerId,
    branchName,
    worktreePath,
    repoRoot: config.repoRoot,
    baseBranch: config.baseBranch,
    preparedAt,
    piCommand: config.piCommand
  };

  const taskBrief = `# Luminos Task Brief

Task ID: ${task._id}
Title: ${task.title}
Created By: ${task.createdBy}
Approved By: ${task.approvedBy ?? "unknown"}
Attempt: ${task.attempt}
Branch: ${branchName}
Worktree: ${worktreePath}
Base Branch: ${config.baseBranch}

## Task Body

${task.body}

## Runner Notes

1. The task payload source of truth is \`luminos-task.json\`.
2. Runner metadata is in \`luminos-runner.json\`.
3. Leave at least one commit on the task branch before exiting successfully.
4. Do not delete the worktree when finished.
`;

  await Promise.all([
    writeFile(path.join(worktreePath, "luminos-task.json"), JSON.stringify(taskPayload, null, 2)),
    writeFile(path.join(worktreePath, "TASK_BRIEF.md"), taskBrief),
    writeFile(path.join(worktreePath, "luminos-runner.json"), JSON.stringify(runnerMetadata, null, 2))
  ]);
};

const splitCommand = (command: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new TaskExecutionError(`PI wrapper command has an unmatched quote: ${command}`);
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const shouldUseShell = (file: string): boolean => process.platform === "win32" && /\.(cmd|bat)$/i.test(file);

const runCommand = async (file: string, args: string[]): Promise<string> => {
  const chunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const detail = stderr ? ` ${stderr}` : "";
    throw new TaskExecutionError(`Command failed: ${file} ${args.join(" ")}.${detail}`);
  }

  return Buffer.concat(chunks).toString("utf8");
};
