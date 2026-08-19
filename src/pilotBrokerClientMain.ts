import { once } from "node:events";
import { stdin, stdout } from "node:process";
import { MAX_PILOT_REQUEST_BYTES, pilotFailureCategory, readPilotDescriptor } from "./pilotBrokerIpc.js";
import { sendPilotRequest } from "./pilotBrokerClient.js";

const fail = (error: unknown): void => { stdout.write(JSON.stringify({ error: pilotFailureCategory(error) }) + "\n"); process.exitCode = 2; };
try {
  if (process.platform !== "win32") throw new Error("pilot_unavailable");
  if (process.argv.length !== 3) throw new Error("invalid_descriptor");
  const descriptor = await readPilotDescriptor(process.argv[2]);
  const chunks: Buffer[] = []; let size = 0;
  stdin.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_PILOT_REQUEST_BYTES) stdin.destroy(new Error("message_too_large")); else chunks.push(chunk); });
  await once(stdin, "end");
  stdout.write(await sendPilotRequest(descriptor.pipeName, Buffer.concat(chunks)));
} catch (error) { fail(error); }
