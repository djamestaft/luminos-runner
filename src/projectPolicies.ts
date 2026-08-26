import path from "node:path";
import { open } from "node:fs/promises";
import type { ProjectPolicy } from "./broker.js";

const MAX_PROJECT_POLICY_BYTES = 65_536;
const MAX_PROJECTS = 16;
const LEGACY_PROJECT_KEYS = [
  "BROKER_PROJECT_KEY",
  "BROKER_REPO_ROOT",
  "BROKER_WORKTREE_ROOT",
  "BROKER_EXPECTED_REMOTE_URL",
  "BROKER_GITHUB_REPO",
  "BROKER_GIT_REMOTE",
  "BROKER_BASE_REF",
  "BROKER_BASE_BRANCH",
  "BROKER_PROFILES",
] as const;

const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported project policy field");
};
const text = (name: string, value: unknown, maximum = 512): string => {
  if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
};
const logical = (name: string, value: unknown): string => {
  const resolved = text(name, value, 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(resolved)) throw new Error(`Invalid ${name}`);
  return resolved;
};
const localRoot = (name: string, value: unknown): string => {
  const resolved = text(name, value, 4_096);
  if (!path.isAbsolute(resolved)) throw new Error(`${name} must be absolute`);
  return path.normalize(resolved);
};
const gitRemote = (value: unknown): string => {
  const resolved = text("git remote", value ?? "origin", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(resolved)) throw new Error("Invalid git remote");
  return resolved;
};
const baseBranch = (value: unknown): string => {
  const resolved = text("base branch", value ?? "main", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(resolved) || resolved.includes("..") || resolved.includes("//") || resolved.includes("@{") || resolved.endsWith(".lock") || resolved.endsWith("/") || resolved.endsWith(".")) throw new Error("Invalid base branch");
  return resolved;
};
const githubRepo = (value: unknown): string => {
  const resolved = text("GitHub repository", value, 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolved)) throw new Error("Invalid GitHub repository");
  return resolved;
};
const expectedRemoteUrl = (value: unknown, repository: string): string => {
  const resolved = text("expected remote URL", value, 512);
  const allowed = new Set([
    `https://github.com/${repository}`,
    `https://github.com/${repository}.git`,
    `git@github.com:${repository}.git`,
    `ssh://git@github.com/${repository}.git`,
  ]);
  if (!allowed.has(resolved)) throw new Error("Expected remote URL does not match GitHub repository");
  return resolved;
};
const profiles = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("Invalid project profiles");
  const resolved = value.map(profile => logical("profile", profile));
  if (new Set(resolved).size !== resolved.length) throw new Error("Duplicate project profile");
  return resolved;
};
const rootsOverlap = (left: string, right: string): boolean => {
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  const a = normalize(left); const b = normalize(right);
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  return contains(a, b) || contains(b, a);
};

export const parseProjectPolicies = (input: unknown): ReadonlyMap<string, ProjectPolicy> => {
  const root = object(input);
  if (!root) throw new Error("Invalid project policy registry");
  exact(root, ["version", "projects"]);
  if (root.version !== 1 || !Array.isArray(root.projects) || root.projects.length < 1 || root.projects.length > MAX_PROJECTS) throw new Error("Invalid project policy registry");
  const policies = new Map<string, ProjectPolicy>();
  const protectedRoots: string[] = [];
  for (const entry of root.projects) {
    const value = object(entry);
    if (!value) throw new Error("Invalid project policy");
    exact(value, ["project", "repoRoot", "worktreeRoot", "remote", "expectedRemoteUrl", "baseBranch", "githubRepo", "profiles"]);
    const project = logical("project", value.project);
    if (policies.has(project)) throw new Error("Duplicate project policy");
    const repoRoot = localRoot("repository root", value.repoRoot);
    const worktreeRoot = localRoot("worktree root", value.worktreeRoot);
    if (rootsOverlap(repoRoot, worktreeRoot) || protectedRoots.some(existing => rootsOverlap(existing, repoRoot) || rootsOverlap(existing, worktreeRoot))) throw new Error("Duplicate or overlapping project roots");
    const remote = gitRemote(value.remote);
    const branch = baseBranch(value.baseBranch);
    const repository = githubRepo(value.githubRepo);
    const policy: ProjectPolicy = {
      project,
      repoRoot,
      worktreeRoot,
      remote,
      expectedRemoteUrl: expectedRemoteUrl(value.expectedRemoteUrl, repository),
      baseRef: `${remote}/${branch}`,
      baseBranch: branch,
      githubRepo: repository,
      profiles: profiles(value.profiles),
    };
    policies.set(project, policy);
    protectedRoots.push(repoRoot, worktreeRoot);
  }
  return policies;
};

export const loadProtectedProjectPolicies = async (filePath: string): Promise<ReadonlyMap<string, ProjectPolicy>> => {
  if (!path.isAbsolute(filePath)) throw new Error("Protected project policy path must be absolute");
  const file = await open(filePath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_PROJECT_POLICY_BYTES) throw new Error("Invalid protected project policy file");
    if (process.platform !== "win32") {
      if ((metadata.mode & 0o077) !== 0) throw new Error("Protected project policy must not be group/world accessible");
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid() && process.getuid() !== 0) throw new Error("Protected project policy owner mismatch");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await file.readFile("utf8")); } catch { throw new Error("Invalid protected project policy JSON"); }
    return parseProjectPolicies(parsed);
  } finally {
    await file.close();
  }
};

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const loadProjectPoliciesFromEnvironment = async (environment: NodeJS.ProcessEnv = process.env): Promise<ReadonlyMap<string, ProjectPolicy>> => {
  const registry = environment.BROKER_PROJECTS_FILE;
  const legacyPresent = LEGACY_PROJECT_KEYS.some(name => environment[name] !== undefined);
  if (registry) {
    if (legacyPresent) throw new Error("Ambiguous project policy configuration");
    return loadProtectedProjectPolicies(registry);
  }
  const project = required(environment, "BROKER_PROJECT_KEY");
  const policy: ProjectPolicy = {
    project,
    repoRoot: required(environment, "BROKER_REPO_ROOT"),
    worktreeRoot: required(environment, "BROKER_WORKTREE_ROOT"),
    remote: environment.BROKER_GIT_REMOTE ?? "origin",
    expectedRemoteUrl: required(environment, "BROKER_EXPECTED_REMOTE_URL"),
    baseRef: environment.BROKER_BASE_REF ?? "origin/main",
    baseBranch: environment.BROKER_BASE_BRANCH ?? "main",
    githubRepo: required(environment, "BROKER_GITHUB_REPO"),
    profiles: (environment.BROKER_PROFILES ?? "default").split(",").map(value => value.trim()).filter(Boolean),
  };
  return new Map([[policy.project, policy]]);
};
