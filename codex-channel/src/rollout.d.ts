/** Hand-written declarations for rollout.js (see bindings.d.ts note). */

export declare function findRolloutForThread(
  threadId: string,
  opts?: { env?: NodeJS.ProcessEnv },
): { path: string; mtimeMs: number } | null;
export declare function rolloutMtimeMs(path: string): number | null;
