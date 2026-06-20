#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktree = args.worktree ? path.resolve(args.worktree) : process.cwd();
const taskId = args["task-id"] ?? process.env.LUMINOS_TASK_ID;
const branch = args.branch ?? process.env.LUMINOS_TASK_BRANCH;

if (!taskId) {
  fail("Missing required --task-id");
}

if (!branch) {
  fail("Missing required --branch");
}

await mkdir(path.join(worktree, ".luminos"), { recursive: true });

const context = {
  taskId,
  branch,
  worktree,
  runnerRoot,
  startedAt: new Date().toISOString(),
  plannerCommand: process.env.PI_PLANNER_COMMAND ?? "",
  implementorCommand: process.env.PI_IMPLEMENTOR_COMMAND ?? "",
  reviewerCommand: process.env.PI_REVIEWER_COMMAND ?? "",
  autoCommit: parseBoolean(process.env.PI_AUTO_COMMIT, true),
  autoCommitMessage:
    process.env.PI_AUTO_COMMIT_MESSAGE?.trim() || `PI implementation for ${taskId}`
};

await writeFile(path.join(worktree, ".luminos", "pi-run-context.json"), JSON.stringify(context, null, 2));

const plannerPlanState = await capturePlanState(worktree);
await runPhase("planner", worktree, taskId, branch, context.plannerCommand);
await maybePostPlannerResultToDiscord(worktree, taskId, branch, plannerPlanState);
await runPhase("implementor", worktree, taskId, branch, context.implementorCommand);
await runPhase("reviewer", worktree, taskId, branch, context.reviewerCommand);

if (context.autoCommit) {
  await autoCommit(worktree, context.autoCommitMessage);
}

process.exit(0);

async function runPhase(phase, worktreePath, currentTaskId, currentBranch, template) {
  if (!template.trim()) {
    console.log(
      JSON.stringify({
        event: "pi_phase_skipped",
        phase,
        reason: "missing_command",
        taskId: currentTaskId
      })
    );
    return;
  }

  const command = interpolate(template, {
    runnerRoot,
    worktree: worktreePath,
    taskId: currentTaskId,
    branch: currentBranch,
    phase
  });

  console.log(
    JSON.stringify({
      event: "pi_phase_started",
      phase,
      taskId: currentTaskId,
      branch: currentBranch,
      command
    })
  );

  await runShell(command, {
    cwd: worktreePath,
    env: {
      ...process.env,
      LUMINOS_TASK_ID: currentTaskId,
      LUMINOS_TASK_BRANCH: currentBranch,
      LUMINOS_WORKTREE_PATH: worktreePath,
      LUMINOS_RUNNER_ROOT: runnerRoot,
      LUMINOS_PI_PHASE: phase
    }
  });

  console.log(
    JSON.stringify({
      event: "pi_phase_finished",
      phase,
      taskId: currentTaskId
    })
  );
}

