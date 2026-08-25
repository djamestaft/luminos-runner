import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendPilotRequest } from "./pilotBrokerClient.js";
import { CONTRACT_VERSION } from "@djamestaft/hermes-herdr-contracts";
import { MAX_PILOT_REQUEST_BYTES, MAX_PILOT_RESPONSE_BYTES, PILOT_IO_TIMEOUT_MS, PILOT_MAX_IO_TIMEOUT_MS, parsePilotDescriptor, parseSingleJson, pilotFailureCategory, pilotRequestTimeoutMs, validatePilotPipeName } from "./pilotBrokerIpc.js";
import { startPilotBrokerServer } from "./pilotBrokerServer.js";

const pipe = "\\\\.\\pipe\\luminos-greg-pilot-0123456789abcdef0123456789abcdef";
const descriptor = (overrides: Record<string, unknown> = {}) => JSON.stringify({ protocolVersion: 1, pipeName: pipe, processId: 42, sessionCorrelation: "0123456789abcdef0123456789abcdef", expiresAt: new Date(Date.now() + 60_000).toISOString(), ready: true, ...overrides });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let endpointSequence = 0;
const testEndpoint = (root: string): string => process.platform === "win32" ? `\\\\.\\pipe\\pilot-test-${process.pid}-${Date.now()}-${endpointSequence++}` : path.join(root, `broker-${endpointSequence++}.sock`);
const promptRequest = (timeoutMs: number) => Buffer.from(JSON.stringify({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs }));
const statusRequest = () => Buffer.from(JSON.stringify({ contractVersion: CONTRACT_VERSION, verb: "job_status", jobId: "job_12345678" }));
const timing = (baseMs: number, extendedMs: number, observed: number[]) => ({ setSocketTimeout(socket: import("node:net").Socket, timeoutMs: number) { observed.push(timeoutMs); socket.setTimeout(timeoutMs === PILOT_IO_TIMEOUT_MS ? baseMs : extendedMs); } });

test("pipe and descriptor validation is closed and time bounded", () => {
  assert.equal(validatePilotPipeName(pipe), pipe);
  for (const invalid of ["localhost:1", "\\\\.\\pipe\\other", pipe + "\n"]) assert.throws(() => validatePilotPipeName(invalid), /invalid_pipe/);
  assert.equal(parsePilotDescriptor(descriptor()).ready, true);
  assert.throws(() => parsePilotDescriptor(descriptor({ ready: false })), /invalid_descriptor/);
  assert.throws(() => parsePilotDescriptor(descriptor({ expiresAt: new Date(0).toISOString() })), /stale_descriptor/);
  assert.throws(() => parsePilotDescriptor(descriptor({ token: "redacted" })), /invalid_descriptor/);
});

test("framing accepts one bounded JSON value only", () => {
  assert.deepEqual(parseSingleJson(Buffer.from('{"ok":true}\n'), 100), { ok: true });
  assert.throws(() => parseSingleJson(Buffer.from('{}\n{}'), 100), /exactly_one/);
  assert.throws(() => parseSingleJson(Buffer.alloc(MAX_PILOT_REQUEST_BYTES + 1), MAX_PILOT_REQUEST_BYTES), /message_too_large/);
  assert.throws(() => parseSingleJson(Buffer.from("not-json"), 100), /invalid_message/);
});

test("failure categories never expose socket details", () => {
  assert.equal(pilotFailureCategory(new Error("connect ENOENT /private/path")), "pilot_unavailable");
  assert.equal(pilotFailureCategory(new Error("timeout")), "timeout");
});

test("only a valid prompt command extends the bounded client timeout", () => {
  assert.equal(pilotRequestTimeoutMs(Buffer.from(JSON.stringify({ contractVersion: CONTRACT_VERSION, verb: "job_status", jobId: "job_12345678" }))), PILOT_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(promptRequest(1_000)), PILOT_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(promptRequest(120_000)), 130_000);
  assert.equal(pilotRequestTimeoutMs(promptRequest(900_000)), PILOT_MAX_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(Buffer.from(JSON.stringify({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs: 900_001 }))), PILOT_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(Buffer.from(JSON.stringify({ verb: "prompt_job", timeoutMs: 900_000 }))), PILOT_IO_TIMEOUT_MS);
});

test("IPC forwards one request and shutdown rejects traffic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-ipc-"));
  const endpoint = testEndpoint(root);
  const seen: unknown[] = [];
  const server = await startPilotBrokerServer(endpoint, { execute: async raw => { seen.push(raw); return { contractVersion: 1, state: "refused", category: "refused" }; } });
  try {
    const output = await sendPilotRequest(endpoint, Buffer.from('{"verb":"not_added"}'));
    assert.deepEqual(JSON.parse(output.toString()), { contractVersion: 1, state: "refused", category: "refused" });
    assert.equal(seen.length, 1);
    await assert.rejects(sendPilotRequest(endpoint, Buffer.from('{}\n{}'), 100));
    assert.equal(seen.length, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  await assert.rejects(sendPilotRequest(endpoint, Buffer.from('{}'), 100));
});

test("server grants only an authoritative prompt the bounded extended execution window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-ipc-timeout-"));
  const observed: number[] = [];
  const server = await startPilotBrokerServer(testEndpoint(root), { execute: async () => { await delay(40); return { state: "ready" }; } }, timing(15, 100, observed));
  try {
    const output = await sendPilotRequest(server.endpoint, promptRequest(120_000), 250);
    assert.deepEqual(JSON.parse(output.toString()), { state: "ready" });
    assert.deepEqual(observed, [PILOT_IO_TIMEOUT_MS, 130_000]);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("non-prompt and invalid commands cannot extend the server execution window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-ipc-base-"));
  try {
    for (const request of [statusRequest(), Buffer.from(JSON.stringify({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs: 900_001 }))]) {
      const observed: number[] = [];
      const server = await startPilotBrokerServer(testEndpoint(root), { execute: async () => ({ state: "refused" }) }, timing(30, 100, observed));
      try {
        const output = await sendPilotRequest(server.endpoint, request, 200);
        assert.deepEqual(JSON.parse(output.toString()), { state: "refused" });
        assert.deepEqual(observed, [PILOT_IO_TIMEOUT_MS, PILOT_IO_TIMEOUT_MS]);
      } finally { await server.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("server returns a sanitized timeout when prompt execution exceeds its derived bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-ipc-expiry-"));
  const observed: number[] = [];
  const server = await startPilotBrokerServer(testEndpoint(root), { execute: async () => { await delay(80); return { state: "late" }; } }, timing(15, 35, observed));
  try {
    const output = await sendPilotRequest(server.endpoint, promptRequest(120_000), 250);
    assert.deepEqual(JSON.parse(output.toString()), { error: "timeout" });
    assert.deepEqual(observed, [PILOT_IO_TIMEOUT_MS, 130_000]);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("server preserves response bounds and shutdown terminates active sockets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-ipc-shutdown-"));
  try {
    const oversized = await startPilotBrokerServer(testEndpoint(root), { execute: async () => ({ payload: "x".repeat(MAX_PILOT_RESPONSE_BYTES) }) });
    try {
      const output = await sendPilotRequest(oversized.endpoint, statusRequest(), 200);
      assert.deepEqual(JSON.parse(output.toString()), { error: "response_too_large" });
    } finally { await oversized.close(); }

    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = await startPilotBrokerServer(testEndpoint(root), { execute: async () => { entered(); await gate; return { state: "late" }; } });
    const pending = sendPilotRequest(active.endpoint, statusRequest(), 500);
    await started;
    const closing = active.close();
    await assert.rejects(pending);
    await closing;
    release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
