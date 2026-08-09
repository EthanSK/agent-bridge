/** Hand-written declarations for service.js (see bindings.d.ts note). */

export declare const POLL_MS: number;
export declare function readLease(env?: NodeJS.ProcessEnv): {
  pid?: number;
  token?: string;
  version?: string;
  startedAt?: number;
  updatedAt?: number;
} | null;
export declare function pidAlive(pid: number): boolean;
export declare function leaseFresh(lease: ReturnType<typeof readLease>, nowMs?: number): boolean;
export declare function acquireLease(env?: NodeJS.ProcessEnv): { pid: number; token: string } | null;
export declare function heartbeatLease(lease: { token: string }, env?: NodeJS.ProcessEnv): boolean;
export declare function releaseLease(lease: { token: string } | null, env?: NodeJS.ProcessEnv): void;
export declare function ensureService(opts?: {
  env?: NodeJS.ProcessEnv;
  spawnImpl?: unknown;
  logEvent?: unknown;
}): Promise<{ spawned: boolean; pid: number | null; skipped?: boolean; staleVersion?: boolean }>;
export declare function createService(opts?: Record<string, unknown>): {
  tick: () => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
  statusSnapshot: () => Record<string, unknown>;
};
export declare function runService(opts?: Record<string, unknown>): Promise<{ started: boolean }>;
