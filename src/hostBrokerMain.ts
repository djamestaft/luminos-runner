import { loadProtectedBrokerConfig } from "./protectedConfig.js";
const configIndex=process.argv.indexOf("--config");
if(configIndex>=0){const configPath=process.argv[configIndex+1];if(!configPath||process.argv.length!==configIndex+2)throw new Error("Exactly one protected config path is required");await loadProtectedBrokerConfig(configPath);}
const [{serveStdio},{broker}]=await Promise.all([import("./brokerStdio.js"),import("./hostBrokerRuntime.js")]);
process.stderr.write(JSON.stringify({event:"broker_ready",transport:"stdio"})+"\n");serveStdio(broker);