async function autoCommit(worktreePath, commitMessage) {
  const status = await runCommand("git", ["-C", worktreePath, "status", "--porcelain"]);
  if (!status.stdout.trim()) {
    console.log(
      JSON.stringify({
        event: "pi_auto_commit_skipped",
        reason: "no_changes"
      })
    );
    return;
  }

  await runCommand("git", ["-C", worktreePath, "add", "-A"]);
  const stagedStatus = await runCommand("git", ["-C", worktreePath, "diff", "--cached", "--name-only"]);
  if (!stagedStatus.stdout.trim()) {
    console.log(
      JSON.stringify({
        event: "pi_auto_commit_skipped",
        reason: "nothing_staged"
      })
    );
    return;
  }

  await runCommand("git", ["-C", worktreePath, "commit", "-m", commitMessage], {
    stdio: "inherit"
  });

  const head = await runCommand("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
  console.log(
    JSON.stringify({
      event: "pi_auto_commit_finished",
      commitSha: head.stdout.trim()
    })
  );
}

async function maybePostPlannerResultToDiscord(worktreePath, currentTaskId, currentBranch, previousPlanState) {
  if (!parseBoolean(process.env.POST_PLANNER_TO_DISCORD, false)) {
    return;
  }

  const task = await readTaskPayload(worktreePath);
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  const channelId = task?.discordChannelId?.trim();

  if (!botToken && !webhookUrl) {
    console.log(
      JSON.stringify({
        event: "planner_discord_post_skipped",
        reason: "missing_discord_credentials",
        taskId: currentTaskId
      })
    );
    return;
  }

  const plan = await findPlannerOutput(worktreePath, previousPlanState);
  if (!plan) {
    console.log(
      JSON.stringify({
        event: "planner_discord_post_skipped",
        reason: "missing_plan_file",
        taskId: currentTaskId
      })
    );
    return;
  }

  const message = formatPlannerDiscordMessage({
    taskId: currentTaskId,
    branch: currentBranch,
    taskTitle: task?.title,
    relativePlanPath: plan.relativePath,
    markdown: plan.content
  });

  if (botToken && channelId) {
    await postChannelMessages(channelId, botToken, splitDiscordMessage(message));
    console.log(
      JSON.stringify({
        event: "planner_discord_posted",
        destination: "channel",
        taskId: currentTaskId,
        channelId,
        planPath: plan.relativePath
      })
    );
    return;
  }

  if (webhookUrl) {
    await postWebhookMessages(webhookUrl, splitDiscordMessage(message));
    console.log(
      JSON.stringify({
        event: "planner_discord_posted",
        destination: "webhook",
        taskId: currentTaskId,
        planPath: plan.relativePath
      })
    );
    return;
  }

  console.log(
    JSON.stringify({
      event: "planner_discord_post_skipped",
      reason: "missing_channel_id_for_bot_post",
      taskId: currentTaskId
    })
  );
}

function interpolate(template, variables) {
  return template.replace(/\{(runnerRoot|worktree|taskId|branch|phase)\}/g, (_, key) => variables[key]);
}

async function readTaskPayload(worktreePath) {
  const taskPath = path.join(worktreePath, "luminos-task.json");
  try {
    const raw = await readFile(taskPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function capturePlanState(worktreePath) {
  const planFiles = await listPlanFiles(worktreePath);
  return new Map(planFiles.map((file) => [file.relativePath, file.mtimeMs]));
}

async function findPlannerOutput(worktreePath, previousPlanState) {
  const planFiles = await listPlanFiles(worktreePath);
  const changedFiles = planFiles
    .filter((file) => {
      const previousMtime = previousPlanState.get(file.relativePath);
      return previousMtime == null || previousMtime !== file.mtimeMs;
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const selected = changedFiles[0] ?? planFiles.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!selected) {
    return null;
  }

  return {
    relativePath: selected.relativePath,
    content: await readFile(selected.absolutePath, "utf8")
  };
}

async function listPlanFiles(worktreePath) {
  const planDir = path.join(worktreePath, "orchestration", "plans");
  let entries;
  try {
    entries = await readdir(planDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map(async (entry) => {
        const absolutePath = path.join(planDir, entry.name);
        const stat = await import("node:fs/promises").then((fs) => fs.stat(absolutePath));
        return {
          absolutePath,
          relativePath: path.relative(worktreePath, absolutePath).replace(/\\/g, "/"),
          mtimeMs: stat.mtimeMs
        };
      })
  );

  return files;
}

function formatPlannerDiscordMessage({ taskId, branch, taskTitle, relativePlanPath, markdown }) {
  const title = taskTitle?.trim() || "(untitled task)";
  const trimmedMarkdown = markdown.trim() || "(empty plan)";
  return [
    "## Planner Output",
    `Task: ${title}`,
    `Task ID: ${taskId}`,
    `Branch: ${branch}`,
    `Plan File: ${relativePlanPath}`,
    "",
    trimmedMarkdown
  ].join("\n");
}

function splitDiscordMessage(text, limit = 1900) {
  const remaining = text.trim() || "(empty message)";
  const chunks = [];
  let cursor = remaining;

  while (cursor.length > limit) {
    let splitAt = cursor.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit / 2)) {
      splitAt = limit;
    }
    chunks.push(cursor.slice(0, splitAt).trim());
    cursor = cursor.slice(splitAt).trim();
  }

  if (cursor) {
    chunks.push(cursor);
  }

  return chunks;
}

async function postChannelMessages(channelId, botToken, chunks) {
  for (const content of chunks) {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Discord channel post failed (${response.status}): ${body}`);
    }
  }
}

async function postWebhookMessages(webhookUrl, chunks) {
  for (const content of chunks) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        username: "Luminos Planner"
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Discord webhook post failed (${response.status}): ${body}`);
    }
  }
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function parseBoolean(value, fallback) {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function runShell(command, options) {
  const stdout = [];
  const stderr = [];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" ? "cmd.exe" : true
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    }

    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const stderrText = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(`Command failed (${exitCode}): ${command}${stderrText ? `\n${stderrText}` : ""}`);
  }

  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  };
}

async function runCommand(file, args, options = {}) {
  const stdout = [];
  const stderr = [];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"]
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    }

    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const stderrText = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(`Command failed (${exitCode}): ${file} ${args.join(" ")}${stderrText ? `\n${stderrText}` : ""}`);
  }

  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  };
}
