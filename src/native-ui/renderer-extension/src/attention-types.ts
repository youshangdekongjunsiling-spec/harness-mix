import type { HostThreadId } from "@harnessmix/shared-contracts";

export type AttentionThreadStatus =
  | "running"
  | "waiting"
  | "completed"
  | "error"
  | "idle"
  | "interrupted"
  | "unknown";

export interface AttentionEvent {
  id: string;
  threadId: string;
  kind: "completed" | "waiting" | "error";
  at: number;
}

export interface AttentionGitInfo {
  branch?: string | undefined;
  sha?: string | undefined;
}

export interface AttentionWorkspace {
  mode?: string | undefined;
  root?: string | undefined;
  branch?: string | undefined;
  baseCommit?: string | undefined;
}

export interface AttentionActivity {
  cwd: string;
  observedAt: number;
  source: "command" | "worktree";
  itemId?: string | undefined;
}

export interface AttentionThread {
  id: HostThreadId | string;
  title: string;
  harnessId: string;
  cwd: string | null;
  originalCwd?: string | null | undefined;
  projectId: string | null;
  updatedAt: number | null;
  status: AttentionThreadStatus;
  turnId?: string | undefined;
  event?: AttentionEvent | undefined;
  gitInfo?: AttentionGitInfo | undefined;
  workspace?: AttentionWorkspace | undefined;
  /** Latest validated execution location. Contains no command or output data. */
  activity?: AttentionActivity | undefined;
  /** Presentation-only provenance; never sent to the Host. */
  source?: "native" | "harnessmix" | undefined;
  preview?: string | undefined;
}

export interface AttentionProject {
  id: string;
  name: string;
  rootPaths: string[];
}

export interface AttentionCommit {
  hash: string;
  parents: string[];
  subject: string;
  timestamp: number;
}

export interface AttentionRepository {
  id: string;
  root: string;
  paths: string[];
  available: boolean;
  reason?: "not-git" | "missing-path" | "permission-denied" | "timeout" | "git-error" | undefined;
  error?: string | undefined;
  defaultBranch: string | null;
  commits: AttentionCommit[];
  branches: Array<{ name: string; head: string; merged: boolean | null }>;
  worktrees: Array<{
    path: string;
    branch: string | null;
    head: string | null;
    dirty: number | null;
    detached: boolean;
  }>;
  truncated: boolean;
}

export interface AttentionData {
  version: 1;
  generatedAt: number;
  projects: AttentionProject[];
  threads: AttentionThread[];
  repositories: AttentionRepository[];
  partial: boolean;
  errors: string[];
  warnings: string[];
}

export const EMPTY_ATTENTION_DATA: AttentionData = {
  version: 1,
  generatedAt: 0,
  projects: [],
  threads: [],
  repositories: [],
  partial: false,
  errors: [],
  warnings: [],
};
