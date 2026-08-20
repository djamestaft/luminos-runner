import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendPilotRequest } from "./pilotBrokerClient.js";
import { CONTRACT_VERSION } from "@djamestaft/hermes-herdr-contracts";
import { MAX_PILOT_REQUEST_BYTES, PILOT_IO_TIMEOUT_MS, PILOT_MAX_IO_TIMEOUT_MS, parsePilotDescriptor, parseSingleJson, pilotFailureCategory, pilotRequestTimeoutMs, validatePilotPipeName } from "./pilotBrokerIpc.js";
import { startPilotBrokerServer } from "./pilotBrokerServer.js";

const pipe = "\\\\.\\pipe\\luminos-greg-pilot-0123456789abcdef0123456789abcdef";
const descriptor = (overrides: Record<string, unknown> = {}) => JSON.stringify({ protocolVersion: 1, pipeName: pipe, processId: 42, sessionCorrelation: "0123456789abcdef0123456789abcdef", expiresAt: new Date(Date.now() + 60_000).toISOString(), ready: true, ...overrides });

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
  const prompt = (timeoutMs: number) => Buffer.from(JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    verb: "prompt_job",
    jobId: "job_12345678",
    taskText: "bounded task",
    timeoutMs,
  }));
  assert.equal(pilotRequestTimeoutMs(Buffer.from(JSON.stringify({ contractVersion: CONTRACT_VERSION, verb: "job_status", jobId: "job_12345678" }))), PILOT_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(prompt(1_000)), PILOT_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(prompt(120_000)), 130_000);
  assert.equal(pilotRequestTimeoutMs(prompt(900_000)), PILOT_MAX_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(Buffer.from(JSON.stringify({ contractVersion: CONTRACT_VERSION, verb: "prompt_job", jobId: "job_12345678", taskText: "bounded task", timeoutMs: 900_001 }))), PILOT_IO_TIMEOUT_MS);
  assert.equal(pilotRequestTimeoutMs(Buffer.from(JSON.stringify({ verb: "prompt_job", timeoutMs: 900_000 }))), PILOT_IO_TIMEOUT_MS);
});

test("IPC forwards one request and shutdown rejects traffic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-ipc-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\pilot-test-${process.pid}-${Date.now()}` : path.join(root, "broker.sock");
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
