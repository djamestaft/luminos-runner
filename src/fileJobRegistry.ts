import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRegistry, LocalJob } from "./broker.js";

export class FileJobRegistry implements JobRegistry {
  public constructor(private readonly filePath:string){}
  public async get(jobId:string):Promise<LocalJob|undefined>{return(await this.load())[jobId];}
  public async put(job:LocalJob):Promise<void>{const jobs=await this.load();jobs[job.jobId]={...job};await mkdir(path.dirname(this.filePath),{recursive:true,mode:0o700});const temporary=`${this.filePath}.${process.pid}.${Date.now()}.tmp`;await writeFile(temporary,JSON.stringify({version:1,jobs},null,2),{mode:0o600});await rename(temporary,this.filePath);}
  public async withLock<T>(key:string,action:()=>Promise<T>):Promise<T>{
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(key))throw new Error("invalid_lock_key");
    const lockRoot=`${this.filePath}.locks`;const lockPath=path.join(lockRoot,`${key}.lock`);await mkdir(lockRoot,{recursive:true,mode:0o700});
    try{await mkdir(lockPath,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("busy");throw error;}
    try{await writeFile(path.join(lockPath,"owner"),`${process.pid}\n`,{mode:0o600});return await action();}finally{await rm(lockPath,{recursive:true,force:true});}
  }
  private async load():Promise<Record<string,LocalJob>>{const contents=await readFile(this.filePath,"utf8").catch((error:NodeJS.ErrnoException)=>error.code==="ENOENT"?undefined:Promise.reject(error));if(!contents)return{};const parsed=JSON.parse(contents)as{version?:number;jobs?:Record<string,LocalJob>};if(parsed.version!==1||!parsed.jobs||typeof parsed.jobs!=="object"||Array.isArray(parsed.jobs))throw new Error("invalid_registry");return parsed.jobs;}
}
