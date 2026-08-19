import net from "node:net";
import { MAX_PILOT_REQUEST_BYTES, MAX_PILOT_RESPONSE_BYTES, PILOT_IO_TIMEOUT_MS, parseSingleJson } from "./pilotBrokerIpc.js";

export const sendPilotRequest = async (endpoint: string, request: Buffer, timeoutMs = PILOT_IO_TIMEOUT_MS): Promise<Buffer> => {
  parseSingleJson(request, MAX_PILOT_REQUEST_BYTES);
  return new Promise<Buffer>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);
    const finish = (action: () => void) => { clearTimeout(timer); action(); };
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_PILOT_RESPONSE_BYTES) socket.destroy(new Error("response_too_large")); else chunks.push(chunk); });
    socket.on("end", () => finish(() => { const result = Buffer.concat(chunks); try { parseSingleJson(result, MAX_PILOT_RESPONSE_BYTES); resolve(result); } catch (error) { reject(error); } }));
    socket.on("error", (error) => finish(() => reject(error)));
  });
};
