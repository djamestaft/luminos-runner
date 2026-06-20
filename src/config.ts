import path from "node:path";
import os from "node:os";

import type { RunnerConfig } from "./types.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};

const parseNumber = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }
  return value;
};

const resolveRepoRoot = (): string => required("SOURCE_REPO_ROOT");

const resolveWorktreeRoot = (): string =>
  process.env.WORKTREE_ROOT?.trim() || path.resolve(process.cwd(), "task-worktrees");

export const loadConfig = (): RunnerConfig => ({
  convexUrl: required("CONVEX_URL"),
  convexToken: process.env.CONVEX_TOKEN?.trim() || undefined,
  runnerId: process.env.RUNNER_ID?.trim() || `windows-runner-${os.hostname()}`,
  hostName: process.env.RUNNER_HOST_NAME?.trim() || os.hostname(),
  version: process.env.RUNNER_VERSION?.trim() || "0.1.0",
  pollIntervalMs: parseNumber("POLL_INTERVAL_MS", 5_000),
  heartbeatIntervalMs: parseNumber("HEARTBEAT_INTERVAL_MS", 1_800_000),
  leaseDurationMs: parseNumber("LEASE_DURATION_MS", 300_000),
  repoRoot: resolveRepoRoot(),
  worktreeRoot: resolveWorktreeRoot(),
  baseBranch: process.env.BASE_BRANCH?.trim() || "main",
  piCommand: required("PI_COMMAND")
});
