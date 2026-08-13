import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION } from "@djamestaft/hermes-herdr-contracts";
import { HostBroker, MemoryJobRegistry, type GitWorkspaceAdapter, type HerdrAdapter, type ProjectPolicy } from "./broker.js";

const policy: ProjectPolicy = { project: "lmns", repoRoot: "/protected/repo", worktreeRoot: "/protected/jobs", remote: "origin", expectedRemoteUrl: "git@github.com:org/lmns.git", baseRef: "origin/main", baseBranch: "main", githubRepo: "org/lmns", profiles: ["default"] };
const git: GitWorkspaceAdapter = { async create({ jobId }) { return { branch: `jobs/${jobId}`, cwd: `/protected/jobs/${jobId}` }; } };
const herdr: HerdrAdapter = { async create({ jobId }) { return { sessionId: `private-${jobId}` }; }, async prompt() { return "working"; }, async status() { return "ready"; }, async read(_id, lines) { return `bounded:${lines}`; } };
const create = () => new HostBroker(new Map([["lmns", policy]]), new MemoryJobRegistry(), git, herdr);

test("creates an isolated logical job idempotently", async () => {
  const broker = create(); const cmd = { contractVersion: CONTRACT_VERSION, verb: "create_job", jobId: "job_12345678", project: "lmns", profile: "default" };
  const first = await broker.execute(cmd); const second = await broker.execute(cmd);
  assert.equal(first.state, "ready"); assert.deepEqual(second, first); assert.equal("sessionId" in first, false);
});
test("refuses unknown project before adapters run", async () => {
  const result = await create().execute({ contractVersion: CONTRACT_VERSION, verb: "create_job", jobId: "job_87654321", project: "attacker", profile: "default" });
  assert.equal(result.category, "refused");
});
test("rejects pane injection at protocol boundary", async () => {
  await assert.rejects(() => create().execute({ contractVersion: CONTRACT_VERSION, verb: "job_status", jobId: "job_12345678", pane: "wJ:p8" }), /Unsupported field/);
});
test("persists an uncertain mutation as unknown and refuses a duplicate prompt", async () => {
  let prompts = 0;
  const uncertainHerdr: HerdrAdapter = { ...herdr, async prompt() { prompts++; throw new Error("timeout"); } };
  const broker = new HostBroker(new Map([["lmns", policy]]), new MemoryJobRegistry(), git, uncertainHerdr);
  await broker.execute({ contractVersion: CONTRACT_VERSION, verb: "create_job", jobId: "job_12345678", project: "lmns", profile: "default" });
  const first = await broker.execute({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs: 1000 });
  const second = await broker.execute({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs: 1000 });
  assert.equal(first.state, "unknown"); assert.equal(second.category, "refused"); assert.equal(prompts, 1);
});
