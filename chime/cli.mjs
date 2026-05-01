#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  BUILTIN_SOUNDS,
  EMPTY_STATE,
  ensureChimeDirs,
  loadChimeConfig,
  playSound,
  saveChimeState,
  statusSnapshot,
  updateChimeConfig,
} from "./core.mjs";
import { emitLifecycleEvent } from "./emitter.mjs";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function runIdFromClaudePayload(payload, hookKind) {
  if (!payload || typeof payload !== "object") {
    return { id: `claude-${hookKind}-${Date.now()}`, label: hookKind };
  }
  const id = payload.subagent_id
    || payload.subagent_session_id
    || payload.session_id
    || payload.transcript_path
    || payload.cwd
    || `claude-${hookKind}-${Date.now()}`;
  const label = payload.subagent_type
    || payload.tool_name
    || payload.task
    || hookKind;
  return { id: String(id), label: String(label) };
}

function emitLifecycle(kind, args) {
  ensureChimeDirs();
  const { positional, flags } = parseArgs(args);
  let agentId = positional[0];
  let sourceId = flags.source || "claude-code";
  let harness = flags.harness || "claude-code";
  let label = flags.label || null;

  if (flags["from-claude-stop"]) {
    const payload = readStdinJson();
    const derived = runIdFromClaudePayload(payload, "stop");
    agentId = derived.id;
    sourceId = "claude-code-parent";
    harness = "claude-code";
    label = derived.label;
  } else if (flags["from-claude-subagent"]) {
    const payload = readStdinJson();
    const derived = runIdFromClaudePayload(payload, "subagent_stop");
    agentId = derived.id;
    sourceId = "claude-code-subagents";
    harness = "claude-code";
    label = derived.label;
  } else if (flags["from-claude-userprompt"]) {
    const payload = readStdinJson();
    const derived = runIdFromClaudePayload(payload, "start");
    agentId = derived.id;
    sourceId = "claude-code-parent";
    harness = "claude-code";
    label = derived.label;
  } else if (flags["from-claude-subagent-start"]) {
    const payload = readStdinJson();
    const derived = runIdFromClaudePayload(payload, "subagent_start");
    agentId = derived.id;
    sourceId = "claude-code-subagents";
    harness = "claude-code";
    label = derived.label;
  }

  if (!agentId) die(`agent-bridge chime ${kind} <agent_id> required`);
  emitLifecycleEvent({
    kind: kind === "start" ? "agent.start" : "agent.end",
    sourceId,
    harness,
    agentId: String(agentId),
    label,
  });
}

function cmdStatus() {
  process.stdout.write(`${JSON.stringify(statusSnapshot(), null, 2)}\n`);
}

function cmdReset() {
  saveChimeState(structuredClone(EMPTY_STATE));
  process.stdout.write(`${JSON.stringify({ ok: true }, null, 2)}\n`);
}

function cmdTest(args) {
  const which = args[0];
  const cfg = loadChimeConfig();
  if (which === "per-agent" || which === "per_agent") {
    playSound(cfg.perAgentSound, cfg.volume);
    process.stdout.write(`Played per-agent: ${cfg.perAgentSound}\n`);
    return;
  }
  if (which === "all-complete" || which === "all_complete") {
    playSound(cfg.allCompleteSound, cfg.volume);
    process.stdout.write(`Played all-complete: ${cfg.allCompleteSound}\n`);
    return;
  }
  die("agent-bridge chime test <per-agent|all-complete>");
}

function cmdConfig(args) {
  const [sub, key, ...rest] = args;
  if (!sub || sub === "get") {
    process.stdout.write(`${JSON.stringify(loadChimeConfig(), null, 2)}\n`);
    return;
  }
  if (sub !== "set" || !key) die("agent-bridge chime config set <key> <value>");
  let value = rest.join(" ");
  if (key === "enabled") value = value === "true" || value === "1";
  if (["volume"].includes(key)) value = Number(value);
  if (["stalePeerSeconds", "activeLockTtlSeconds", "heartbeatSeconds", "allCompleteCooldownSeconds", "historyLimit"].includes(key)) value = Number(value);
  if (["perAgentSound", "allCompleteSound"].includes(key) && !value.startsWith("/") && !value.startsWith("~") && !BUILTIN_SOUNDS.includes(value)) {
    die(`Unknown sound "${value}". Try one of: ${BUILTIN_SOUNDS.join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify(updateChimeConfig({ [key]: value }), null, 2)}\n`);
}

function help() {
  process.stdout.write(`agent-bridge chime

Usage:
  agent-bridge chime start <agent_id> [--source <id>] [--harness <name>] [--label <text>]
  agent-bridge chime end   <agent_id> [--source <id>] [--harness <name>] [--label <text>]
  agent-bridge chime start --from-claude-userprompt
  agent-bridge chime start --from-claude-subagent-start
  agent-bridge chime end   --from-claude-stop
  agent-bridge chime end   --from-claude-subagent
  agent-bridge chime status
  agent-bridge chime config get
  agent-bridge chime config set <key> <value>
  agent-bridge chime test <per-agent|all-complete>
  agent-bridge chime reset
`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "start":
    emitLifecycle("start", rest);
    break;
  case "end":
    emitLifecycle("end", rest);
    break;
  case "status":
    cmdStatus();
    break;
  case "config":
    cmdConfig(rest);
    break;
  case "test":
    cmdTest(rest);
    break;
  case "reset":
    cmdReset();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    die(`Unknown chime command: ${cmd}`);
}
