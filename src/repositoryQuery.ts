import { spawn } from "node:child_process";
import os from "node:os";
import type { ProjectPolicy } from "./broker.js";
import { redactText } from "./redaction.js";

const QUERY_ID = /^query_[a-f0-9]{32}$/;
const MAX_QUESTION = 6_000;
const MAX_ANSWER = 48_000;

export interface RepositoryQueryRequest { version:1; queryId:string; projects:string[]; question:string; }
export interface RepositoryEvidence { project:string; repository:string; revision:string; }
export type RepositoryQueryResult =
  | { version:1; queryId:string; state:"completed"; answer:string; repositories:RepositoryEvidence[] }
  | { version:1; queryId:string; state:"refused"|"failed"; category:string };
export interface QueryProcessResult { exitCode:number; stdout:string; }
export interface QueryProcess {
  run(file:string,args:readonly string[],input:string|undefined,options:{cwd?:string;timeoutMs:number;environment?:NodeJS.ProcessEnv}):Promise<QueryProcessResult>;
}

const exactObject = (value:unknown, keys:readonly string[]):Record<string,unknown>|undefined => {
  if(typeof value!=="object"||value===null||Array.isArray(value))return undefined;
  const record=value as Record<string,unknown>;
  return Object.keys(record).every(key=>keys.includes(key))?record:undefined;
};

export const parseRepositoryQuery = (raw:unknown):RepositoryQueryRequest => {
  const value=exactObject(raw,["version","queryId","projects","question"]);
  if(!value||value.version!==1||typeof value.queryId!=="string"||!QUERY_ID.test(value.queryId))throw new Error("invalid_query");
  if(!Array.isArray(value.projects)||value.projects.length<1||value.projects.length>2||value.projects.some(project=>typeof project!=="string"||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project))||new Set(value.projects).size!==value.projects.length)throw new Error("invalid_query");
  if(typeof value.question!=="string"||value.question.trim().length<1||value.question.length>MAX_QUESTION||/[\0]/.test(value.question))throw new Error("invalid_query");
  return {version:1,queryId:value.queryId,projects:value.projects as string[],question:value.question.trim()};
};

const promptFor = (request:RepositoryQueryRequest,evidence:RepositoryEvidence[],policies:ProjectPolicy[]):string => {
  const repositories=evidence.map((item,index)=>`${index+1}. ${item.project} (${item.repository}) at revision ${item.revision}; local root: ${policies[index].repoRoot}`).join("\n");
  return `You are a read-only repository analyst. Answer the question using only the repositories listed below. Do not modify files, run network commands, use credentials, create branches, commit, push, or open pull requests. You may run local read-only inspection commands. Distinguish repository evidence from inference and recommendations. Cite supporting repository-relative file paths and line numbers. If evidence is absent or ambiguous, say so.\n\nRepositories:\n${repositories}\n\nQuestion:\n${request.question}`;
};

const codexEnvironment = ():NodeJS.ProcessEnv => {
  const allowed=["PATH","Path","PATHEXT","SystemRoot","WINDIR","COMSPEC","TEMP","TMP","USERPROFILE","LOCALAPPDATA","APPDATA","HOME","CODEX_HOME","LANG"];
  return Object.fromEntries(allowed.flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]]])) as NodeJS.ProcessEnv;
};

const finalAgentMessage = (output:string):string => {
  let answer="";
  for(const line of output.split(/\r?\n/)){
    if(!line.trim())continue;
    let event:unknown;try{event=JSON.parse(line);}catch{throw new Error("query_protocol_failed");}
    const root=exactObject(event,["type","thread_id","turn","item","usage","error"]);
    const item=root&&exactObject(root.item,["id","type","text","command","aggregated_output","exit_code","status","changes"]);
    if(root?.type==="item.completed"&&item?.type==="agent_message"&&typeof item.text==="string")answer=item.text;
  }
  if(!answer||answer.length>MAX_ANSWER)throw new Error("query_protocol_failed");
  return answer;
};

