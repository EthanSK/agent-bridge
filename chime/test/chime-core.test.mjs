import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  EMPTY_STATE,
  applyControlEvent,
  applySnapshotEvent,
  evaluateFleetState,
  expireChimeState,
} from "../core.mjs";

function freshState() {
  return structuredClone(EMPTY_STATE);
}

test("local control events create snapshots and trigger a zero transition once", () => {
  const state = freshState();
  const config = { ...DEFAULT_CONFIG, allCompleteCooldownSeconds: 1 };
  const now = 1_000;

  const start = applyControlEvent({
    state,
    config,
    now,
    payload: {
      kind: "agent.start",
      eventId: "evt-1",
      machine: "Mini",
      sourceId: "claude-code-subagents",
      harness: "claude-code",
      agentId: "sub-1",
    },
  });
  assert.equal(start.changed, true);
  assert.equal(start.perAgent, false);

  const mid = evaluateFleetState({ state, config, now: now + 1, localMachine: "Mini" });
  assert.equal(mid.fleetActiveCount, 1);
  assert.equal(mid.allCompleteTransition, false);

  const end = applyControlEvent({
    state,
    config,
    now: now + 2_000,
    payload: {
      kind: "agent.end",
      eventId: "evt-2",
      machine: "Mini",
      sourceId: "claude-code-subagents",
      harness: "claude-code",
      agentId: "sub-1",
    },
  });
  assert.equal(end.changed, true);
  assert.equal(end.perAgent, true);

  const done = evaluateFleetState({ state, config, now: now + 2_001, localMachine: "Mini" });
  assert.equal(done.fleetActiveCount, 0);
  assert.equal(done.allCompleteTransition, true);

  const repeat = evaluateFleetState({ state, config, now: now + 2_100, localMachine: "Mini" });
  assert.equal(repeat.allCompleteTransition, false);
});

test("remote stale active peers block all-complete until refreshed", () => {
  const state = freshState();
  const config = { ...DEFAULT_CONFIG, stalePeerSeconds: 30 };
  const base = 10_000;

  applyControlEvent({
    state,
    config,
    now: base,
    payload: {
      kind: "agent.start",
      eventId: "local-start",
      machine: "Mini",
      sourceId: "claude-code-parent",
      harness: "claude-code",
      agentId: "parent-1",
    },
  });
  applySnapshotEvent({
    state,
    config,
    now: base + 1,
    localMachine: "Mini",
    payload: {
      kind: "agent.snapshot",
      machine: "Laptop",
      sourceId: "openclaw-subagents",
      harness: "openclaw",
      seq: 1,
      updatedAt: base + 1,
      activeAgents: [{ agentId: "oc-1", harness: "openclaw", startedAt: base + 1 }],
    },
  });
  applyControlEvent({
    state,
    config,
    now: base + 2,
    payload: {
      kind: "agent.end",
      eventId: "local-end",
      machine: "Mini",
      sourceId: "claude-code-parent",
      harness: "claude-code",
      agentId: "parent-1",
    },
  });

  const stale = evaluateFleetState({ state, config, now: base + 31_500, localMachine: "Mini" });
  assert.equal(stale.fleetActiveCount, 1);
  assert.equal(stale.allCompleteTransition, false);
  assert.equal(stale.staleBlocking.length, 1);

  applySnapshotEvent({
    state,
    config,
    now: base + 32_000,
    localMachine: "Mini",
    payload: {
      kind: "agent.snapshot",
      machine: "Laptop",
      sourceId: "openclaw-subagents",
      harness: "openclaw",
      seq: 2,
      updatedAt: base + 32_000,
      activeAgents: [],
    },
  });

  const refreshed = evaluateFleetState({ state, config, now: base + 32_001, localMachine: "Mini" });
  assert.equal(refreshed.fleetActiveCount, 0);
  assert.equal(refreshed.allCompleteTransition, true);
});

test("active locks expire after ttl so stale agents cannot block forever", () => {
  const state = freshState();
  const config = { ...DEFAULT_CONFIG, activeLockTtlSeconds: 1800, stalePeerSeconds: 30 };
  const base = 100_000;

  applyControlEvent({
    state,
    config,
    now: base,
    payload: {
      kind: "agent.start",
      eventId: "local-start",
      machine: "Mini",
      sourceId: "claude-code-parent",
      harness: "claude-code",
      agentId: "parent-1",
    },
  });
  applySnapshotEvent({
    state,
    config,
    now: base + 1,
    localMachine: "Mini",
    payload: {
      kind: "agent.snapshot",
      machine: "Laptop",
      sourceId: "openclaw-subagents",
      harness: "openclaw",
      seq: 1,
      updatedAt: base + 1,
      activeAgents: [{ agentId: "remote-1", harness: "openclaw", startedAt: base + 1 }],
    },
  });
  applyControlEvent({
    state,
    config,
    now: base + 2,
    payload: {
      kind: "agent.end",
      eventId: "local-end",
      machine: "Mini",
      sourceId: "claude-code-parent",
      harness: "claude-code",
      agentId: "parent-1",
    },
  });

  const beforeTtl = evaluateFleetState({ state, config, now: base + 31_000, localMachine: "Mini" });
  assert.equal(beforeTtl.fleetActiveCount, 1);
  assert.equal(beforeTtl.staleBlocking.length, 1);

  const expired = expireChimeState({ state, config, now: base + 1_801_000, localMachine: "Mini" });
  assert.equal(expired.changed, true);
  assert.equal(state.history.at(-1).kind, "agent.expired");

  const afterTtl = evaluateFleetState({ state, config, now: base + 1_801_001, localMachine: "Mini" });
  assert.equal(afterTtl.fleetActiveCount, 0);
  assert.equal(afterTtl.expiredSources.length, 0);
  assert.equal(afterTtl.allCompleteTransition, true);
});
