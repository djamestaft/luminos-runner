import { once } from "node:events";
import path from "node:path";
import { stdin,stdout } from "node:process";
import { loadProtectedBrokerConfig } from "./protectedConfig.js";
import { RepositoryQueryService,SpawnQueryProcess } from "./repositoryQuery.js";
import { loadProtectedQuerySources } from "./querySources.js";

const required=(name:string):string=>{const value=process.env[name]?.trim();if(!value)throw new Error(`Missing required environment variable: ${name}`);return value;};
const configIndex=process.argv.indexOf("--config");if(configIndex<0||!process.argv[configIndex+1]||process.argv.length!==configIndex+2)throw new Error("Exactly one protected config path is required");await loadProtectedBrokerConfig(process.argv[configIndex+1]);
const codexJs=required("QUERY_CODEX_JS");if(!path.isAbsolute(codexJs))throw new Error("QUERY_CODEX_JS must be absolute");const timeoutMs=Number(process.env.QUERY_TIMEOUT_MS??"600000");if(!Number.isSafeInteger(timeoutMs)||timeoutMs<30_000||timeoutMs>900_000)throw new Error("Invalid QUERY_TIMEOUT_MS");
const chunks:Buffer[]=[];let size=0;stdin.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>65_536)stdin.destroy(new Error("request_too_large"));else chunks.push(chunk);});await once(stdin,"end");
const input=Buffer.concat(chunks).toString("utf8").trim();if(!input||input.includes("\n")){stdout.write(JSON.stringify({version:1,queryId:"query_invalid",state:"refused",category:"invalid_query"})+"\n");process.exitCode=2;}
else{let raw:unknown;try{raw=JSON.parse(input);}catch{raw=undefined;}const service=new RepositoryQueryService(await loadProtectedQuerySources(required("QUERY_SOURCES_FILE")),new SpawnQueryProcess(),{expectedUsername:required("QUERY_EXPECTED_USERNAME"),codexJs,timeoutMs});const result=await service.execute(raw);stdout.write(JSON.stringify(result)+"\n");}
