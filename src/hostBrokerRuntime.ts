import path from "node:path";
import { HostBroker } from "./broker.js";
import { FileJobRegistry } from "./fileJobRegistry.js";
import { GitCliWorkspaceAdapter } from "./gitWorkspaceAdapter.js";
import { HerdrCliAdapter } from "./herdrCliAdapter.js";
import { SpawnProcessExecutor } from "./processExecutor.js";
import { loadProtectedGithubToken } from "./protectedConfig.js";
import { loadProjectPoliciesFromEnvironment } from "./projectPolicies.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`Missing required environment variable: ${name}`);return value;};
const policies=await loadProjectPoliciesFromEnvironment();
const executor=new SpawnProcessExecutor();
const githubToken=await loadProtectedGithubToken(required("BROKER_GITHUB_TOKEN_FILE"));
export const broker=new HostBroker(policies,new FileJobRegistry(path.join(required("BROKER_STATE_ROOT"),"jobs.json")),new GitCliWorkspaceAdapter(executor,"git","gh",githubToken),new HerdrCliAdapter(executor,process.env.BROKER_AGENT_KIND==="pi"?"pi":"codex","herdr",process.env.BROKER_SHELL_ZDOTDIR));
