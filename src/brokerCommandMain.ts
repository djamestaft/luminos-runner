import { once } from "node:events";
import { stdin, stdout } from "node:process";
import { loadProtectedBrokerConfig } from "./protectedConfig.js";

const configIndex=process.argv.indexOf("--config");
if(configIndex>=0){const configPath=process.argv[configIndex+1];if(!configPath||process.argv.length!==configIndex+2)throw new Error("Exactly one protected config path is required");await loadProtectedBrokerConfig(configPath);}
const chunks:Buffer[]=[];let size=0;
stdin.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>65_536){stdin.destroy(new Error("request_too_large"));}else chunks.push(chunk);});
await once(stdin,"end");
const input=Buffer.concat(chunks).toString("utf8").trim();
if(!input||input.includes("\n")){stdout.write(JSON.stringify({error:"exactly_one_request_required"})+"\n");process.exitCode=2;}
else{const module=await import("./hostBrokerRuntime.js");try{stdout.write(JSON.stringify(await module.broker.execute(JSON.parse(input)))+"\n");}catch{stdout.write(JSON.stringify({error:"invalid_request"})+"\n");process.exitCode=2;}}
