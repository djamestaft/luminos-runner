export function buildCodexPrompt(task) {
  const taskTitle = task?.title?.trim() || "(untitled task)";
  const taskId = task?._id?.trim() || "unknown-task";

  return `You are executing a queued Luminos task inside an existing Git worktree.

Read \`TASK_BRIEF.md\`, \`luminos-task.json\`, and the local codebase before changing anything.

Task ID: ${taskId}
Task: ${taskTitle}

Requirements:
- Implement the requested task directly in this worktree.
- Follow any repo-local \`AGENTS.md\` instructions before making changes.
- For C#/.NET work, inspect the relevant \`.sln\` or \`.csproj\` files first and use Context7 with the official .NET docs (\`/dotnet/docs\`) when current framework, ASP.NET Core, EF Core, or \`dotnet\` CLI behavior matters.
- Prefer the smallest defensible change that completes the task.
- Run relevant validation when practical.
- Do not delete the worktree.
- Do not create or switch Git branches.
- Do not commit changes yourself; the wrapper handles commits after you finish.

When you are done, provide a short final summary of:
- what changed
- what you validated
- any remaining risks or follow-ups
`;
}

export function buildCodexExecArgs({ worktreePath, outputPath, model, profile, command }) {
  const file = command?.trim() || "codex.cmd";
  const args = [
    "exec",
    "--cd",
    worktreePath,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message",
    outputPath,
    "-"
  ];

  if (model?.trim()) {
    args.splice(1, 0, "--model", model.trim());
  }

  if (profile?.trim()) {
    args.splice(1, 0, "--profile", profile.trim());
  }

  return {
    file,
    args
  };
}
