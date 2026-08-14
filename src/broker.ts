import type { BrokerCommand, BrokerResult, JobState } from "@djamestaft/hermes-herdr-contracts";
import { CONTRACT_VERSION, parseBrokerCommand } from "@djamestaft/hermes-herdr-contracts";
import { redactText } from "./redaction.js";

export interface ProjectPolicy { project: string; repoRoot: string; worktreeRoot: string; remote: string; expectedRemoteUrl: string; baseRef: string; baseBranch: string; githubRepo: string; profiles: readonly string[]; }
export interface LocalJob { jobId: string; project: string; profile: string; state: JobState; sessionId: string; workspaceId?: string; branch: string; commitSha?: string; prUrl?: string; }
export interface JobRegistry { get(jobId: string): Promise<LocalJob | undefined>; put(job: LocalJob): Promise<void>; withLock?<T>(key:string,action:()=>Promise<T>):Promise<T>; }
export interface HerdrAdapter { create(input:{jobId:string;cwd:string;profile:string;label:string}):Promise<{sessionId:string;workspaceId?:string}>; prompt(sessionId:string,text:string,timeoutMs:number):Promise<"working"|"ready"|"unknown">; status(sessionId:string):Promise<"working"|"ready"|"unknown">; read(sessionId:string,maxLines:number):Promise<string>; close?(sessionId:string,workspaceId?:string):Promise<void>; }
export interface GitWorkspaceAdapter { create(input:{jobId:string;policy:ProjectPolicy}):Promise<{branch:string;cwd:string}>; handoff?(input:{job:LocalJob;policy:ProjectPolicy}):Promise<{commitSha:string;prUrl:string}>; cleanup?(input:{job:LocalJob;policy:ProjectPolicy}):Promise<void>; }
class KeyedLock { private held=new Set<string>(); async run<T>(key:string,action:()=>Promise<T>):Promise<T>{if(this.held.has(key))throw new Error("busy");this.held.add(key);try{return await action();}finally{this.held.delete(key);}} }
const mutating = new Set(["create_job","prompt_job","handoff_job","close_job"]);

export class HostBroker {
  private locks=new KeyedLock();
  public constructor(private policies:ReadonlyMap<string,ProjectPolicy>,private registry:JobRegistry,private git:GitWorkspaceAdapter,private herdr:HerdrAdapter){}
  public async execute(raw:unknown):Promise<BrokerResult>{
    const command=parseBrokerCommand(raw);
    try{return await this.lock(`job-${command.jobId}`,()=>this.dispatch(command));}
    catch(error){const message=error instanceof Error?error.message:"";const busy=message==="busy";const uncertain=!busy&&(mutating.has(command.verb)||message.includes("registry"));if(uncertain){try{const job=await this.registry.get(command.jobId);if(job){job.state="unknown";await this.registry.put(job);}}catch{/* The result remains unknown when even durable reconciliation state cannot be written. */}}const safe=/^(?:git_(?:remote|fetch|base|worktree)_failed|remote_mismatch|herdr_(?:protocol|command|create)_failed|process_(?:timeout|output_too_large)|invalid_registry)$/.test(message)?message:"operation_failed";return{contractVersion:CONTRACT_VERSION,jobId:command.jobId,state:busy?"refused":uncertain?"unknown":"failed",category:busy?"busy":uncertain?"unknown":"failed",summary:busy?"busy":safe};}
  }
  private lock<T>(key:string,action:()=>Promise<T>):Promise<T>{return this.registry.withLock?this.registry.withLock(key,action):this.locks.run(key,action);}
  private async dispatch(command:BrokerCommand):Promise<BrokerResult>{
    if(command.verb==="create_job"){
      const existing=await this.registry.get(command.jobId);if(existing)return this.result(existing,"ok");
      const policy=this.policies.get(command.project);if(!policy||!policy.profiles.includes(command.profile))return{contractVersion:CONTRACT_VERSION,jobId:command.jobId,state:"refused",category:"refused"};
      return this.lock(`project-${command.project}`,async()=>{const repeated=await this.registry.get(command.jobId);if(repeated)return this.result(repeated,"ok");const workspace=await this.git.create({jobId:command.jobId,policy});const session=await this.herdr.create({jobId:command.jobId,cwd:workspace.cwd,profile:command.profile,label:command.label});const job:LocalJob={jobId:command.jobId,project:command.project,profile:command.profile,state:"ready",sessionId:session.sessionId,workspaceId:session.workspaceId,branch:workspace.branch};await this.registry.put(job);return this.result(job,"ok");});
    }
    const job=await this.registry.get(command.jobId);
    // Recovery is the explicit coordinator proof step after an indeterminate
    // transport result. A missing durable job proves create did not commit, so
    // report ready and let the coordinator safely retry the idempotent create.
    if(!job&&command.verb==="recover_job")return{contractVersion:CONTRACT_VERSION,jobId:command.jobId,state:"ready",category:"ok",summary:"job absent; safe to recreate"};
    if(!job)return{contractVersion:CONTRACT_VERSION,jobId:command.jobId,state:"refused",category:"refused"};
    if(command.verb==="prompt_job"){if(job.state!=="ready")return this.result(job,"refused");const state=await this.herdr.prompt(job.sessionId,command.taskText,command.timeoutMs);job.state=state;await this.registry.put(job);return this.result(job,state==="unknown"?"unknown":"ok");}
    if(command.verb==="job_status"){if(!["ready","working","unknown"].includes(job.state))return this.result(job,"ok");job.state=await this.herdr.status(job.sessionId);await this.registry.put(job);return this.result(job,job.state==="unknown"?"unknown":"ok");}
    if(command.verb==="read_job"){if(!["ready","working","unknown"].includes(job.state))return this.result(job,"refused");const summary=redactText(await this.herdr.read(job.sessionId,command.maxLines));return{...this.result(job,"ok"),summary};}
    if(command.verb==="handoff_job"){if(job.state==="handoff_ready")return this.result(job,"ok");if(job.state!=="ready"||!this.git.handoff)return this.result(job,"refused");const policy=this.policies.get(job.project);if(!policy)return this.result(job,"refused");const handoff=await this.git.handoff({job,policy});job.commitSha=handoff.commitSha;job.prUrl=handoff.prUrl;job.state="handoff_ready";await this.registry.put(job);return this.result(job,"ok");}
    if(command.verb==="recover_job"){if(job.state==="handoff_ready")return this.result(job,"ok");if(job.state!=="unknown")return this.result(job,"refused");job.state=await this.herdr.status(job.sessionId);await this.registry.put(job);return this.result(job,job.state==="unknown"?"unknown":"ok");}
    if(command.verb==="close_job"){if(job.state!=="handoff_ready")return this.result(job,"refused");const policy=this.policies.get(job.project);if(!policy||!this.herdr.close||!this.git.cleanup)return this.result(job,"refused");await this.herdr.close(job.sessionId,job.workspaceId);await this.git.cleanup({job,policy});job.state="closed";await this.registry.put(job);return this.result(job,"ok");}
    return this.result(job,"refused");
  }
  private result(job:LocalJob,category:BrokerResult["category"]):BrokerResult{return{contractVersion:CONTRACT_VERSION,jobId:job.jobId,state:job.state,category,branch:job.branch,commitSha:job.commitSha,prUrl:job.prUrl};}
}
export class MemoryJobRegistry implements JobRegistry {private jobs=new Map<string,LocalJob>();async get(id:string){return this.jobs.get(id);}async put(job:LocalJob){this.jobs.set(job.jobId,{...job});}}
