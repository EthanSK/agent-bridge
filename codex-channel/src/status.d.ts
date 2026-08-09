/**
 * Hand-written declarations for status.js (see bindings.d.ts note).
 */

export interface CodexStatusSnapshot {
  channelVersion: string;
  service: {
    running: boolean;
    pid: number | null;
    leaseVersion: string | null;
    leasePath: string;
    staleLease: boolean;
  };
  bindings: Array<{
    alias: string;
    target: string;
    threadId: string;
    enabled: boolean;
    cwd: string | null;
    policy: import('./bindings.js').CodexBindingPolicy;
    pendingInbox: number;
    staged: number;
    rolloutFound: boolean;
    rolloutMtime: string | null;
    updatedAt: string;
  }>;
  unboundAliasDirs: Array<{ alias: string; pending: number }>;
  deadLetterCount: number;
}

export interface CodexDoctorResult {
  snapshot: CodexStatusSnapshot;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export declare function buildStatusSnapshot(opts?: { env?: NodeJS.ProcessEnv }): CodexStatusSnapshot;
export declare function formatStatus(snapshot: CodexStatusSnapshot): string;
export declare function runDoctor(opts?: { env?: NodeJS.ProcessEnv }): CodexDoctorResult;
export declare function formatDoctor(result: CodexDoctorResult): string;
