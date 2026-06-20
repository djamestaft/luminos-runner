import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

import type { RunnerPresence, TaskView } from "./types.js";

export interface RunnerClient {
  heartbeat(input: {
    runnerId: string;
    hostName: string;
    version: string;
    activeTasks: number;
  }): Promise<string>;
  claimNextApprovedTask(input: {
    runnerId: string;
    leaseDurationMs: number;
  }): Promise<TaskView | null>;
  releaseTaskClaim(input: {
    taskId: string;
    runnerId: string;
    reason?: string;
  }): Promise<{ taskId: string; status: string }>;
  completeClaimedTask(input: {
    taskId: string;
    runnerId: string;
    status: "in_review" | "done";
    summary?: string;
    buildPassed?: boolean;
    testsPassed?: boolean;
    prUrl?: string;
    githubPrNumber?: number;
  }): Promise<{ taskId: string; status: string }>;
  failClaimedTask(input: {
    taskId: string;
    runnerId: string;
    errorMessage: string;
  }): Promise<{ taskId: string; status: string }>;
  listRunnerPresence(): Promise<RunnerPresence[]>;
}

export class ConvexRunnerClient implements RunnerClient {
  private readonly client: ConvexHttpClient;

  public constructor(url: string, token?: string) {
    this.client = new ConvexHttpClient(url);
    if (token) {
      this.client.setAuth(token);
    }
  }

  public heartbeat(input: {
    runnerId: string;
    hostName: string;
    version: string;
    activeTasks: number;
  }): Promise<string> {
    return this.client.mutation(anyApi.runnerStatus.heartbeat, input) as Promise<string>;
  }

  public claimNextApprovedTask(input: {
    runnerId: string;
    leaseDurationMs: number;
  }): Promise<TaskView | null> {
    return this.client.mutation(anyApi.tasks.claimNextApprovedTask, input) as Promise<TaskView | null>;
  }

  public releaseTaskClaim(input: {
    taskId: string;
    runnerId: string;
    reason?: string;
  }): Promise<{ taskId: string; status: string }> {
    return this.client.mutation(anyApi.tasks.releaseTaskClaim, input) as Promise<{
      taskId: string;
      status: string;
    }>;
  }

  public completeClaimedTask(input: {
    taskId: string;
    runnerId: string;
    status: "in_review" | "done";
    summary?: string;
    buildPassed?: boolean;
    testsPassed?: boolean;
    prUrl?: string;
    githubPrNumber?: number;
  }): Promise<{ taskId: string; status: string }> {
    return this.client.mutation(anyApi.tasks.completeClaimedTask, input) as Promise<{
      taskId: string;
      status: string;
    }>;
  }

  public failClaimedTask(input: {
    taskId: string;
    runnerId: string;
    errorMessage: string;
  }): Promise<{ taskId: string; status: string }> {
    return this.client.mutation(anyApi.tasks.failClaimedTask, input) as Promise<{
      taskId: string;
      status: string;
    }>;
  }

  public listRunnerPresence(): Promise<RunnerPresence[]> {
    return this.client.query(anyApi.runnerStatus.listRunnerPresence, {}) as Promise<RunnerPresence[]>;
  }
}
