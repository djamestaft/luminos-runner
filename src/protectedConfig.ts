import { readFile, stat } from "node:fs/promises";
import path from "node:path";
const ALLOWED=new Set(["BROKER_PROJECTS_FILE","BROKER_PROJECT_KEY","BROKER_REPO_ROOT","BROKER_WORKTREE_ROOT","BROKER_EXPECTED_REMOTE_URL","BROKER_GITHUB_REPO","BROKER_GITHUB_TOKEN_FILE","BROKER_GIT_REMOTE","BROKER_BASE_REF","BROKER_BASE_BRANCH","BROKER_PROFILES","BROKER_STATE_ROOT","BROKER_AGENT_KIND","BROKER_SHELL_ZDOTDIR","QUERY_SOURCES_FILE","QUERY_EXPECTED_USERNAME","QUERY_CODEX_JS","QUERY_TIMEOUT_MS"]);
export const loadProtectedBrokerConfig=async(filePath:string):Promise<void>=>{
  const metadata=await stat(filePath);if(!metadata.isFile()||metadata.size>65_536)throw new Error("Invalid protected broker config");
  if(process.platform!=="win32"){if((metadata.mode&0o077)!==0)throw new Error("Protected broker config must not be group/world accessible");if(typeof process.getuid==="function"&&metadata.uid!==process.getuid()&&process.getuid()!==0)throw new Error("Protected broker config owner mismatch");}
  const lines=(await readFile(filePath,"utf8")).split(/\r?\n/);for(const line of lines){const trimmed=line.trim();if(!trimmed||trimmed.startsWith("#"))continue;const separator=trimmed.indexOf("=");if(separator<1)throw new Error("Invalid broker config line");const name=trimmed.slice(0,separator).trim();if(!ALLOWED.has(name))throw new Error(`Unsupported broker config key: ${name}`);const value=trimmed.slice(separator+1).trim();if(!value||value.includes("\0"))throw new Error(`Invalid broker config value: ${name}`);process.env[name]=value;}
};
export const loadProtectedGithubToken=async(filePath:string):Promise<string>=>{
  if(!path.isAbsolute(filePath))throw new Error("Protected GitHub token path must be absolute");
  const metadata=await stat(filePath);if(!metadata.isFile()||metadata.size<1||metadata.size>512)throw new Error("Invalid protected GitHub token file");
  if(process.platform!=="win32"){if((metadata.mode&0o077)!==0)throw new Error("Protected GitHub token must not be group/world accessible");if(typeof process.getuid==="function"&&metadata.uid!==process.getuid()&&process.getuid()!==0)throw new Error("Protected GitHub token owner mismatch");}
  const token=(await readFile(filePath,"utf8")).trim();if(!token||token.length>500||/\s|\0/.test(token))throw new Error("Invalid protected GitHub token");return token;
};
