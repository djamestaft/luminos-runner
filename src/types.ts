export type TaskStatus =
  | "new"
  | "approved"
  | "working"
  | "in_review"
  | "done"
  | "needs_info"
  | "blocked"
  | "failed";

export interface TaskView {
  _id: string;
  title: string;
  body: string;
  status: TaskStatus;
  createdBy: string;
  approvedBy?: string;
  claimedBy?: string;
  discordThreadId?: string;
  discordChannelId?: string;
  discordInteractionId?: string;
  discordMessageId?: string;
  githubPrNumber?: number;
  prUrl?: string;
  buildPassed?: boolean;
  testsPassed?: boolean;
  leaseExpiresAt?: number;
  lastHeartbeatAt?: number;
  attempt: number;
}

export interface RunnerPresence {
  runnerId: string;
  lastSeen: number;
  activeTasks: number;
  version?: string;
  hostName?: string;
}

export interface RunnerConfig {
  convexUrl: string;
  convexToken?: string;
  runnerId: string;
  hostName: string;
  version: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  repoRoot: string;
  worktreeRoot: string;
  baseBranch: string;
  piCommand: string;
  pushOnSuccess: boolean;
  pushRemote: string;
}
