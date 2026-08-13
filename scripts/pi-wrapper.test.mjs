import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCodexExecArgs,
  buildCodexPrompt
} from "./codex-wrapper-lib.mjs";
import {
  captureMarkdownState,
  findUpdatedMarkdownFile,
  formatDiscordThreadName,
  formatClarifyingQuestionsDiscordMessage,
  formatRunnerStatusDiscordMessage,
  resolveDiscordChannelId,
  splitDiscordMessage
} from "./pi-wrapper-lib.mjs";

test("resolveDiscordChannelId prefers thread id over channel id", () => {
  assert.equal(
    resolveDiscordChannelId({ discordThreadId: "thread-123", discordChannelId: "channel-456" }),
    "thread-123"
  );
  assert.equal(resolveDiscordChannelId({ discordChannelId: "channel-456" }), "channel-456");
  assert.equal(resolveDiscordChannelId({}), "");
});

test("splitDiscordMessage keeps chunks below the limit", () => {
  const chunks = splitDiscordMessage("a\n".repeat(2000), 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test("formatDiscordThreadName includes task id and trims long titles", () => {
  const shortName = formatDiscordThreadName("tasks:123", "Ship Discord updates");
  assert.equal(shortName, "tasks:123 Ship Discord updates");

  const longName = formatDiscordThreadName(
    "jd793rmae8j7s4hrzeqt8et20s890ty2",
    "analyze codebase and refactor with clean architecture boundaries and migration planning",
    60
  );
  assert.ok(longName.startsWith("jd793rmae8j7s4hrzeqt8et20s890ty2 "));
  assert.ok(longName.length <= 60);
});

test("findUpdatedMarkdownFile returns the newest changed markdown file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "luminos-wrapper-test-"));
  const questionDir = path.join(tempRoot, "orchestration", "questions");
  await mkdir(questionDir, { recursive: true });

  await writeFile(path.join(questionDir, "old.md"), "# Old\n");
  const previous = await captureMarkdownState(tempRoot, "orchestration/questions");

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(questionDir, "new.md"), "# New\nWhat edge case is expected?\n");

  const updated = await findUpdatedMarkdownFile(tempRoot, "orchestration/questions", previous);
  assert.ok(updated);
  assert.equal(updated.relativePath, "orchestration/questions/new.md");
  assert.match(updated.content, /What edge case is expected\?/);
});

test("formatRunnerStatusDiscordMessage and clarifying question message include task metadata", () => {
  const statusMessage = formatRunnerStatusDiscordMessage({
    taskId: "tasks:123",
    branch: "luminos/tasks-123",
    taskTitle: "Ship Discord updates",
    status: "needs input",
    phase: "planner",
    detail: "Waiting on task scope confirmation."
  });

  assert.match(statusMessage, /## Runner Update/);
  assert.match(statusMessage, /Phase: planner/);
  assert.match(statusMessage, /Waiting on task scope confirmation/);

  const questionMessage = formatClarifyingQuestionsDiscordMessage({
    taskId: "tasks:123",
    branch: "luminos/tasks-123",
    taskTitle: "Ship Discord updates",
    relativeQuestionPath: "orchestration/questions/planner.md",
    markdown: "1. Should this post into a thread or the parent channel?"
  });

  assert.match(questionMessage, /## Clarifying Questions/);
  assert.match(questionMessage, /Question File: orchestration\/questions\/planner.md/);
  assert.match(questionMessage, /thread or the parent channel/);
});

test("buildCodexPrompt includes task metadata and execution constraints", () => {
  const prompt = buildCodexPrompt({
    _id: "tasks:123",
    title: "Ship Discord updates"
  });

  assert.match(prompt, /Task ID: tasks:123/);
  assert.match(prompt, /Task: Ship Discord updates/);
  assert.match(prompt, /Do not commit changes yourself/);
});

test("buildCodexExecArgs builds a non-interactive codex exec command", () => {
  const command = buildCodexExecArgs({
    worktreePath: "C:\\tmp\\task",
    outputPath: "C:\\tmp\\task\\.luminos\\last.md",
    model: "gpt-5-codex",
    profile: "runner",
    command: "codex.cmd"
  });

  assert.equal(command.file, "codex.cmd");
  assert.deepEqual(command.args.slice(0, 5), ["exec", "--profile", "runner", "--model", "gpt-5-codex"]);
  assert.ok(command.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(command.args.includes("--output-last-message"));
});
