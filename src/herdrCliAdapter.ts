import type { HerdrAdapter } from "./broker.js";
import type { ProcessExecutor } from "./processExecutor.js";

type HerdrStatus = "working" | "ready" | "unknown";
const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const result = (value: Record<string, unknown>) => object(value.result) ?? value;
const status = (value: unknown): HerdrStatus => value === "working" || value === "blocked" ? "working" : value === "idle" || value === "done" ? "ready" : "unknown";
const agentStatus = (value: Record<string, unknown>): HerdrStatus => {
  const resolved = result(value);
  return status(object(resolved.agent)?.agent_status ?? resolved.agent_status);
};
const agentNameForJob = (jobId: string): string => `job-${jobId.replace(/^job_/, "").slice(0, 28)}`;
const readableName = (label:string,jobId:string):string => { const suffix=jobId.replace(/^job_/,"").slice(0,8).toLowerCase();const slug=label.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,14).replace(/-$/g,"")||"task";return `discord-${slug}-${suffix}`; };
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export class HerdrCliAdapter implements HerdrAdapter {
  public constructor(private readonly executor: ProcessExecutor, private readonly agentKind: "codex" | "pi", private readonly binary = "herdr", private readonly shellZdotdir?: string) {}
  public async create(input: { jobId: string; cwd: string; profile: string; label: string }): Promise<{ sessionId: string; workspaceId:string }> {
    const agentName = readableName(input.label,input.jobId);
    const workspaceArgs = ["workspace", "create", "--cwd", input.cwd, "--label", agentName];
    if (this.shellZdotdir) workspaceArgs.push("--env", `ZDOTDIR=${this.shellZdotdir}`);
    workspaceArgs.push("--no-focus");
    const created = await this.call(workspaceArgs);
    const workspace = object(result(created).workspace); const workspaceId = workspace?.workspace_id;
    if (typeof workspaceId !== "string") throw new Error("herdr_create_failed");
    const snapshot = result(await this.call(["api", "snapshot"]));
    const snap = object(snapshot.snapshot); const panes = Array.isArray(snap?.panes) ? snap.panes : [];
    const pane = panes.map(object).find((candidate) => candidate?.workspace_id === workspaceId);
    if (typeof pane?.pane_id !== "string") throw new Error("herdr_create_failed");
    const startArgs = ["agent", "start", agentName, "--kind", this.agentKind, "--pane", pane.pane_id, "--timeout", "300000"];
    if (this.agentKind === "codex") startArgs.push("--", "--yolo");
    await this.startAgent(agentName,startArgs);
    return { sessionId: agentName, workspaceId };
  }
  public async prompt(sessionId: string, text: string, timeoutMs: number): Promise<HerdrStatus> {
    const controlledTask = `${text}\n\nRunner handoff requirement: leave the requested changes committed on the current job branch before finishing. Do not include unrelated changes in that commit.`;
    const response = await this.call(["agent", "prompt", sessionId, controlledTask, "--wait", "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown", "--timeout", String(timeoutMs)], timeoutMs + 5_000, true);
    if (object(response.error)?.code === "timeout") return "unknown";
    return agentStatus(response);
  }
  public async status(sessionId: string): Promise<HerdrStatus> { return agentStatus(await this.call(["agent", "get", sessionId])); }
  public async read(sessionId: string, maxLines: number): Promise<string> {
    // Unlike Herdr's control commands, `agent read` writes the bounded
    // transcript directly to stdout instead of returning a JSON envelope.
    const output = await this.executor.run(this.binary, ["agent", "read", sessionId, "--source", "recent-unwrapped", "--lines", String(maxLines)]);
    if (output.exitCode !== 0) throw new Error("herdr_command_failed");
    return output.stdout;
  }
  public async close(sessionId:string,workspaceId?:string):Promise<void>{
    let resolved=workspaceId;
    if(!resolved){const agent=result(await this.call(["agent","get",sessionId]));const candidate=object(agent.agent);if(typeof candidate?.workspace_id==="string")resolved=candidate.workspace_id;}
    if(!resolved)throw new Error("herdr_workspace_unknown");
    const response=await this.call(["workspace","close",resolved],30_000,true);
    const code=object(response.error)?.code;
    if(code!==undefined&&code!=="workspace_not_found")throw new Error("herdr_close_failed");
  }
  private async startAgent(agentName:string,args:readonly string[]):Promise<void>{
    for(let attempt=0;attempt<10;attempt++){
      try{await this.call(args,305_000);return;}catch(error){
        // A response can be lost after launch. Check the durable Herdr name
        // before retrying so startup remains at-most-once.
        try{await this.call(["agent","get",agentName],5_000);return;}catch{/* The shell may not be ready yet. */}
        if(attempt===9)throw error;
        await pause(500);
      }
    }
  }
  private async call(args: readonly string[], timeout?: number, allowError = false): Promise<Record<string, unknown>> {
    const output = await this.executor.run(this.binary, args, timeout);
    let parsed: Record<string, unknown>; try { parsed = json(output.stdout); } catch { throw new Error("herdr_protocol_error"); }
    if (output.exitCode !== 0 && !allowError) throw new Error("herdr_command_failed");
    return parsed;
  }
}