export class SpawnQueryProcess implements QueryProcess {
  public constructor(private readonly maxOutputBytes=262_144){}
  public run(file:string,args:readonly string[],input:string|undefined,options:{cwd?:string;timeoutMs:number;environment?:NodeJS.ProcessEnv}):Promise<QueryProcessResult>{
    return new Promise((resolve,reject)=>{let size=0,settled=false,timedOut=false;const out:Buffer[]=[];const child=spawn(file,[...args],{cwd:options.cwd,env:options.environment??process.env,shell:false,stdio:[input===undefined?"ignore":"pipe","pipe","pipe"]});
      const fail=(error:Error)=>{if(settled)return;settled=true;child.kill("SIGKILL");reject(error);};
      const append=(chunk:Buffer)=>{size+=chunk.length;if(size>this.maxOutputBytes)fail(new Error("query_output_too_large"));else out.push(chunk);};
      const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},options.timeoutMs);
      child.stdout!.on("data",append);child.stderr!.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>this.maxOutputBytes)fail(new Error("query_output_too_large"));});child.on("error",fail);child.on("exit",code=>{clearTimeout(timer);if(settled)return;settled=true;if(timedOut)return reject(new Error("query_timeout"));resolve({exitCode:code??1,stdout:Buffer.concat(out).toString("utf8")});});if(input!==undefined)child.stdin!.end(input);
    });
  }
}

export class RepositoryQueryService {
  public constructor(private readonly policies:ReadonlyMap<string,ProjectPolicy>,private readonly process:QueryProcess,private readonly config:{expectedUsername:string;codexJs:string;timeoutMs:number;nodeExecutable?:string}){}
  public async execute(raw:unknown):Promise<RepositoryQueryResult>{
    let request:RepositoryQueryRequest;try{request=parseRepositoryQuery(raw);}catch{return{version:1,queryId:"query_invalid",state:"refused",category:"invalid_query"};}
    try{
      if(os.userInfo().username.toLowerCase()!==this.config.expectedUsername.toLowerCase())return{version:1,queryId:request.queryId,state:"refused",category:"reader_identity_mismatch"};
      const policies=request.projects.map(project=>this.policies.get(project));
      if(policies.some(policy=>!policy||!policy.profiles.includes("read")))return{version:1,queryId:request.queryId,state:"refused",category:"project_not_readable"};
      const selected=policies as ProjectPolicy[];const repositories:RepositoryEvidence[]=[];
      for(const policy of selected){
        const remote=await this.git(policy,["remote","get-url",policy.remote]);if(remote!==policy.expectedRemoteUrl)throw new Error("repository_mismatch");
        if(await this.git(policy,["status","--porcelain=v1","--untracked-files=all","--ignored=matching"]))throw new Error("repository_not_clean");
        const revision=await this.git(policy,["rev-parse","--verify","HEAD^{commit}"]);if(!/^[a-f0-9]{40}$/.test(revision))throw new Error("repository_invalid_revision");
        repositories.push({project:policy.project,repository:policy.githubRepo,revision});
      }
      const result=await this.process.run(this.config.nodeExecutable??process.execPath,[this.config.codexJs,"exec","--sandbox","read-only","--ephemeral","--dangerously-bypass-hook-trust","--json","-C",selected[0].repoRoot,"-"],promptFor(request,repositories,selected),{cwd:selected[0].repoRoot,timeoutMs:this.config.timeoutMs,environment:codexEnvironment()});
      if(result.exitCode!==0)throw new Error("query_process_failed");
      return{version:1,queryId:request.queryId,state:"completed",answer:redactText(finalAgentMessage(result.stdout),MAX_ANSWER),repositories};
    }catch(error){const category=error instanceof Error&&/^(?:repository_(?:mismatch|not_clean|invalid_revision)|query_(?:process_failed|protocol_failed|timeout|output_too_large))$/.test(error.message)?error.message:"query_failed";return{version:1,queryId:request.queryId,state:"failed",category};}
  }
  private async git(policy:ProjectPolicy,args:string[]):Promise<string>{const result=await this.process.run("git",["-C",policy.repoRoot,...args],undefined,{timeoutMs:30_000});if(result.exitCode!==0)throw new Error("repository_invalid_revision");return result.stdout.trim();}
}
