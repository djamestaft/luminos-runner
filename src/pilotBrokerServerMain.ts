import { open, rm } from "node:fs/promises";
import { loadProtectedBrokerConfig } from "./protectedConfig.js";
import { PILOT_PROTOCOL_VERSION, validatePilotPipeName, type PilotDescriptor } from "./pilotBrokerIpc.js";
import { startPilotBrokerServer } from "./pilotBrokerServer.js";

const parseArgs = (): Record<string, string> => {
  if (process.argv.length !== 10) throw new Error("invalid_arguments");
  const result: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index]; const value = process.argv[index + 1];
    if (!["--config", "--pipe", "--descriptor", "--ready"].includes(name) || !value || result[name]) throw new Error("invalid_arguments");
    result[name] = value;
  }
  if (Object.keys(result).length !== 4) throw new Error("invalid_arguments");
  return result;
};

if (process.platform !== "win32") throw new Error("windows_required");
const args = parseArgs();
const pipeName = validatePilotPipeName(args["--pipe"]);
await loadProtectedBrokerConfig(args["--config"]);
const { broker } = await import("./hostBrokerRuntime.js");
const server = await startPilotBrokerServer(pipeName, broker);
const correlation = pipeName.slice(-32);
const descriptor: PilotDescriptor = { protocolVersion: PILOT_PROTOCOL_VERSION, pipeName, processId: process.pid, sessionCorrelation: correlation, expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), ready: true };
const owned: string[] = [];
try {
  const descriptorFile = await open(args["--descriptor"], "wx", 0o600); owned.push(args["--descriptor"]); await descriptorFile.writeFile(JSON.stringify(descriptor)); await descriptorFile.close();
  const readyFile = await open(args["--ready"], "wx", 0o600); owned.push(args["--ready"]); await readyFile.writeFile(correlation); await readyFile.close();
  process.stderr.write(JSON.stringify({ event: "pilot_ready", correlation }) + "\n");
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} finally {
  await server.close();
  for (const path of owned.reverse()) await rm(path, { force: true });
  process.stderr.write(JSON.stringify({ event: "pilot_stopped" }) + "\n");
}
