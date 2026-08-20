import { chmod, chown, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRegistry, LocalJob } from "./broker.js";

export class FileJobRegistry implements JobRegistry {
  public constructor(private readonly filePath:string){}
  public async get(jobId:string):Promise<LocalJob|undefined>{return(await this.load())[jobId];}
  public async put(job:LocalJob):Promise<void>{this.validate(job);const jobs=await this.load();jobs[job.jobId]={...job};await mkdir(path.dirname(this.filePath),{recursive:true,mode:0o700});const previous=await stat(this.filePath).catch((error:NodeJS.ErrnoException)=>error.code==="ENOENT"?undefined:Promise.reject(error));const temporary=`${this.filePath}.${process.pid}.${Date.now()}.tmp`;try{const handle=await open(temporary,"wx",previous?.mode??0o600);try{await handle.writeFile(JSON.stringify({version:1,jobs},null,2));await handle.sync();}finally{await handle.close();}if(previous){await chmod(temporary,previous.mode);if(process.platform!=="win32")await chown(temporary,previous.uid,previous.gid);}await rename(temporary,this.filePath);const directory=await open(path.dirname(this.filePath),"r").catch(()=>undefined);try{await directory?.sync();}finally{await directory?.close();}}catch(error){await rm(temporary,{force:true});throw error;}}
  public async withLock<T>(key:string,action:()=>Promise<T>):Promise<T>{
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(key))throw new Error("invalid_lock_key");
    const lockRoot=`${this.filePath}.locks`;const lockPath=path.join(lockRoot,`${key}.lock`);await mkdir(lockRoot,{recursive:true,mode:0o700});
    try{await mkdir(lockPath,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("busy");throw error;}
    try{await writeFile(path.join(lockPath,"owner"),`${process.pid}\n`,{mode:0o600});return await action();}finally{await rm(lockPath,{recursive:true,force:true});}
  }
  private async load():Promise<Record<string,LocalJob>>{const contents=await readFile(this.filePath,"utf8").catch((error:NodeJS.ErrnoException)=>error.code==="ENOENT"?undefined:Promise.reject(error));if(!contents)return{};const parsed=JSON.parse(contents)as{version?:number;jobs?:Record<string,LocalJob>};if(parsed.version!==1||!parsed.jobs||typeof parsed.jobs!=="object"||Array.isArray(parsed.jobs))throw new Error("invalid_registry");for(const job of Object.values(parsed.jobs))this.validate(job);return parsed.jobs;}
  private validate(job:LocalJob):void{if(job.state==="handoff_ready"&&(!job.commitSha||!job.prUrl))throw new Error("invalid_registry");if((job.commitSha&&!/^[a-f0-9]{40}$/.test(job.commitSha))||(job.remoteSha&&!/^[a-f0-9]{40}$/.test(job.remoteSha)))throw new Error("invalid_registry");}
}
