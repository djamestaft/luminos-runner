import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION } from "@djamestaft/hermes-herdr-contracts";
import { HostBroker, MemoryJobRegistry, type GitWorkspaceAdapter, type HerdrAdapter, type ProjectPolicy } from "./broker.js";

const policy: ProjectPolicy = { project: "lmns", repoRoot: "/protected/repo", worktreeRoot: "/protected/jobs", remote: "origin", expectedRemoteUrl: "git@github.com:org/lmns.git", baseRef: "origin/main", baseBranch: "main", githubRepo: "org/lmns", profiles: ["default"] };
const git: GitWorkspaceAdapter = { async create({ jobId }) { return { branch: `jobs/${jobId}`, cwd: `/protected/jobs/${jobId}` }; } };
const herdr: HerdrAdapter = { async create({ jobId }) { return { sessionId: `private-${jobId}` }; }, async prompt() { return "working"; }, async status() { return "ready"; }, async read(_id, lines) { return `bounded:${lines}`; } };
const create = () => new HostBroker(new Map([["lmns", policy]]), new MemoryJobRegistry(), git, herdr);

test("creates an isolated logical job idempotently", async () => {
  const broker = create(); const cmd = { contractVersion: CONTRACT_VERSION, verb: "create_job", jobId: "job_12345678", project: "lmns", profile: "default", label:"bounded-task" };
  const first = await broker.execute(cmd); const second = await broker.execute(cmd);
  assert.equal(first.state, "ready"); assert.deepEqual(second, first); assert.equal("sessionId" in first, false);
});
test("refuses unknown project before adapters run", async () => {
  const result = await create().execute({ contractVersion: CONTRACT_VERSION, verb: "create_job", jobId: "job_87654321", project: "attacker", profile: "default", label:"bounded-task" });
  assert.equal(result.category, "refused");
});
test("selects only the protected policy matching the requested project",async()=>{const reghub:ProjectPolicy={...policy,project:"reghub",repoRoot:"/protected/reghub",worktreeRoot:"/protected/reghub-jobs",expectedRemoteUrl:"git@github.com:org/reghub.git",githubRepo:"org/reghub",profiles:["read"]};let selected:ProjectPolicy|undefined;const routedGit:GitWorkspaceAdapter={...git,async create({policy:selectedPolicy}){selected=selectedPolicy;return{branch:"jobs/job_87654321",cwd:"/protected/reghub-jobs/job_87654321"};}};const broker=new HostBroker(new Map([["lmns",policy],["reghub",reghub]]),new MemoryJobRegistry(),routedGit,herdr);const result=await broker.execute({contractVersion:CONTRACT_VERSION,verb:"create_job",jobId:"job_87654321",project:"reghub",profile:"read",label:"bounded-task"});assert.equal(result.state,"ready");assert.equal(selected,reghub);const refused=await broker.execute({contractVersion:CONTRACT_VERSION,verb:"create_job",jobId:"job_abcdefgh",project:"reghub",profile:"default",label:"bounded-task"});assert.equal(refused.state,"refused");});
const phases=["herdr_workspace_create_failed","herdr_snapshot_lookup_failed","herdr_agent_start_failed"];
const categories=["exit_1_unstructured","exit_2_syntax","exit_other","success_invalid_json","success_missing_workspace","future_safe_code"];
const createDiagnostics=phases.flatMap(phase=>categories.map(category=>`${phase}:${category}`));
for(const diagnostic of createDiagnostics){
  test(`returns the bounded ${diagnostic} diagnostic without leaking process details`,async()=>{
    const failedHerdr:HerdrAdapter={...herdr,async create(){throw Object.assign(new Error(diagnostic),{detail:"SECRET_DETAIL C:\\protected\\herdr --arguments environment credentials",stdout:"SECRET_STDOUT",stderr:"SECRET_STDERR"});}};
    const result=await new HostBroker(new Map([["lmns",policy]]),new MemoryJobRegistry(),git,failedHerdr).execute({contractVersion:CONTRACT_VERSION,verb:"create_job",jobId:"job_12345678",project:"lmns",profile:"default",label:"secretinputsentinel"});
    assert.equal(result.state,"unknown");assert.equal(result.category,"unknown");assert.equal(result.summary,diagnostic);assert.notEqual(result.summary,"operation_failed");assert.doesNotMatch(JSON.stringify(result),/SECRET_|secretinputsentinel|protected|arguments?|environment|credentials?|stdout|stderr/i);
  });
}
for(const unsafe of [
  ...phases,
  "herdr_agent_start_failed:future_safe_code:extra",
  "herdr_agent_start_failed:UPPER_CODE",
  "herdr_agent_start_failed:code/path",
  `herdr_agent_start_failed:a${"7".repeat(32)}`,
  "herdr_unknown_phase:future_safe_code",
  "SECRET_RAW_MESSAGE C:\\protected\\herdr --arguments environment credentials",
]){
  test("reduces an unsafe create exception to operation_failed",async()=>{
    const failedHerdr:HerdrAdapter={...herdr,async create(){throw new Error(unsafe);}};
    const result=await new HostBroker(new Map([["lmns",policy]]),new MemoryJobRegistry(),git,failedHerdr).execute({contractVersion:CONTRACT_VERSION,verb:"create_job",jobId:"job_12345678",project:"lmns",profile:"default",label:"secretinputsentinel"});
    assert.equal(result.state,"unknown");assert.equal(result.category,"unknown");assert.equal(result.summary,"operation_failed");assert.doesNotMatch(JSON.stringify(result),/SECRET_|secretinputsentinel|protected|arguments?|environment|credentials?/i);
  });
}
test("rejects pane injection at protocol boundary", async () => {
  await assert.rejects(() => create().execute({ contractVersion: CONTRACT_VERSION, verb: "job_status", jobId: "job_12345678", pane: "wJ:p8" }), /Unsupported field/);
});
test("persists an uncertain mutation as unknown and refuses a duplicate prompt", async () => {
  let prompts = 0;
  const uncertainHerdr: HerdrAdapter = { ...herdr, async prompt() { prompts++; throw new Error("timeout"); } };
  const broker = new HostBroker(new Map([["lmns", policy]]), new MemoryJobRegistry(), git, uncertainHerdr);
  await broker.execute({ contractVersion: CONTRACT_VERSION, verb: "create_job", jobId: "job_12345678", project: "lmns", profile: "default", label:"bounded-task" });
  const first = await broker.execute({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs: 1000 });
  const second = await broker.execute({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs: 1000 });
  assert.equal(first.state, "unknown"); assert.equal(second.category, "refused"); assert.equal(prompts, 1);
});
test("recovery proves an absent job is safe to recreate",async()=>{
  const recovered=await create().execute({contractVersion:CONTRACT_VERSION,verb:"recover_job",jobId:"job_12345678"});
  assert.deepEqual(recovered,{contractVersion:CONTRACT_VERSION,jobId:"job_12345678",state:"ready",category:"ok",summary:"job absent; safe to recreate"});
});
test("recovery returns durable handoff evidence without rerunning work",async()=>{
  const handoffGit:GitWorkspaceAdapter={...git,async handoff(){return{commitSha:"a".repeat(40),prUrl:"https://github.com/org/repo/pull/1"};}};
  const broker=new HostBroker(new Map([["lmns",policy]]),new MemoryJobRegistry(),handoffGit,herdr);
  await broker.execute({contractVersion:CONTRACT_VERSION,verb:"create_job",jobId:"job_12345678",project:"lmns",profile:"default",label:"bounded-task"});
  await broker.execute({contractVersion:CONTRACT_VERSION,verb:"handoff_job",jobId:"job_12345678"});
  const recovered=await broker.execute({contractVersion:CONTRACT_VERSION,verb:"recover_job",jobId:"job_12345678"});
  assert.deepEqual(recovered,{contractVersion:CONTRACT_VERSION,jobId:"job_12345678",state:"handoff_ready",category:"ok",branch:"jobs/job_12345678",commitSha:"a".repeat(40),prUrl:"https://github.com/org/repo/pull/1"});
});
test("repeated handoff resumes from durable subphase evidence without another prompt",async()=>{let handoffs=0;let prompts=0;const sha="a".repeat(40);const durableGit:GitWorkspaceAdapter={...git,async handoff({checkpoint}){handoffs++;await checkpoint?.({handoffPhase:"remote_branch",commitSha:sha,remoteSha:sha});if(handoffs===1)throw new Error("pr_lookup_failed");await checkpoint?.({handoffPhase:"pr_validate",commitSha:sha,remoteSha:sha,prUrl:"https://github.com/org/repo/pull/1"});return{commitSha:sha,prUrl:"https://github.com/org/repo/pull/1"};}};const broker=new HostBroker(new Map([["lmns",policy]]),new MemoryJobRegistry(),durableGit,{...herdr,async prompt(){prompts++;return"ready";}});await broker.execute({contractVersion:CONTRACT_VERSION,verb:"create_job",jobId:"job_12345678",project:"lmns",profile:"default",label:"bounded-task"});await broker.execute({contractVersion:CONTRACT_VERSION,verb:"prompt_job",jobId:"job_12345678",taskText:"bounded",timeoutMs:1000});const first=await broker.execute({contractVersion:CONTRACT_VERSION,verb:"handoff_job",jobId:"job_12345678"});assert.equal(first.state,"unknown");assert.equal(first.summary,"pr_lookup_failed");const repeated=await broker.execute({contractVersion:CONTRACT_VERSION,verb:"handoff_job",jobId:"job_12345678"});assert.equal(repeated.state,"handoff_ready");assert.equal(handoffs,2);assert.equal(prompts,1);});
