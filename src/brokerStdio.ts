import { createInterface } from "node:readline"; import type { HostBroker } from "./broker.js";
export const serveOne = async (broker:HostBroker,input:string):Promise<string> => JSON.stringify(await broker.execute(JSON.parse(input)));
export const serveStdio = (broker:HostBroker):void => { const lines=createInterface({input:process.stdin,crlfDelay:Infinity}); lines.on("line",async(line)=>{try{process.stdout.write(`${await serveOne(broker,line)}\n`);}catch{process.stdout.write(`${JSON.stringify({error:"invalid_request"})}\n`);}}); };
