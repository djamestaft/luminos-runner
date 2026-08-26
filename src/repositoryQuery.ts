import { spawn } from "node:child_process";
import os from "node:os";
import { redactText } from "./redaction.js";
import type { QuerySource } from "./querySources.js";

const QUERY_ID = /^query_[a-f0-9]{32}$/;
const MAX_QUESTION = 6_000;
const MAX_ANSWER = 48_000;

export interface RepositoryQueryRequest { version:1; queryId:string; projects:string[]; question:string; }
export interface RepositoryEvidence { project:string; source:string; observedAt:string; }
export type RepositoryQueryResult =
  | { version:1; queryId:string; state:"completed"; answer:string; sources:RepositoryEvidence[] }
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

const promptFor = (request:RepositoryQueryRequest,evidence:RepositoryEvidence[],sources:QuerySource[]):string => {
  const listedSources=evidence.map((item,index)=>`${index+1}. ${item.project} (${item.source}), observed ${item.observedAt}; local root: ${sources[index].root}`).join("\n");
  return `You are a read-only source analyst. Answer the question using only the local source directories listed below. Do not modify files, run Git or network commands, use credentials, or inspect .git, environment files, credential files, the user profile, or paths outside the listed roots. You may run local read-only inspection commands within those roots. Keep every command targeted and bounded: never enumerate the whole repository, exclude generated/vendor/build directories, and limit displayed matches or lines to at most 200 per command. Distinguish source evidence from inference and recommendations. Cite supporting source-relative file paths and line numbers. Keep the final answer concise. If evidence is absent or ambiguous, say so.\n\nLocal sources:\n${listedSources}\n\nQuestion:\n${request.question}`;
};

const codexEnvironment = ():NodeJS.ProcessEnv => {
  const allowed=["PATH","Path","PATHEXT","SystemRoot","WINDIR","COMSPEC","TEMP","TMP","USERPROFILE","LOCALAPPDATA","APPDATA","HOME","CODEX_HOME","LANG"];
  return Object.fromEntries(allowed.flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]]])) as NodeJS.ProcessEnv;
};

const finalAgentMessage = (output:string):string => {
  const answer=output.trim();
  if(!answer||answer.length>MAX_ANSWER)throw new Error("query_protocol_failed");
  return answer;
};

export class SpawnQueryProcess implements QueryProcess {
  public constructor(private readonly maxAnswerBytes=65_536,private readonly maxProgressBytes=33_554_432){}
  public run(file:string,args:readonly string[],input:string|undefined,options:{cwd?:string;timeoutMs:number;environment?:NodeJS.ProcessEnv}):Promise<QueryProcessResult>{
    return new Promise((resolve,reject)=>{let answerSize=0,progressSize=0,settled=false,timedOut=false;const answers:Buffer[]=[];const child=spawn(file,[...args],{cwd:options.cwd,env:options.environment??process.env,shell:false,stdio:[input===undefined?"ignore":"pipe","pipe","pipe"]});
      const fail=(error:Error)=>{if(settled)return;settled=true;child.kill("SIGKILL");reject(error);};
      const appendAnswer=(chunk:Buffer)=>{answerSize+=chunk.length;if(answerSize>this.maxAnswerBytes)return fail(new Error("query_output_too_large"));answers.push(chunk);};
      const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},options.timeoutMs);
      child.stdout!.on("data",appendAnswer);child.stderr!.on("data",(chunk:Buffer)=>{progressSize+=chunk.length;if(progressSize>this.maxProgressBytes)fail(new Error("query_output_too_large"));});child.on("error",fail);child.on("exit",code=>{clearTimeout(timer);if(settled)return;settled=true;if(timedOut)return reject(new Error("query_timeout"));resolve({exitCode:code??1,stdout:Buffer.concat(answers).toString("utf8")});});if(input!==undefined)child.stdin!.end(input);
    });
  }
}

export class RepositoryQueryService {
  public constructor(private readonly sources:ReadonlyMap<string,QuerySource>,private readonly process:QueryProcess,private readonly config:{expectedUsername:string;codexJs:string;timeoutMs:number;nodeExecutable?:string}){}
  public async execute(raw:unknown):Promise<RepositoryQueryResult>{
    let request:RepositoryQueryRequest;try{request=parseRepositoryQuery(raw);}catch{return{version:1,queryId:"query_invalid",state:"refused",category:"invalid_query"};}
    try{
      if(os.userInfo().username.toLowerCase()!==this.config.expectedUsername.toLowerCase())return{version:1,queryId:request.queryId,state:"refused",category:"reader_identity_mismatch"};
      const selected=request.projects.map(project=>this.sources.get(project));if(selected.some(source=>!source))return{version:1,queryId:request.queryId,state:"refused",category:"project_not_readable"};const resolved=selected as QuerySource[];const observedAt=new Date().toISOString();const sources=resolved.map(source=>({project:source.project,source:source.label,observedAt}));
      const result=await this.process.run(this.config.nodeExecutable??process.execPath,[this.config.codexJs,"exec","--sandbox","read-only","--ephemeral","--dangerously-bypass-hook-trust","-C",resolved[0].root,"-"],promptFor(request,sources,resolved),{cwd:resolved[0].root,timeoutMs:this.config.timeoutMs,environment:codexEnvironment()});
      if(result.exitCode!==0)throw new Error("query_process_failed");return{version:1,queryId:request.queryId,state:"completed",answer:redactText(finalAgentMessage(result.stdout),MAX_ANSWER),sources};
    }catch(error){const category=error instanceof Error&&/^(?:query_(?:process_failed|protocol_failed|timeout|output_too_large))$/.test(error.message)?error.message:"query_failed";return{version:1,queryId:request.queryId,state:"failed",category};}
  }
}
