import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export function parseBoolean(value, fallback) {
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

export function splitDiscordMessage(text, limit = 1900) {
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

export function resolveDiscordChannelId(task) {
  return task?.discordThreadId?.trim() || task?.discordChannelId?.trim() || "";
}

export function formatDiscordThreadName(taskId, taskTitle, maxLength = 90) {
  const normalizedTaskId = taskId?.trim() || "task";
  const normalizedTitle = taskTitle?.trim() || "task";
  const base = `${normalizedTaskId} ${normalizedTitle}`
    .replace(/\s+/g, " ")
    .trim();

  if (base.length <= maxLength) {
    return base;
  }

  return `${base.slice(0, maxLength - 1).trimEnd()}…`;
}

export function formatRunnerStatusDiscordMessage({
  taskId,
  branch,
  taskTitle,
  status,
  phase,
  detail
}) {
  const title = taskTitle?.trim() || "(untitled task)";
  const lines = [
    "## Runner Update",
    `Task: ${title}`,
    `Task ID: ${taskId}`,
    `Branch: ${branch}`,
    `Status: ${status}`
  ];

  if (phase) {
    lines.push(`Phase: ${phase}`);
  }

  if (detail?.trim()) {
    lines.push("", detail.trim());
  }

  return lines.join("\n");
}

export function formatPlannerDiscordMessage({ taskId, branch, taskTitle, relativePlanPath, markdown }) {
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

export function formatClarifyingQuestionsDiscordMessage({
  taskId,
  branch,
  taskTitle,
  relativeQuestionPath,
  markdown
}) {
  const title = taskTitle?.trim() || "(untitled task)";
  const trimmedMarkdown = markdown.trim() || "(no questions written)";
  return [
    "## Clarifying Questions",
    `Task: ${title}`,
    `Task ID: ${taskId}`,
    `Branch: ${branch}`,
    `Question File: ${relativeQuestionPath}`,
    "",
    trimmedMarkdown
  ].join("\n");
}

export async function captureMarkdownState(worktreePath, relativeDir) {
  const files = await listMarkdownFiles(worktreePath, relativeDir);
  return new Map(files.map((file) => [file.relativePath, file.mtimeMs]));
}

export async function findUpdatedMarkdownFile(worktreePath, relativeDir, previousState) {
  const files = await listMarkdownFiles(worktreePath, relativeDir);
  const changedFiles = files
    .filter((file) => {
      const previousMtime = previousState.get(file.relativePath);
      return previousMtime == null || previousMtime !== file.mtimeMs;
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const selected = changedFiles[0] ?? files.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!selected) {
    return null;
  }

  return {
    relativePath: selected.relativePath,
    content: await readFile(selected.absolutePath, "utf8")
  };
}

export async function listMarkdownFiles(worktreePath, relativeDir) {
  const absoluteDir = path.join(worktreePath, ...relativeDir.split("/"));
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map(async (entry) => {
        const absolutePath = path.join(absoluteDir, entry.name);
        const fileStat = await stat(absolutePath);
        return {
          absolutePath,
          relativePath: path.relative(worktreePath, absolutePath).replace(/\\/g, "/"),
          mtimeMs: fileStat.mtimeMs
        };
      })
  );

  return files;
}
