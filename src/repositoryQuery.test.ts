import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectPolicy } from "./broker.js";
import { parseRepositoryQuery,RepositoryQueryService,type QueryProcess,type QueryProcessResult } from "./repositoryQuery.js";

const policy=(project:string,repoRoot:string):ProjectPolicy=>({project,repoRoot,worktreeRoot:`${repoRoot}-worktrees`,remote:"origin",expectedRemoteUrl:`https://github.com/example/${project}.git`,baseRef:"origin/main",baseBranch:"main",githubRepo:`example/${project}`,profiles:["read"]});
class FakeProcess implements QueryProcess {
  public calls:{file:string;args:readonly string[];input:string|undefined;environment?:NodeJS.ProcessEnv}[]=[];
  public async run(file:string,args:readonly string[],input:string|undefined,options:{environment?:NodeJS.ProcessEnv}):Promise<QueryProcessResult>{this.calls.push({file,args,input,environment:options.environment});const joined=args.join(" ");if(joined.includes("remote get-url")){const project=joined.includes("reghub")?"reghub":"lmns";return{exitCode:0,stdout:`https://github.com/example/${project}.git\n`};}if(joined.includes("rev-parse"))return{exitCode:0,stdout:"a".repeat(40)};if(file==="git")return{exitCode:0,stdout:""};return{exitCode:0,stdout:JSON.stringify({type:"item.completed",item:{id:"1",type:"agent_message",text:"Evidence from `src/example.ts:12`."}})+"\n"};}
}

test("query parser accepts only bounded exact project requests",()=>{
  assert.deepEqual(parseRepositoryQuery({version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns","reghub"],question:"How do approvals differ?"}),{version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns","reghub"],question:"How do approvals differ?"});
  assert.throws(()=>parseRepositoryQuery({version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns"],question:"x",path:"C:\\secret"}));
  assert.throws(()=>parseRepositoryQuery({version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns","lmns"],question:"x"}));
});

test("query creates detached protected-base worktrees, invokes read-only Codex, then removes them",async()=>{
  const process=new FakeProcess();const policies=new Map([["lmns",policy("lmns","C:\\reader\\lmns")],["reghub",policy("reghub","C:\\reader\\reghub")]]);
  const service=new RepositoryQueryService(policies,process,{expectedUsername:os.userInfo().username,codexJs:"C:\\tools\\codex.js",timeoutMs:60_000,nodeExecutable:"node"});
  const result=await service.execute({version:1,queryId:`query_${"b".repeat(32)}`,projects:["lmns","reghub"],question:"Compare the workflow."});
  assert.equal(result.state,"completed");if(result.state!=="completed")return;assert.equal(result.repositories.length,2);assert.match(result.answer,/src\/example\.ts:12/);
  const lmnsRoot=path.join("C:\\reader\\lmns-worktrees","queries",`query_${"b".repeat(32)}`,"lmns");const reghubRoot=path.join("C:\\reader\\reghub-worktrees","queries",`query_${"b".repeat(32)}`,"reghub");const codex=process.calls.find(call=>call.file==="node")!;assert.deepEqual(codex.args.slice(1),["exec","--sandbox","read-only","--ephemeral","--dangerously-bypass-hook-trust","--json","-C",lmnsRoot,"-"]);assert.ok(codex.input!.includes(reghubRoot));assert.equal(codex.environment?.GITHUB_TOKEN,undefined);assert.equal(codex.environment?.AZURE_CLIENT_SECRET,undefined);assert.equal(process.calls.filter(call=>call.args.includes("add")).length,2);assert.equal(process.calls.filter(call=>call.args.includes("remove")).length,2);
});

test("query refuses unknown or non-read projects before process execution",async()=>{
  const process=new FakeProcess();const denied={...policy("lmns","C:\\reader\\lmns"),profiles:["default"]};const service=new RepositoryQueryService(new Map([["lmns",denied]]),process,{expectedUsername:os.userInfo().username,codexJs:"C:\\tools\\codex.js",timeoutMs:60_000});
  const result=await service.execute({version:1,queryId:`query_${"c".repeat(32)}`,projects:["lmns"],question:"Question"});assert.deepEqual(result,{version:1,queryId:`query_${"c".repeat(32)}`,state:"refused",category:"project_not_readable"});assert.equal(process.calls.length,0);
});

test("query removes its detached worktree when Codex fails",async()=>{
  class FailedCodex extends FakeProcess{public override async run(file:string,args:readonly string[],input:string|undefined,options:{environment?:NodeJS.ProcessEnv}){if(file==="node"){this.calls.push({file,args,input,environment:options.environment});return{exitCode:1,stdout:""};}return super.run(file,args,input,options);}}
  const process=new FailedCodex();const service=new RepositoryQueryService(new Map([["lmns",policy("lmns","C:\\reader\\lmns")]]),process,{expectedUsername:os.userInfo().username,codexJs:"C:\\tools\\codex.js",timeoutMs:60_000,nodeExecutable:"node"});const result=await service.execute({version:1,queryId:`query_${"d".repeat(32)}`,projects:["lmns"],question:"Question"});assert.equal(result.state,"failed");assert.equal(result.category,"query_process_failed");assert.equal(process.calls.filter(call=>call.args.includes("remove")).length,1);
});
