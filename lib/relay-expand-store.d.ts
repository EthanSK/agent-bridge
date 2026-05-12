/**
 * TypeScript ambient declarations for the shared relay-expand-store.
 * The implementation lives in `relay-expand-store.js` (plain ESM JS); this
 * file exists so the `mcp-server/` TypeScript build can import it with
 * proper type checking.
 */

export interface RelayExpandBridgeMessage {
  id?: string | null;
  from?: string | null;
  to?: string | null;
  fromTarget?: string | null;
  target?: string | null;
  sourceAgentBridgeVersion?: string | null;
  agentBridgeVersion?: string | null;
  agent_bridge_version?: string | null;
  type?: string | null;
  content?: string | null;
  timestamp?: string | null;
  replyTo?: string | null;
  reply_to?: string | null;
  ttl?: unknown;
}

export interface RelayExpandMetadata {
  targetName?: string;
  replyVia?: string | string[];
  sourceAgentBridgeVersion?: string;
  destinationAgentBridgeVersion?: string;
  agentBridgeVersion?: string;
  version?: string;
}

export interface RelayExpandStoreOpts {
  storePath?: string;
  now?: Date | number;
  ttlMs?: number;
  maxEntries?: number;
  idSpace?: number;
}

export interface RelayExpandRecord {
  expandId: string;
  storedAt: string;
  storedAtMs: number;
  expiresAt: string;
  expiresAtMs: number;
  message: Required<Pick<RelayExpandBridgeMessage, 'content'>> & RelayExpandBridgeMessage;
  metadata: RelayExpandMetadata;
}

export const DEFAULT_RELAY_EXPAND_TTL_MS: number;
export const DEFAULT_RELAY_EXPAND_MAX_ENTRIES: number;
export const DEFAULT_RELAY_EXPAND_ID_SPACE: number;

export function defaultRelayExpandDir(): string;
export function defaultRelayExpandStorePath(): string;
export function normalizeExpandId(value: unknown): string;

export function storeRelayExpandMessage(
  msg: RelayExpandBridgeMessage | null | undefined,
  metadata?: RelayExpandMetadata,
  opts?: RelayExpandStoreOpts,
): RelayExpandRecord;

export function readRelayExpandEntry(
  expandId: string,
  opts?: RelayExpandStoreOpts,
): RelayExpandRecord | null;

export function formatRelayExpandEntry(
  entry: RelayExpandRecord | null | undefined,
): string;

export const __testing: {
  allocateExpandId: (
    store: { entries?: Array<{ expandId?: string }>; lastSeq?: number },
    opts?: { idSpace?: number },
  ) => { expandId: string; seq: number };
  pruneStore: (
    store: { entries?: unknown[]; lastSeq?: number },
    nowMs: number,
    opts?: { maxEntries?: number; idSpace?: number },
  ) => { version: number; lastSeq: number; updatedAt: string | null; entries: unknown[] };
  readStore: (storePath: string) => { version: number; lastSeq: number; entries: unknown[] };
  resolveIdSpace: (value: unknown) => number;
};
