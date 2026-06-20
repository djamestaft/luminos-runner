import { setTimeout as delay } from "node:timers/promises";

import type { RunnerConfig } from "./types.js";
import { ConvexRunnerClient, type RunnerClient } from "./convexRunnerClient.js";
import { TaskExecutionError, type TaskHandler, WorktreeTaskHandler } from "./worktreeTaskHandler.js";

export class Runner {
  private readonly client: RunnerClient;
  private readonly handler: TaskHandler;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = false;
  private processing = false;

  public constructor(
    private readonly config: RunnerConfig,
    dependencies: {
      client?: RunnerClient;
      handler?: TaskHandler;
    } = {}
  ) {
    this.client = dependencies.client ?? new ConvexRunnerClient(config.convexUrl, config.convexToken);
    this.handler = dependencies.handler ?? new WorktreeTaskHandler(config);
  }

  public async start(): Promise<void> {
    console.log(
      JSON.stringify({
        event: "runner_started",
        runnerId: this.config.runnerId,
        hostName: this.config.hostName,
        version: this.config.version
      })
    );

    await this.sendHeartbeat(0);
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat(this.processing ? 1 : 0);
    }, this.config.heartbeatIntervalMs);

    while (!this.stopped) {
      if (!this.processing) {
        await this.runOnce();
      }
      await delay(this.config.pollIntervalMs);
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    await this.sendHeartbeat(0);
  }

  private async sendHeartbeat(activeTasks: number): Promise<void> {
    try {
      await this.client.heartbeat({
        runnerId: this.config.runnerId,
        hostName: this.config.hostName,
        version: this.config.version,
        activeTasks
      });
    } catch (error) {
      console.error("runner heartbeat failed", error);
    }
  }

  public async runOnce(): Promise<void> {
    this.processing = true;

    try {
      const task = await this.client.claimNextApprovedTask({
        runnerId: this.config.runnerId,
        leaseDurationMs: this.config.leaseDurationMs
      });

      if (!task) {
        return;
      }

      await this.sendHeartbeat(1);
      try {
        const result = await this.handler.run(task);
        await this.client.completeClaimedTask({
          taskId: task._id,
          runnerId: this.config.runnerId,
          status: result.status,
          summary: result.summary
        });
      } catch (error) {
        const failureMetadata = getFailureMetadata(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            event: "task_execution_failed",
            taskId: task._id,
            errorMessage,
            ...failureMetadata
          })
        );

        const formattedFailure = formatFailureMessage(errorMessage, failureMetadata);

        try {
          await this.client.failClaimedTask({
            taskId: task._id,
            runnerId: this.config.runnerId,
            errorMessage: formattedFailure
          });
        } catch (failureUpdateError) {
          console.error("runner failed to mark task as failed", failureUpdateError);
          await this.releaseClaimAfterFailure(task._id, formattedFailure, failureUpdateError);
        }
      }
    } catch (error) {
      console.error("runner loop iteration failed", error);
    } finally {
      this.processing = false;
      await this.sendHeartbeat(0);
    }
  }

  private async releaseClaimAfterFailure(
    taskId: string,
    errorMessage: string,
    failureUpdateError: unknown
  ): Promise<void> {
    const releaseReason = [
      "Execution failed before terminal status update could be persisted.",
      errorMessage,
      `Fallback release reason: ${formatNestedError(failureUpdateError)}`
    ].join("\n");

    try {
      await this.client.releaseTaskClaim({
        taskId,
        runnerId: this.config.runnerId,
        reason: releaseReason
      });
    } catch (releaseError) {
      console.error("runner failed to release claimed task after execution failure", releaseError);
      throw releaseError;
    }
  }
}

const getFailureMetadata = (
  error: unknown
): { branchName?: string; worktreePath?: string; commitSha?: string } => {
  if (error instanceof TaskExecutionError) {
    return {
      branchName: error.branchName,
      worktreePath: error.worktreePath,
      commitSha: error.commitSha
    };
  }

  return {};
};

const formatFailureMessage = (
  errorMessage: string,
  metadata: { branchName?: string; worktreePath?: string; commitSha?: string }
): string => {
  const lines = [errorMessage];
  if (metadata.branchName) {
    lines.push(`Branch: ${metadata.branchName}`);
  }
  if (metadata.worktreePath) {
    lines.push(`Worktree: ${metadata.worktreePath}`);
  }
  if (metadata.commitSha) {
    lines.push(`Commit: ${metadata.commitSha}`);
  }
  return lines.join("\n");
};

const formatNestedError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
