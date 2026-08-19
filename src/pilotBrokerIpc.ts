import { readFile } from "node:fs/promises";

export const PILOT_PROTOCOL_VERSION = 1;
export const MAX_PILOT_REQUEST_BYTES = 65_536;
export const MAX_PILOT_RESPONSE_BYTES = 65_536;
export const PILOT_IO_TIMEOUT_MS = 30_000;
const PIPE = /^\\\\\.\\pipe\\luminos-greg-pilot-[a-f0-9]{32}$/;

export interface PilotDescriptor {
  protocolVersion: 1;
  pipeName: string;
  processId: number;
  sessionCorrelation: string;
  expiresAt: string;
  ready: true;
}

export const validatePilotPipeName = (value: string): string => {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || !PIPE.test(value)) throw new Error("invalid_pipe");
  return value;
};

export const parsePilotDescriptor = (raw: string, now = Date.now()): PilotDescriptor => {
  if (Buffer.byteLength(raw) > 4096) throw new Error("invalid_descriptor");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("invalid_descriptor"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_descriptor");
  const record = value as Record<string, unknown>;
  const expected = ["expiresAt", "pipeName", "processId", "protocolVersion", "ready", "sessionCorrelation"];
  if (Object.keys(record).sort().join(",") !== expected.join(",") || record.protocolVersion !== PILOT_PROTOCOL_VERSION || record.ready !== true || !Number.isSafeInteger(record.processId) || Number(record.processId) < 1 || typeof record.sessionCorrelation !== "string" || !/^[a-f0-9]{32}$/.test(record.sessionCorrelation)) throw new Error("invalid_descriptor");
  validatePilotPipeName(String(record.pipeName));
  if (typeof record.expiresAt !== "string") throw new Error("invalid_descriptor");
  const expiry = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 86_400_000) throw new Error("stale_descriptor");
  return record as unknown as PilotDescriptor;
};

export const readPilotDescriptor = async (path: string, now = Date.now()): Promise<PilotDescriptor> => parsePilotDescriptor(await readFile(path, "utf8"), now);

export const parseSingleJson = (data: Buffer, maximum: number): unknown => {
  if (data.length === 0 || data.length > maximum) throw new Error(data.length > maximum ? "message_too_large" : "invalid_message");
  const text = data.toString("utf8");
  if (text.includes("\0") || text.trim().split(/\r?\n/).length !== 1) throw new Error("exactly_one_request_required");
  try { return JSON.parse(text); } catch { throw new Error("invalid_message"); }
};

export const pilotFailureCategory = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  return ["invalid_descriptor", "stale_descriptor", "message_too_large", "exactly_one_request_required", "invalid_message", "timeout", "response_too_large"].includes(message) ? message : "pilot_unavailable";
};
