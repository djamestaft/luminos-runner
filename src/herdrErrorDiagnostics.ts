export const HERDR_CREATE_PHASES = [
  "herdr_workspace_create_failed",
  "herdr_snapshot_lookup_failed",
  "herdr_agent_start_failed",
] as const;

export type HerdrCreatePhase = typeof HERDR_CREATE_PHASES[number];

export const HERDR_SERVER_ERROR_CODES = [
  "workspace_create_failed",
  "workspace_not_found",
  "pane_not_found",
  "server_unavailable",
  "server_not_running",
  "protocol_mismatch",
  "internal_error",
  "invalid_request",
  "timeout",
  "invalid_agent_name",
  "unsupported_agent_kind",
  "invalid_agent_argument",
  "invalid_agent_timeout",
  "agent_pane_not_found",
  "agent_pane_busy",
  "agent_pane_unavailable",
  "agent_start_input_failed",
  "agent_name_taken",
  "agent_launch_pending",
  "agent_start_failed",
  "agent_start_transport_failed",
  "agent_not_found",
] as const;

export type HerdrServerErrorCode = typeof HERDR_SERVER_ERROR_CODES[number];
export type HerdrCreateDiagnostic = HerdrCreatePhase | `${HerdrCreatePhase}:${HerdrServerErrorCode}`;

const phases = new Set<string>(HERDR_CREATE_PHASES);
const codes = new Set<string>(HERDR_SERVER_ERROR_CODES);

export const normalizeHerdrServerErrorCode = (value: unknown): HerdrServerErrorCode | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(normalized) || !codes.has(normalized)) return undefined;
  return normalized as HerdrServerErrorCode;
};

export const herdrCreateDiagnostic = (phase: HerdrCreatePhase, code?: HerdrServerErrorCode): HerdrCreateDiagnostic =>
  code === undefined ? phase : `${phase}:${code}`;

export const isHerdrCreateDiagnostic = (value: unknown): value is HerdrCreateDiagnostic => {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator === -1) return phases.has(value);
  if (value.indexOf(":", separator + 1) !== -1) return false;
  return phases.has(value.slice(0, separator)) && codes.has(value.slice(separator + 1));
};

export class SanitizedHerdrServerError extends Error {
  public constructor(public readonly serverCode: HerdrServerErrorCode) {
    super("herdr_command_failed");
    this.name = "SanitizedHerdrServerError";
  }
}

export const sanitizedHerdrServerCode = (error: unknown): HerdrServerErrorCode | undefined =>
  error instanceof SanitizedHerdrServerError ? error.serverCode : undefined;
