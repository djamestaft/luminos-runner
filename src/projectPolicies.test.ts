import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectPoliciesFromEnvironment, loadProtectedProjectPolicies, parseProjectPolicies } from "./projectPolicies.js";

const registry = () => ({
  version: 1,
  projects: [
    { project: "lmns", repoRoot: "/protected/lmns", worktreeRoot: "/protected/worktrees/lmns", expectedRemoteUrl: "git@github.com:djamestaft/lmns.git", githubRepo: "djamestaft/lmns", profiles: ["default"] },
    { project: "reghub", repoRoot: "/protected/reghub", worktreeRoot: "/protected/worktrees/reghub", remote: "upstream", expectedRemoteUrl: "https://github.com/company/reghub.git", baseBranch: "develop", githubRepo: "company/reghub", profiles: ["read", "controlled_test"] },
  ],
});

test("parses multiple exact protected project and profile mappings", () => {
  const policies = parseProjectPolicies(registry());
  assert.equal(policies.size, 2);
  assert.deepEqual(policies.get("lmns"), { project: "lmns", repoRoot: path.normalize("/protected/lmns"), worktreeRoot: path.normalize("/protected/worktrees/lmns"), remote: "origin", expectedRemoteUrl: "git@github.com:djamestaft/lmns.git", baseRef: "origin/main", baseBranch: "main", githubRepo: "djamestaft/lmns", profiles: ["default"] });
  assert.equal(policies.get("reghub")?.baseRef, "upstream/develop");
  assert.deepEqual(policies.get("reghub")?.profiles, ["read", "controlled_test"]);
});

test("rejects duplicate, unknown, relative and mismatched project policy values", () => {
  const cases: unknown[] = [
    { ...registry(), unknown: true },
    { version: 1, projects: [registry().projects[0], registry().projects[0]] },
    { version: 1, projects: [{ ...registry().projects[0], repoRoot: "relative/repo" }] },
    { version: 1, projects: [{ ...registry().projects[0], profiles: ["default", "default"] }] },
    { version: 1, projects: [{ ...registry().projects[0], expectedRemoteUrl: "git@github.com:attacker/repo.git" }] },
    { version: 1, projects: [{ ...registry().projects[0], worktreeRoot: "/protected/lmns/jobs" }] },
    { version: 1, projects: [registry().projects[0], { ...registry().projects[1], repoRoot: "/protected/worktrees/lmns/reghub" }] },
    { version: 1, projects: [registry().projects[0], { ...registry().projects[1], repoRoot: "/protected" }] },
    { version: 1, projects: [{ ...registry().projects[0], unexpected: "value" }] },
  ];
  for (const value of cases) assert.throws(() => parseProjectPolicies(value));
});

test("loads only an absolute restrictive project registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "broker-projects-"));
  const file = path.join(root, "projects.json");
  await writeFile(file, JSON.stringify(registry()), { mode: 0o600 });
  assert.equal((await loadProtectedProjectPolicies(file)).size, 2);
  await assert.rejects(loadProtectedProjectPolicies("relative-projects.json"), /absolute/);
  if (process.platform !== "win32") {
    await chmod(file, 0o644);
    await assert.rejects(loadProtectedProjectPolicies(file), /group\/world/);
  }
});

test("selects either the protected registry or the legacy single-project mapping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "broker-project-env-"));
  const file = path.join(root, "projects.json");
  await writeFile(file, JSON.stringify(registry()), { mode: 0o600 });
  assert.equal((await loadProjectPoliciesFromEnvironment({ BROKER_PROJECTS_FILE: file })).size, 2);
  await assert.rejects(loadProjectPoliciesFromEnvironment({ BROKER_PROJECTS_FILE: file, BROKER_PROJECT_KEY: "lmns" }), /Ambiguous/);
  const legacy = await loadProjectPoliciesFromEnvironment({ BROKER_PROJECT_KEY: "lmns", BROKER_REPO_ROOT: "/repo", BROKER_WORKTREE_ROOT: "/jobs", BROKER_EXPECTED_REMOTE_URL: "git@github.com:djamestaft/lmns.git", BROKER_GITHUB_REPO: "djamestaft/lmns" });
  assert.equal(legacy.get("lmns")?.repoRoot, "/repo");
});
