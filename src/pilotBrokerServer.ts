import net, { type Socket } from "node:net";
import { parseBrokerCommand } from "@djamestaft/hermes-herdr-contracts";
import { MAX_PILOT_REQUEST_BYTES, MAX_PILOT_RESPONSE_BYTES, PILOT_IO_TIMEOUT_MS, parseSingleJson, pilotCommandTimeoutMs, pilotFailureCategory } from "./pilotBrokerIpc.js";

export interface PilotBroker { execute(raw: unknown): Promise<unknown>; }
export interface PilotBrokerServer { readonly endpoint: string; close(): Promise<void>; }
export interface PilotBrokerServerDependencies { setSocketTimeout?(socket: Socket, timeoutMs: number): void; }

export const startPilotBrokerServer = async (endpoint: string, broker: PilotBroker, dependencies: PilotBrokerServerDependencies = {}): Promise<PilotBrokerServer> => {
  const sockets = new Set<Socket>();
  const setSocketTimeout = dependencies.setSocketTimeout ?? ((socket: Socket, timeoutMs: number) => { socket.setTimeout(timeoutMs); });
  let stopping = false;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket);
    let phase: "receiving" | "executing" | "responded" = "receiving";
    const onTimeout = () => {
      if (phase === "executing" && !socket.destroyed) {
        phase = "responded";
        socket.setTimeout(0);
        socket.end(JSON.stringify({ error: "timeout" }) + "\n");
      } else {
        socket.destroy(new Error("timeout"));
      }
    };
    socket.on("timeout", onTimeout);
    setSocketTimeout(socket, PILOT_IO_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    let handled = false;
    const stopReceiving = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
    };
    const handleRequest = async () => {
      if (handled || socket.destroyed) return;
      handled = true;
      stopReceiving();
      try {
        const framed = Buffer.concat(chunks);
        const request = framed.at(-1) === 0x0a ? framed.subarray(0, -1) : framed;
        const raw = parseSingleJson(request, MAX_PILOT_REQUEST_BYTES);
        let executionTimeoutMs = PILOT_IO_TIMEOUT_MS;
        try { executionTimeoutMs = pilotCommandTimeoutMs(parseBrokerCommand(raw)); } catch {
          // Invalid commands remain bounded by the base timeout and are left to
          // the broker for its authoritative refusal.
        }
        phase = "executing";
        setSocketTimeout(socket, executionTimeoutMs);
        const result = await broker.execute(raw);
        if (phase !== "executing" || socket.destroyed) return;
        const output = Buffer.from(JSON.stringify(result) + "\n");
        if (output.length > MAX_PILOT_RESPONSE_BYTES) throw new Error("response_too_large");
        phase = "responded";
        socket.setTimeout(0);
        socket.end(output);
      } catch (error) {
        if (phase !== "responded" && !socket.destroyed) {
          phase = "responded";
          socket.setTimeout(0);
          socket.end(JSON.stringify({ error: pilotFailureCategory(error) }) + "\n");
        }
      }
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PILOT_REQUEST_BYTES + 1) socket.destroy(new Error("message_too_large"));
      else {
        chunks.push(chunk);
        if (chunk.includes(0x0a)) void handleRequest();
      }
    };
    const onEnd = () => { void handleRequest(); };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      socket.setTimeout(0);
      socket.off("timeout", onTimeout);
      stopReceiving();
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  return { endpoint, close: async () => {
    stopping = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
};
