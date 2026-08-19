import net, { type Socket } from "node:net";
import { MAX_PILOT_REQUEST_BYTES, MAX_PILOT_RESPONSE_BYTES, PILOT_IO_TIMEOUT_MS, parseSingleJson, pilotFailureCategory } from "./pilotBrokerIpc.js";

export interface PilotBroker { execute(raw: unknown): Promise<unknown>; }
export interface PilotBrokerServer { readonly endpoint: string; close(): Promise<void>; }

export const startPilotBrokerServer = async (endpoint: string, broker: PilotBroker): Promise<PilotBrokerServer> => {
  const sockets = new Set<Socket>();
  let stopping = false;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(PILOT_IO_TIMEOUT_MS, () => socket.destroy(new Error("timeout")));
    const chunks: Buffer[] = [];
    let size = 0;
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PILOT_REQUEST_BYTES) socket.destroy(new Error("message_too_large"));
      else chunks.push(chunk);
    });
    socket.on("end", async () => {
      if (handled || socket.destroyed) return;
      handled = true;
      try {
        const result = await broker.execute(parseSingleJson(Buffer.concat(chunks), MAX_PILOT_REQUEST_BYTES));
        const output = Buffer.from(JSON.stringify(result) + "\n");
        if (output.length > MAX_PILOT_RESPONSE_BYTES) throw new Error("response_too_large");
        socket.end(output);
      } catch (error) {
        socket.end(JSON.stringify({ error: pilotFailureCategory(error) }) + "\n");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  return { endpoint, close: async () => {
    stopping = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
};
