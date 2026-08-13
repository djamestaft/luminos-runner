export declare const CONTRACT_VERSION: "2026-08-13";
export declare const MAX_TASK_TEXT_LENGTH = 8000;
export declare const MAX_READ_LINES = 200;
export declare const MAX_TIMEOUT_MS = 900000;
export declare const MAX_RESULT_SUMMARY_LENGTH = 2000;
export declare const JOB_TYPES: readonly ["implementation", "review", "dataverse-authorized-test"];
export declare const RUNNERS: readonly ["devon", "greg"];
export declare const JOB_STATES: readonly ["draft", "approved", "creating", "ready", "working", "unknown", "handoff_ready", "closed", "refused", "failed"];
export declare const BROKER_VERBS: readonly ["create_job", "prompt_job", "job_status", "read_job", "handoff_job", "close_job", "recover_job"];
export type JobType = (typeof JOB_TYPES)[number];
export type RunnerKey = (typeof RUNNERS)[number];
export type JobState = (typeof JOB_STATES)[number];
export type BrokerVerb = (typeof BROKER_VERBS)[number];
export interface JobRequest { contractVersion: typeof CONTRACT_VERSION; jobType: JobType; runner: RunnerKey; project: string; taskText: string; }
export type BrokerCommand =
  | { contractVersion: typeof CONTRACT_VERSION; verb: "create_job"; jobId: string; project: string; profile: string; label: string }
  | { contractVersion: typeof CONTRACT_VERSION; verb: "prompt_job"; jobId: string; taskText: string; timeoutMs: number }
  | { contractVersion: typeof CONTRACT_VERSION; verb: "job_status"; jobId: string }
  | { contractVersion: typeof CONTRACT_VERSION; verb: "read_job"; jobId: string; maxLines: number }
  | { contractVersion: typeof CONTRACT_VERSION; verb: "handoff_job" | "close_job" | "recover_job"; jobId: string };
export interface BrokerResult { contractVersion: typeof CONTRACT_VERSION; jobId: string; state: JobState; category: "ok" | "refused" | "busy" | "timeout" | "unknown" | "failed"; branch?: string; commitSha?: string; prUrl?: string; summary?: string; }
export declare const parseJobRequest: (input: unknown) => JobRequest;
export declare const parseBrokerCommand: (input: unknown) => BrokerCommand;
export declare const parseBrokerResult: (input: unknown) => BrokerResult;
