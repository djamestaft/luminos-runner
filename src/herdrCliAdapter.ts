import type { HerdrAdapter } from "./broker.js";
import type { ProcessExecutor } from "./processExecutor.js";

type HerdrStatus = "working" | "ready" | "unknown";
const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const result = (value: Record<string, unknown>) => object(value.result) ?? value;
const status = (value: unknown): HerdrStatus => value === "working" ? "working" : value === "idle" || value === "done" || value === "blocked" ? "ready" : "unknown";

export class HerdrCliAdapter implements HerdrAdapter {
  public constructor(private readonly executor: ProcessExecutor, private readonly agentKind: "codex" | "pi", private readonly binary = "herdr") {}
  public async create(input: { jobId: string; cwd: string; profile: string }): Promise<{ sessionId: string }> {
    const created = await this.call(["workspace", "create", "--cwd", input.cwd, "--label", `job-${input.jobId}`, "--no-focus"]);
    const workspace = object(result(created).workspace); const workspaceId = workspace?.workspace_id;
    if (typeof workspaceId !== "string") throw new Error("herdr_create_failed");
    const snapshot = result(await this.call(["api", "snapshot"]));
    const snap = object(snapshot.snapshot); const panes = Array.isArray(snap?.panes) ? snap.panes : [];
    const pane = panes.map(object).find((candidate) => candidate?.workspace_id === workspaceId);
    if (typeof pane?.pane_id !== "string") throw new Error("herdr_create_failed");
    const agentName = `job-${input.jobId}`;
    await this.call(["agent", "start", agentName, "--kind", this.agentKind, "--pane", pane.pane_id, "--timeout", "300000"], 305_000);
    return { sessionId: agentName };
  }
  public async prompt(sessionId: string, text: string, timeoutMs: number): Promise<HerdrStatus> {
    const response = await this.call(["agent", "prompt", sessionId, text, "--wait", "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown", "--timeout", String(timeoutMs)], timeoutMs + 5_000, true);
    if (object(response.error)?.code === "timeout") return "unknown";
    return status(result(response).agent_status);
  }
  public async status(sessionId: string): Promise<HerdrStatus> { return status(result(await this.call(["agent", "get", sessionId])).agent_status); }
  public async read(sessionId: string, maxLines: number): Promise<string> {
    const response = result(await this.call(["agent", "read", sessionId, "--source", "recent-unwrapped", "--lines", String(maxLines), "--format", "text"]));
    return typeof response.text === "string" ? response.text : "";
  }
  private async call(args: readonly string[], timeout?: number, allowError = false): Promise<Record<string, unknown>> {
    const output = await this.executor.run(this.binary, args, timeout);
    let parsed: Record<string, unknown>; try { parsed = json(output.stdout); } catch { throw new Error("herdr_protocol_error"); }
    if (output.exitCode !== 0 && !allowError) throw new Error("herdr_command_failed");
    return parsed;
  }
}
