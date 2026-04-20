/**
 * Tiny logger wrapper used across the v2 channel plugin.
 *
 * Accepts any object exposing {debug, info, warn, error} (the OpenClaw plugin
 * api.logger shape) and falls back to console when a sink isn't provided.
 */
const LEVELS = ["debug", "info", "warn", "error"];

function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function makeLogger(base) {
  const sink = base ?? console;
  const out = {};
  for (const level of LEVELS) {
    out[level] = (...args) => {
      try {
        // OpenClaw's logger sink only renders the first argument and drops the rest,
        // so we have to concatenate the tag INTO the message string rather than
        // passing it as a separate positional arg. Otherwise plugin log bodies show
        // up as just "[agent-bridge/v2]" in gateway.log with no content.
        const body = args
          .map((a) => (typeof a === "string" ? a : safeStringify(a)))
          .join(" ");
        (sink[level] ?? sink.info ?? console.log).call(sink, `[agent-bridge/v2] ${body}`);
      } catch {
        /* swallow */
      }
    };
  }
  return out;
}
