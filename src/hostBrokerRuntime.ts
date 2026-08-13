import path from "node:path";
import { HostBroker, type ProjectPolicy } from "./broker.js";
import { FileJobRegistry } from "./fileJobRegistry.js";
import { GitCliWorkspaceAdapter } from "./gitWorkspaceAdapter.js";
import { HerdrCliAdapter } from "./herdrCliAdapter.js";
import { SpawnProcessExecutor } from "./processExecutor.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`Missing required environment variable: ${name}`);return value;};
const policy:ProjectPolicy={project:required("BROKER_PROJECT_KEY"),repoRoot:required("BROKER_REPO_ROOT"),worktreeRoot:required("BROKER_WORKTREE_ROOT"),remote:process.env.BROKER_GIT_REMOTE??"origin",expectedRemoteUrl:required("BROKER_EXPECTED_REMOTE_URL"),baseRef:process.env.BROKER_BASE_REF??"origin/main",baseBranch:process.env.BROKER_BASE_BRANCH??"main",githubRepo:required("BROKER_GITHUB_REPO"),profiles:(process.env.BROKER_PROFILES??"default").split(",").map(v=>v.trim()).filter(Boolean)};
const executor=new SpawnProcessExecutor();
export const broker=new HostBroker(new Map([[policy.project,policy]]),new FileJobRegistry(path.join(required("BROKER_STATE_ROOT"),"jobs.json")),new GitCliWorkspaceAdapter(executor),new HerdrCliAdapter(executor,process.env.BROKER_AGENT_KIND==="pi"?"pi":"codex"));
