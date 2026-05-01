import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local active agents are mirrored as metadata lock files and removed on end", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  process.env.AGENT_BRIDGE_MACHINE_NAME = "Mini";

  try {
    const core = await import(`../core.mjs?locktest=${Date.now()}`);
    const state = structuredClone(core.EMPTY_STATE);
    const config = { ...core.DEFAULT_CONFIG, activeLockTtlSeconds: 1800 };

    core.applyControlEvent({
      state,
      config,
      now: 1_000,
      payload: {
        kind: "agent.start",
        eventId: "evt-start",
        machine: "Mini",
        sourceId: "openclaw-subagents",
        harness: "openclaw",
        agentId: "subagent-1",
        label: "test subagent",
      },
    });

    const filesAfterStart = readdirSync(core.CHIME_ACTIVE_DIR).filter((file) => file.endsWith(".json"));
    assert.equal(filesAfterStart.length, 1);
    const lock = JSON.parse(readFileSync(join(core.CHIME_ACTIVE_DIR, filesAfterStart[0]), "utf8"));
    assert.equal(lock.machine, "Mini");
    assert.equal(lock.sourceId, "openclaw-subagents");
    assert.equal(lock.harness, "openclaw");
    assert.equal(lock.agentId, "subagent-1");
    assert.equal(lock.label, "test subagent");
    assert.equal(lock.playbackHost, "Mini");
    assert.equal(lock.expiresAt, 1_000 + 1_800_000);

    const end = core.applyControlEvent({
      state,
      config,
      now: 2_000,
      payload: {
        kind: "agent.end",
        eventId: "evt-end",
        machine: "Mini",
        sourceId: "openclaw-subagents",
        harness: "openclaw",
        agentId: "subagent-1",
      },
    });
    assert.equal(end.perAgent, true);
    assert.equal(readdirSync(core.CHIME_ACTIVE_DIR).filter((file) => file.endsWith(".json")).length, 0);
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AGENT_BRIDGE_MACHINE_NAME;
  }
});
