import type { HerdrAdapter } from "./broker.js";
import { herdrCreateDiagnostic, normalizeHerdrServerErrorCode, SanitizedHerdrServerError, sanitizedHerdrServerCode, type HerdrCreatePhase } from "./herdrErrorDiagnostics.js";
import type { ProcessExecutor } from "./processExecutor.js";

type HerdrStatus = "working" | "ready" | "unknown";
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const jsonObject = (text: string): Record<string, unknown> | undefined => { try { return object(JSON.parse(text)); } catch { return undefined; } };
const result = (value: Record<string, unknown>) => object(value.result) ?? value;
const status = (value: unknown): HerdrStatus => value === "working" || value === "blocked" ? "working" : value === "idle" || value === "done" ? "ready" : "unknown";
const agentStatus = (value: Record<string, unknown>): HerdrStatus => {
  const resolved = result(value);
  return status(object(resolved.agent)?.agent_status ?? resolved.agent_status);
};
const agentNameForJob = (jobId: string): string => `job-${jobId.replace(/^job_/, "").slice(0, 28)}`;
const readableName = (label:string,jobId:string):string => { const suffix=jobId.replace(/^job_/,"").slice(0,8).toLowerCase();const slug=label.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,14).replace(/-$/g,"")||"task";return `discord-${slug}-${suffix}`; };
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const createFailure = (phase: HerdrCreatePhase, error: unknown): Error => new Error(herdrCreateDiagnostic(phase, sanitizedHerdrServerCode(error)));
export const herdrBinaryForPlatform=(_platform:NodeJS.Platform):string=>"herdr";

export class HerdrCliAdapter implements HerdrAdapter {
  public constructor(private readonly executor: ProcessExecutor, private readonly agentKind: "codex" | "pi", private readonly binary = herdrBinaryForPlatform(process.platform), private readonly shellZdotdir?: string) {}
  public async create(input: { jobId: string; cwd: string; profile: string; label: string }): Promise<{ sessionId: string; workspaceId:string }> {
    const agentName = readableName(input.label,input.jobId);
    let workspaceId:string;
    try {
      const workspaceArgs = ["workspace", "create", "--cwd", input.cwd, "--label", agentName];
      if (this.shellZdotdir) workspaceArgs.push("--env", `ZDOTDIR=${this.shellZdotdir}`);
      workspaceArgs.push("--no-focus");
      const workspace = object(result(await this.call(workspaceArgs)).workspace);
      if (typeof workspace?.workspace_id !== "string") throw new Error("invalid_workspace");
      workspaceId=workspace.workspace_id;
    } catch (error) { throw createFailure("herdr_workspace_create_failed", error); }
    let paneId:string;
    try {
      const snapshot = result(await this.call(["api", "snapshot"]));
      const snap = object(snapshot.snapshot); const panes = Array.isArray(snap?.panes) ? snap.panes : [];
      const pane = panes.map(object).find((candidate) => candidate?.workspace_id === workspaceId);
      if (typeof pane?.pane_id !== "string") throw new Error("invalid_pane");
      paneId=pane.pane_id;
    } catch (error) { throw createFailure("herdr_snapshot_lookup_failed", error); }
    try {
      const startArgs = ["agent", "start", agentName, "--kind", this.agentKind, "--pane", paneId, "--timeout", "300000"];
      if (this.agentKind === "codex") startArgs.push("--", "--yolo");
      await this.startAgent(agentName,startArgs);
    } catch (error) { throw createFailure("herdr_agent_start_failed", error); }
    return { sessionId: agentName, workspaceId };
  }
  public async prompt(sessionId: string, text: string, timeoutMs: number): Promise<HerdrStatus> {
    const controlledTask = `${text}\n\nRunner handoff requirement: leave the requested changes committed on the current job branch before finishing. Do not include unrelated changes in that commit.`;
    // Herdr's default --wait contract settles only when the agent is idle,
    // done, or blocked. Treating `unknown` as a requested terminal state lets
    // a transient detector result win the race and incorrectly persists a
    // running job as unknown even though the agent continues successfully.
    const response = await this.call(["agent", "prompt", sessionId, controlledTask, "--wait", "--timeout", String(timeoutMs)], timeoutMs + 5_000, true);
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
    let output;
    try { output = await this.executor.run(this.binary, args, timeout); }
    catch(error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code).toUpperCase() : "";
      if (code === "ENOENT") throw new Error("herdr_process_start_failed_enoent");
      if (error instanceof Error && error.message === "process_timeout") throw error;
      if (error instanceof Error && error.message === "process_output_too_large") throw error;
      throw new Error("herdr_process_start_failed");
    }
    if (output.exitCode === 0) {
      const parsed = jsonObject(output.stdout);
      if (!parsed) throw new Error("herdr_protocol_error");
      return parsed;
    }
    if (output.exitCode === 1) {
      const envelope = jsonObject(output.stderr);
      const error = object(envelope?.error);
      const code = typeof error?.message === "string" ? normalizeHerdrServerErrorCode(error.code) : undefined;
      if (code) {
        if (allowError) return {error:{code}};
        throw new SanitizedHerdrServerError(code);
      }
      throw new Error("herdr_protocol_error");
    }
    throw new Error("herdr_command_failed");
  }
}
