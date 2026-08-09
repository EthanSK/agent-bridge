/**
 * Hand-written declarations for bindings.js so the TypeScript mcp-server can
 * import the canonical binding registry implementation (same pattern as
 * lib/relay-expand-store.d.ts). Keep in sync with bindings.js.
 */

export interface CodexBindingPolicy {
  steering: boolean;
  ownershipGuard: boolean;
  /** Supported safe subset of Codex 0.145 policies ("granular" needs per-rule config this surface does not expose). */
  approvalPolicy: 'never' | 'on-request' | 'untrusted';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  turnTimeoutMs: number | null;
}

export interface CodexBinding {
  alias: string;
  threadId: string;
  cwd: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  boundBy: string;
  policy: CodexBindingPolicy;
}

export interface CodexBindingRegistry {
  version: number;
  bindings: Record<string, CodexBinding>;
}

export declare const REGISTRY_VERSION: number;
export declare const SANDBOX_MODES: readonly string[];
export declare const APPROVAL_POLICIES: readonly string[];
export declare const DEFAULT_POLICY: Readonly<CodexBindingPolicy>;

export declare function isValidAlias(alias: unknown): boolean;
export declare function isValidThreadId(threadId: unknown): boolean;
export declare function normalizeThreadId(threadId: string): string;
export declare function loadRegistry(opts?: { env?: NodeJS.ProcessEnv }): {
  registry: CodexBindingRegistry;
  corruptMovedTo: string | null;
};
export declare function saveRegistry(registry: CodexBindingRegistry, opts?: { env?: NodeJS.ProcessEnv }): void;
export declare function bindAlias(params: {
  alias: string;
  threadId: string;
  cwd?: string | null;
  boundBy?: string;
  policy?: Partial<CodexBindingPolicy>;
  rebind?: boolean;
  allowSharedThread?: boolean;
  env?: NodeJS.ProcessEnv;
}): { binding: CodexBinding; replaced: CodexBinding | null };
export declare function unbindAlias(alias: string, opts?: { env?: NodeJS.ProcessEnv }): CodexBinding | null;
export declare function setBindingEnabled(alias: string, enabled: boolean, opts?: { env?: NodeJS.ProcessEnv }): CodexBinding | null;
export declare function getBinding(alias: string, opts?: { env?: NodeJS.ProcessEnv }): CodexBinding | null;
export declare function listBindings(opts?: { env?: NodeJS.ProcessEnv }): CodexBinding[];
export declare function listEnabledBindings(opts?: { env?: NodeJS.ProcessEnv }): CodexBinding[];
export declare function codexTargetForAlias(alias: string): string;
