/**
 * Tiny logger wrapper used across the v2 channel plugin.
 *
 * Accepts any object exposing {debug, info, warn, error} (the OpenClaw plugin
 * api.logger shape) and falls back to console when a sink isn't provided.
 */
const LEVELS = ["debug", "info", "warn", "error"];

export function makeLogger(base) {
  const sink = base ?? console;
  const out = {};
  for (const level of LEVELS) {
    out[level] = (...args) => {
      try {
        (sink[level] ?? sink.info ?? console.log).call(sink, "[agent-bridge/v2]", ...args);
      } catch {
        /* swallow */
      }
    };
  }
  return out;
}
