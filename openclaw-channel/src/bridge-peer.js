/**
 * Agent-bridge peer ids used inside OpenClaw sessions.
 *
 * The transport destination is not just a machine name. A reply also needs the
 * sender's target id (`fromTarget`), e.g. `claude-code` or `openclaw/default`.
 * Persist both inside the OpenClaw peer id so normal outbound replies still
 * know where to go after a gateway restart and so different return targets on
 * the same machine do not share one session.
 */

const PREFIX = "bridge-v1.";

export function encodeBridgePeerId(fromMachine, returnTarget) {
  const machine = typeof fromMachine === "string" ? fromMachine.trim() : "";
  const target = typeof returnTarget === "string" ? returnTarget.trim() : "";
  if (!machine) {
    throw new Error("encodeBridgePeerId requires a sender machine name");
  }
  if (!target) {
    throw new Error("encodeBridgePeerId requires a sender return target");
  }
  const payload = Buffer.from(
    JSON.stringify({ machine, target }),
    "utf8",
  ).toString("base64url");
  return `${PREFIX}${payload}`;
}

export function decodeBridgePeerId(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  if (!raw.startsWith(PREFIX)) {
    return {
      encoded: false,
      fromMachine: raw,
      returnTarget: null,
    };
  }

  try {
    const decoded = Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    const fromMachine =
      typeof parsed?.machine === "string" ? parsed.machine.trim() : "";
    const returnTarget =
      typeof parsed?.target === "string" ? parsed.target.trim() : "";
    if (!fromMachine) return null;
    return {
      encoded: true,
      fromMachine,
      returnTarget: returnTarget || null,
    };
  } catch {
    return null;
  }
}

export const __testing = {
  PREFIX,
};
