import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import type { QuerySource } from "./querySources.js";
import { parseRepositoryQuery,RepositoryQueryService,type QueryProcess,type QueryProcessResult } from "./repositoryQuery.js";

const source=(project:string,root:string):QuerySource=>({project,root,label:`Greg local ${project} working copy`});
class FakeProcess implements QueryProcess {
  public calls:{file:string;args:readonly string[];input:string|undefined;cwd?:string;environment?:NodeJS.ProcessEnv}[]=[];
  public async run(file:string,args:readonly string[],input:string|undefined,options:{cwd?:string;environment?:NodeJS.ProcessEnv}):Promise<QueryProcessResult>{
    this.calls.push({file,args,input,cwd:options.cwd,environment:options.environment});
    return{exitCode:0,stdout:JSON.stringify({type:"item.completed",item:{id:"1",type:"agent_message",text:"Evidence from `src/example.ts:12`."}})+"\n"};
  }
}

test("query parser accepts only bounded exact project requests",()=>{
  assert.deepEqual(parseRepositoryQuery({version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns","reghub"],question:"How do approvals differ?"}),{version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns","reghub"],question:"How do approvals differ?"});
  assert.throws(()=>parseRepositoryQuery({version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns"],question:"x",path:"C:\\secret"}));
  assert.throws(()=>parseRepositoryQuery({version:1,queryId:`query_${"a".repeat(32)}`,projects:["lmns","lmns"],question:"x"}));
});

test("query invokes read-only Codex directly in fixed local sources without Git",async()=>{
  const process=new FakeProcess();const sources=new Map([["lmns",source("lmns","C:\\reader\\lmns")],["reghub",source("reghub","C:\\reader\\reghub")]]);
  const service=new RepositoryQueryService(sources,process,{expectedUsername:os.userInfo().username,codexJs:"C:\\tools\\codex.js",timeoutMs:60_000,nodeExecutable:"node"});
  const result=await service.execute({version:1,queryId:`query_${"b".repeat(32)}`,projects:["lmns","reghub"],question:"Compare the workflow."});
  assert.equal(result.state,"completed");if(result.state!=="completed")return;assert.equal(result.sources.length,2);assert.equal(result.sources[0].source,"Greg local lmns working copy");assert.ok(Number.isFinite(Date.parse(result.sources[0].observedAt)));assert.match(result.answer,/src\/example\.ts:12/);
  assert.equal(process.calls.length,1);const codex=process.calls[0];assert.equal(codex.file,"node");assert.deepEqual(codex.args.slice(1),["exec","--sandbox","read-only","--ephemeral","--dangerously-bypass-hook-trust","--json","-C","C:\\reader\\lmns","-"]);assert.equal(codex.cwd,"C:\\reader\\lmns");assert.ok(codex.input!.includes("C:\\reader\\reghub"));assert.match(codex.input!,/Do not modify files, run Git or network commands/);assert.equal(codex.environment?.GITHUB_TOKEN,undefined);assert.equal(codex.environment?.AZURE_CLIENT_SECRET,undefined);assert.notEqual(codex.file.toLowerCase(),"git");
});

test("query refuses an unknown source before process execution",async()=>{
  const process=new FakeProcess();const service=new RepositoryQueryService(new Map([["lmns",source("lmns","C:\\reader\\lmns")]]),process,{expectedUsername:os.userInfo().username,codexJs:"C:\\tools\\codex.js",timeoutMs:60_000});
  const result=await service.execute({version:1,queryId:`query_${"c".repeat(32)}`,projects:["reghub"],question:"Question"});assert.deepEqual(result,{version:1,queryId:`query_${"c".repeat(32)}`,state:"refused",category:"project_not_readable"});assert.equal(process.calls.length,0);
});

test("query reports a bounded failure when Codex exits unsuccessfully",async()=>{
  class FailedCodex extends FakeProcess{public override async run(file:string,args:readonly string[],input:string|undefined,options:{cwd?:string;environment?:NodeJS.ProcessEnv}){this.calls.push({file,args,input,cwd:options.cwd,environment:options.environment});return{exitCode:1,stdout:""};}}
  const process=new FailedCodex();const service=new RepositoryQueryService(new Map([["lmns",source("lmns","C:\\reader\\lmns")]]),process,{expectedUsername:os.userInfo().username,codexJs:"C:\\tools\\codex.js",timeoutMs:60_000,nodeExecutable:"node"});const result=await service.execute({version:1,queryId:`query_${"d".repeat(32)}`,projects:["lmns"],question:"Question"});assert.equal(result.state,"failed");assert.equal(result.category,"query_process_failed");assert.equal(process.calls.length,1);
});
