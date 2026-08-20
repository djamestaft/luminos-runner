import path from "node:path";import type{GitWorkspaceAdapter,LocalJob,ProjectPolicy}from"./broker.js";import type{ProcessExecutor}from"./processExecutor.js";
const safeJob=(id:string)=>{if(!/^[A-Za-z0-9_-]{8,80}$/.test(id))throw new Error("invalid_job_id");return id.toLowerCase();};
export class GitCliWorkspaceAdapter implements GitWorkspaceAdapter{
  public constructor(private executor:ProcessExecutor,private git="git",private gh="gh"){}
  public async create({jobId,policy}:{jobId:string;policy:ProjectPolicy}){const remote=(await this.phase("git_remote_failed",()=>this.runGit(policy,["remote","get-url",policy.remote]))).trim();if(remote!==policy.expectedRemoteUrl)throw new Error("remote_mismatch");await this.phase("git_fetch_failed",()=>this.runGit(policy,["fetch","--prune",policy.remote]));await this.phase("git_base_failed",()=>this.runGit(policy,["rev-parse","--verify",`${policy.baseRef}^{commit}`]));const id=safeJob(jobId),branch=`jobs/${id}`,cwd=path.join(policy.worktreeRoot,id);await this.phase("git_worktree_failed",()=>this.runGit(policy,["worktree","add","-b",branch,cwd,policy.baseRef]));return{branch,cwd};}
  public async handoff({job,policy,checkpoint=async()=>{}}:Parameters<NonNullable<GitWorkspaceAdapter["handoff"]>>[0]){
    const cwd=path.join(policy.worktreeRoot,safeJob(job.jobId));
    await checkpoint({handoffPhase:"validate"});
    const branch=(await this.command(this.git,["-C",cwd,"branch","--show-current"],"git_process_start_failed")).trim();
    if(branch!==job.branch||job.branch!==`jobs/${safeJob(job.jobId)}`)throw new Error("branch_mismatch");
    if((await this.command(this.git,["-C",cwd,"status","--porcelain"],"git_process_start_failed")).trim())throw new Error("uncommitted_changes");
    const count=Number((await this.command(this.git,["-C",cwd,"rev-list","--count",`${policy.baseRef}..HEAD`],"git_process_start_failed")).trim());
    if(!Number.isInteger(count)||count<1)throw new Error("missing_job_commit");
    const commitSha=(await this.command(this.git,["-C",cwd,"rev-parse","HEAD"],"git_process_start_failed")).trim();
    if(!/^[a-f0-9]{40}$/.test(commitSha))throw new Error("invalid_commit");
    if(job.commitSha&&job.commitSha!==commitSha)throw new Error("remote_conflict");
    await checkpoint({handoffPhase:"local_sha",commitSha});

    let remoteSha=await this.remoteSha(policy,job.branch);
    await checkpoint({handoffPhase:"remote_branch",commitSha,...(remoteSha?{remoteSha}:{})});
    if(remoteSha&&remoteSha!==commitSha)throw new Error("remote_conflict");
    if(!remoteSha){
      await checkpoint({handoffPhase:"push",commitSha});
      await this.command(this.git,["-C",cwd,"push","-u",policy.remote,`${job.branch}:refs/heads/${job.branch}`],"git_process_start_failed","git_operation_failed");
      remoteSha=await this.remoteSha(policy,job.branch);
      if(remoteSha!==commitSha)throw new Error("remote_conflict");
      await checkpoint({handoffPhase:"remote_branch",commitSha,remoteSha});
    }

    await checkpoint({handoffPhase:"pr_lookup",commitSha,remoteSha});
    let prUrl=await this.existingPr(policy,job.branch,commitSha);
    if(!prUrl){
      await checkpoint({handoffPhase:"pr_create",commitSha,remoteSha});
      prUrl=(await this.command(this.gh,["pr","create","--repo",policy.githubRepo,"--head",job.branch,"--base",policy.baseBranch,"--title",`Job ${job.jobId}`,"--body",`Automated handoff for ${job.jobId}. Human review and merge required.`],"git_process_start_failed","pr_create_failed")).trim();
    }
    await checkpoint({handoffPhase:"pr_validate",commitSha,remoteSha,prUrl});
    await this.validatePr(policy,prUrl,job.branch,commitSha);
    return{commitSha,prUrl};
  }
  public async cleanup({job,policy}:{job:LocalJob;policy:ProjectPolicy}){const cwd=path.join(policy.worktreeRoot,safeJob(job.jobId));if(!job.commitSha||!job.prUrl)throw new Error("handoff_evidence_missing");const branch=(await this.command(this.git,["-C",cwd,"branch","--show-current"])).trim();if(branch!==job.branch)throw new Error("branch_mismatch");if((await this.command(this.git,["-C",cwd,"status","--porcelain"])).trim())throw new Error("uncommitted_changes");const head=(await this.command(this.git,["-C",cwd,"rev-parse","HEAD"])).trim();if(head!==job.commitSha)throw new Error("commit_mismatch");const remote=(await this.command(this.git,["-C",cwd,"ls-remote",policy.remote,`refs/heads/${job.branch}`])).trim();if(!remote.startsWith(`${job.commitSha}\t`))throw new Error("remote_evidence_missing");await this.runGit(policy,["worktree","remove",cwd]);await this.runGit(policy,["worktree","prune"]);}
  private runGit(policy:ProjectPolicy,args:string[]){return this.command(this.git,["-C",policy.repoRoot,...args]);}
  private async remoteSha(policy:ProjectPolicy,branch:string):Promise<string|undefined>{const raw=(await this.command(this.git,["-C",policy.repoRoot,"ls-remote","--heads",policy.remote,`refs/heads/${branch}`],"git_process_start_failed","remote_lookup_failed")).trim();if(!raw)return undefined;const rows=raw.split(/\r?\n/);if(rows.length!==1)throw new Error("remote_conflict");const match=/^([a-f0-9]{40})\s+refs\/heads\/(.+)$/.exec(rows[0]);if(!match||match[2]!==branch)throw new Error("remote_lookup_failed");return match[1];}
  private async existingPr(policy:ProjectPolicy,branch:string,sha:string):Promise<string|undefined>{const raw=await this.command(this.gh,["pr","list","--repo",policy.githubRepo,"--head",branch,"--state","all","--json","url,headRefName,headRefOid,baseRefName,state","--limit","100"],"git_process_start_failed","pr_lookup_failed");let rows:unknown;try{rows=JSON.parse(raw);}catch{throw new Error("pr_invalid_response");}if(!Array.isArray(rows))throw new Error("pr_invalid_response");const exact=rows.filter((row):row is {url:string;headRefName:string;headRefOid:string;baseRefName:string}=>typeof row==="object"&&row!==null&&typeof (row as Record<string,unknown>).url==="string"&&(row as Record<string,unknown>).headRefName===branch);const compatible=exact.filter(row=>row.headRefOid===sha&&row.baseRefName===policy.baseBranch);if(exact.length!==compatible.length)throw new Error("pr_mismatch");if(compatible.length>1)throw new Error("pr_ambiguous");return compatible[0]?.url;}
  private async validatePr(policy:ProjectPolicy,url:string,branch:string,sha:string):Promise<void>{if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}$/.test(url))throw new Error("pr_validate_failed");const raw=await this.command(this.gh,["pr","view",url,"--repo",policy.githubRepo,"--json","url,headRefName,headRefOid,baseRefName,state"],"git_process_start_failed","pr_validate_failed");let row:unknown;try{row=JSON.parse(raw);}catch{throw new Error("pr_invalid_response");}if(typeof row!=="object"||row===null)throw new Error("pr_invalid_response");const value=row as Record<string,unknown>;if(value.url!==url||value.headRefName!==branch||value.headRefOid!==sha||value.baseRefName!==policy.baseBranch)throw new Error("pr_mismatch");}
  private async phase<T>(code:string,action:()=>Promise<T>):Promise<T>{try{return await action();}catch{throw new Error(code);}}
  private async command(file:string,args:string[],startCode="git_process_start_failed",exitCode="git_operation_failed"){let out;try{out=await this.executor.run(file,args,300_000);}catch{throw new Error(startCode);}if(out.exitCode!==0)throw new Error(exitCode);return out.stdout;}
}
