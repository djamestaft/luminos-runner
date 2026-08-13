#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildCodexExecArgs, buildCodexPrompt } from "./codex-wrapper-lib.mjs";
import {
  formatRunnerStatusDiscordMessage,
  parseBoolean,
  resolveDiscordChannelId,
  splitDiscordMessage,
  formatDiscordThreadName
} from "./pi-wrapper-lib.mjs";

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
  command: process.env.CODEX_COMMAND?.trim() || "codex.cmd",
  model: process.env.CODEX_MODEL?.trim() || "",
  profile: process.env.CODEX_PROFILE?.trim() || "",
  autoCommit: parseBoolean(process.env.PI_AUTO_COMMIT, true),
  autoCommitMessage: process.env.PI_AUTO_COMMIT_MESSAGE?.trim() || `Codex implementation for ${taskId}`
};

await writeFile(path.join(worktree, ".luminos", "codex-run-context.json"), JSON.stringify(context, null, 2));

const task = await readTaskPayload(worktree);
let discordTargetState = null;

try {
  if (shouldPostTaskUpdatesToDiscord()) {
    await postTaskStatusToDiscord(task, {
      taskId,
      branch,
      status: "started",
      detail: "Runner claimed the task and started Codex execution."
    });
  }

  const outputPath = path.join(worktree, ".luminos", "codex-last-message.md");
  const prompt = buildCodexPrompt(task);
  await writeFile(path.join(worktree, ".luminos", "codex-prompt.md"), prompt);

  const execCommand = buildCodexExecArgs({
    worktreePath: worktree,
    outputPath,
    model: context.model,
    profile: context.profile,
    command: context.command
  });

  if (shouldPostTaskUpdatesToDiscord()) {
    await postTaskStatusToDiscord(task, {
      taskId,
      branch,
      status: "codex started",
      detail: "Codex is now running inside the task worktree."
    });
  }

  await runCommandWithInput(execCommand.file, execCommand.args, prompt, {
    cwd: worktree,
    env: {
      ...process.env,
      LUMINOS_TASK_ID: taskId,
      LUMINOS_TASK_BRANCH: branch,
      LUMINOS_WORKTREE_PATH: worktree,
      LUMINOS_RUNNER_ROOT: runnerRoot
    }
  });

  if (shouldPostTaskUpdatesToDiscord()) {
    await postTaskStatusToDiscord(task, {
      taskId,
      branch,
      status: "codex finished",
      detail: "Codex finished execution. Running local commit step next."
    });
  }

  if (context.autoCommit) {
    await autoCommit(worktree, context.autoCommitMessage);
  }

  if (shouldPostTaskUpdatesToDiscord()) {
    const summary = await readLastMessage(outputPath);
    await postTaskStatusToDiscord(task, {
      taskId,
      branch,
      status: "local execution complete",
      detail: summary || "Runner finished Codex execution and local commit handling."
    });
  }

  process.exit(0);
} catch (error) {
  if (shouldPostTaskUpdatesToDiscord()) {
    await postTaskStatusToDiscord(task, {
      taskId,
      branch,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
  }
  throw error;
}

async function autoCommit(worktreePath, commitMessage) {
  const status = await runCommand("git", ["-C", worktreePath, "status", "--porcelain"]);
  if (!status.stdout.trim()) {
    return;
  }

  await runCommand("git", ["-C", worktreePath, "add", "-A"]);
  const stagedStatus = await runCommand("git", ["-C", worktreePath, "diff", "--cached", "--name-only"]);
  if (!stagedStatus.stdout.trim()) {
    return;
  }

  await runCommand("git", ["-C", worktreePath, "commit", "-m", commitMessage], {
    stdio: "inherit"
  });
}

async function postTaskStatusToDiscord(task, update) {
  const message = formatRunnerStatusDiscordMessage({
    taskId: update.taskId,
    branch: update.branch,
    taskTitle: task?.title,
    status: update.status,
    detail: update.detail
  });

  await postDiscordMessage(task, update.taskId, splitDiscordMessage(message));
}

async function postDiscordMessage(task, currentTaskId, chunks) {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  const destination = await resolveDiscordDestination(task, currentTaskId, botToken);

  if (!botToken && !webhookUrl) {
    return;
  }

  if (botToken && destination?.channelId) {
    await postChannelMessages(destination.channelId, botToken, chunks);
    return;
  }

  if (webhookUrl) {
    await postWebhookMessages(webhookUrl, chunks);
  }
}

async function resolveDiscordDestination(task, currentTaskId, botToken) {
  if (discordTargetState?.channelId) {
    return discordTargetState;
  }

  const cachedThreadId = await readCachedDiscordThreadId(worktree);
  if (cachedThreadId) {
    discordTargetState = {
      kind: "thread",
      channelId: cachedThreadId
    };
    return discordTargetState;
  }

  const existingChannelId = resolveDiscordChannelId(task);
  if (task?.discordThreadId?.trim()) {
    discordTargetState = {
      kind: "thread",
      channelId: existingChannelId
    };
    return discordTargetState;
  }

  const tasksChannelId = process.env.DISCORD_TASKS_CHANNEL_ID?.trim();
  if (botToken && tasksChannelId) {
    const thread = await ensureTaskThread(tasksChannelId, botToken, currentTaskId, task?.title);
    if (thread?.id) {
      task.discordThreadId = thread.id;
      discordTargetState = {
        kind: "thread",
        channelId: thread.id,
        parentChannelId: tasksChannelId
      };
      await writeCachedDiscordThreadId(worktree, thread.id);
      return discordTargetState;
    }
  }

  if (existingChannelId) {
    discordTargetState = {
      kind: "channel",
      channelId: existingChannelId
    };
    return discordTargetState;
  }

  return null;
}

async function ensureTaskThread(parentChannelId, botToken, currentTaskId, taskTitle) {
  const initialMessage = await postChannelMessage(parentChannelId, botToken, {
    content: [
      "## Task Thread",
      `Task ID: ${currentTaskId}`,
      `Task: ${taskTitle?.trim() || "(untitled task)"}`,
      "",
      "Runner updates for this task will be posted in this thread."
    ].join("\n")
  });

  const response = await fetch(
    `https://discord.com/api/v10/channels/${parentChannelId}/messages/${initialMessage.id}/threads`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: formatDiscordThreadName(currentTaskId, taskTitle),
        auto_archive_duration: 1440
      })
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord thread create failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function readCachedDiscordThreadId(worktreePath) {
  const statePath = path.join(worktreePath, ".luminos", "discord-thread.json");
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.threadId === "string" && parsed.threadId.trim() ? parsed.threadId.trim() : "";
  } catch {
    return "";
  }
}

async function writeCachedDiscordThreadId(worktreePath, threadId) {
  const statePath = path.join(worktreePath, ".luminos", "discord-thread.json");
  await writeFile(statePath, JSON.stringify({ threadId }, null, 2));
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

async function readLastMessage(outputPath) {
  try {
    return (await readFile(outputPath, "utf8")).trim();
  } catch {
    return "";
  }
}

function shouldPostTaskUpdatesToDiscord() {
  return parseBoolean(process.env.POST_TASK_UPDATES_TO_DISCORD, parseBoolean(process.env.POST_PLANNER_TO_DISCORD, false));
}

async function postChannelMessages(channelId, botToken, chunks) {
  for (const content of chunks) {
    await postChannelMessage(channelId, botToken, { content });
  }
}

async function postChannelMessage(channelId, botToken, body) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Discord channel post failed (${response.status}): ${errorBody}`);
  }

  return response.json();
}

async function postWebhookMessages(webhookUrl, chunks) {
  for (const content of chunks) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        username: "Luminos Runner"
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

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function runCommandWithInput(file, args, input, options = {}) {
  const stdout = [];
  const stderr = [];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: shouldUseShell(file)
    });

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
    child.stdin.end(input);
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

function shouldUseShell(file) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
}
