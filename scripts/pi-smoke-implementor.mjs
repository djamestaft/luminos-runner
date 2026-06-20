#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const worktree = process.env.LUMINOS_WORKTREE_PATH ?? process.cwd();
const taskId = process.env.LUMINOS_TASK_ID ?? "unknown-task";
const branch = process.env.LUMINOS_TASK_BRANCH ?? "unknown-branch";

const briefPath = path.join(worktree, "TASK_BRIEF.md");
const brief = await readFile(briefPath, "utf8").catch(() => "TASK_BRIEF.md not found");

const output = `# PI Smoke Output

Task ID: ${taskId}
Branch: ${branch}
Generated At: ${new Date().toISOString()}

This file proves the wrapper executed inside the task worktree.

## Brief Excerpt

${brief.slice(0, 1000)}
`;

await writeFile(path.join(worktree, "PI_SMOKE_OUTPUT.md"), output);
console.log(`Wrote PI_SMOKE_OUTPUT.md for ${taskId}`);
