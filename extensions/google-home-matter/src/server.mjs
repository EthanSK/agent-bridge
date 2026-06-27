// ============================================================================
// server.mjs — the virtual Matter device server.
//
// WHAT THIS DOES (the big picture):
//   "Hey Google, turn on Claude"
//     → Nest speaker → Google Home Matter controller (a hub-class controller
//       already in this home; the Mini's LAN shows 2 commissioned Matter nodes)
//     → THIS process's virtual Matter device's OnOff (or LevelControl) cluster
//       flips → our $Changed handler fires
//     → inject() (src/inject.mjs) → agent-bridge sendLocalMessage()
//     → inbox/claude-code/default/msg-*.json (atomic) → agent-bridge watcher
//     → <channel source="agent-bridge"> block pushed into the running Claude
//       Code session on this machine → the session reads the intent + acts.
//
// MATTER TOPOLOGY:
//   We expose ONE Matter "bridge" node (ServerNode) carrying an Aggregator
//   endpoint, and under it ONE BridgedNode child per device in devices.json.
//   A bridge is the right device type for "N logical devices behind one app"
//   and is exactly how Google expects a multi-device Matter accessory to look.
//   Each child is either an OnOffLightDevice (plain switch) or a
//   DimmableLightDevice (switch + 0-254 brightness) depending on `dimmable`.
//   We model them as LIGHTS (not plugs) because Google Home reliably exposes
//   on/off + brightness voice grammar for lights ("turn on X", "set X to 40%").
//
// COMMISSIONING LIFECYCLE (state machine):
//   1. First run with an EMPTY storage dir → node is UNCOMMISSIONED. matter.js
//      prints a manual pairing code (11-digit) + a QR/URL. State: "waiting to
//      be commissioned".
//   2. Ethan opens Google Home → Add device → Matter → enters the code. Google
//      commissions the node onto its fabric and writes fabric/ACL state into
//      our storage dir. State: COMMISSIONED.
//   3. Every subsequent start reads that storage dir → node comes up already
//      commissioned, advertises over mDNS (_matter._tcp), and is controllable.
//      NO pairing code is printed once commissioned (that's expected/correct).
//   The storage dir MUST be stable + persistent across restarts/reboots (we
//   point it at a fixed dir via the AGENT_BRIDGE_GHM_STORAGE env / default), or
//   the device would forget its commissioning and drop off Google Home.
// ============================================================================

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { Endpoint, ServerNode, Environment } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { DimmableLightDevice } from '@matter/main/devices/dimmable-light';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';

import { inject } from './inject.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load + parse devices.json ───────────────────────────────────────────────
// Config lives one dir up from src/. Comment keys (anything starting with "//")
// are ignored by consumers — they're just inline docs in the JSON.
function loadConfig() {
  const cfgPath = process.env.AGENT_BRIDGE_GHM_CONFIG
    || resolve(__dirname, '..', 'devices.json');
  if (!existsSync(cfgPath)) {
    throw new Error(`devices.json not found at ${cfgPath} (set AGENT_BRIDGE_GHM_CONFIG to override)`);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  if (!Array.isArray(cfg.devices) || cfg.devices.length === 0) {
    throw new Error(`devices.json has no devices[]`);
  }
  return { cfg, cfgPath };
}

// ── Persistent storage dir ──────────────────────────────────────────────────
// Matter commissioning/fabric state is written here. MUST survive restarts.
// Default to ~/.agent-bridge/google-home-matter/storage so it sits alongside
// agent-bridge's own state and is easy to back up. Override with the env var.
function storageLocation() {
  const dir = process.env.AGENT_BRIDGE_GHM_STORAGE
    || join(homedir(), '.agent-bridge', 'google-home-matter', 'storage');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Brightness helpers ──────────────────────────────────────────────────────
// Matter LevelControl currentLevel is 0-254. Google converts a spoken % to that
// scale itself. We surface BOTH the raw level and a 0-100% to the templates.
function levelToPct(level) {
  if (level == null) return 0;
  return Math.round((Number(level) / 254) * 100);
}

// Match a brightness % against a device's preset ranges (inclusive). Returns the
// preset label (e.g. "B") or "" if none/no presets configured. First match wins.
function matchPreset(device, pct) {
  const presets = device.presets;
  if (!presets || typeof presets !== 'object') return '';
  for (const [label, range] of Object.entries(presets)) {
    if (label.startsWith('//')) continue; // skip comment keys
    if (!Array.isArray(range) || range.length !== 2) continue;
    const [lo, hi] = range;
    if (pct >= lo && pct <= hi) return label;
  }
  return '';
}

// ── Template fill ───────────────────────────────────────────────────────────
// Substitute {name} {state} {brightness} {brightnessPct} {preset} into a
// template string from devices.json.
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return tpl
    .replaceAll('{name}', vars.name)
    .replaceAll('{state}', vars.state)
    .replaceAll('{brightness}', String(vars.brightness))
    .replaceAll('{brightnessPct}', String(vars.brightnessPct))
    .replaceAll('{preset}', vars.preset);
}

// ── Fire one injection ──────────────────────────────────────────────────────
// Called from the cluster $Changed handlers. Builds the message text from the
// device template + current state, then injects it. We DEBOUNCE per device:
// turning a dimmable light on often emits BOTH an onOff change AND a
// currentLevel change back-to-back, which would otherwise inject twice. A short
// per-device debounce window collapses them into one message describing the
// final state.
const debounceTimers = new Map(); // deviceName → timeout handle
const DEBOUNCE_MS = 250;

function fireInjection(device, target, ttlSeconds, getState) {
  const key = device.name;
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  debounceTimers.set(
    key,
    setTimeout(async () => {
      debounceTimers.delete(key);
      const { onOff, level } = getState(); // read the FINAL settled state
      const brightnessPct = levelToPct(level);
      const preset = onOff ? matchPreset(device, brightnessPct) : '';
      const tpl = onOff ? device.onTemplate : device.offTemplate;
      const content = fillTemplate(tpl, {
        name: device.name,
        state: onOff ? 'on' : 'off',
        brightness: level ?? 0,
        brightnessPct,
        preset,
      });
      // Empty template (e.g. offTemplate: "") = inject nothing for that edge.
      if (!content) {
        console.log(`[ghm] ${device.name} → ${onOff ? 'on' : 'off'}: no template, skipping inject`);
        return;
      }
      try {
        const id = await inject({ target, content, ttlSeconds });
        console.log(`[ghm] ${device.name} → ${onOff ? 'on' : 'off'} (bri ${brightnessPct}%${preset ? ` preset ${preset}` : ''}) injected ${id}`);
      } catch (err) {
        // Inject failure must NOT crash the Matter server — log + carry on so
        // the device keeps working and the next toggle can retry.
        console.error(`[ghm] inject FAILED for ${device.name}: ${err.message}`);
      }
    }, DEBOUNCE_MS),
  );
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const { cfg, cfgPath } = loadConfig();
  const target = cfg.target || 'claude-code/default';
  const ttlSeconds = cfg.ttlSeconds ?? 86400;

  console.log(`[ghm] config: ${cfgPath}`);
  console.log(`[ghm] inject target: ${target}`);
  console.log(`[ghm] devices: ${cfg.devices.map((d) => d.name).join(', ')}`);

  // Point matter.js at our persistent storage dir BEFORE creating the node.
  // The supported way is the environment variable "storage.path" — the
  // StorageService reads it when it lazily opens the filesystem driver. The
  // StorageService.location getter is read-only, so we MUST set the var (not
  // assign .location). This dir holds fabric/commissioning state and MUST be
  // stable across restarts or the device forgets it was paired.
  const storageDir = storageLocation();
  const environment = Environment.default;
  environment.vars.set('storage.path', storageDir);
  console.log(`[ghm] matter storage: ${storageDir}`);

  // The bridge ServerNode. uniqueId is stable (derived from a fixed string) so
  // the same node identity persists across restarts. passcode/discriminator are
  // the commissioning credentials matter.js prints as the pairing code; we pin
  // them so the code is STABLE across restarts (handy if Ethan needs to re-pair).
  const server = await ServerNode.create({
    id: 'agent-bridge-ghm',
    network: { port: Number(process.env.AGENT_BRIDGE_GHM_PORT || 5560) },
    commissioning: {
      // Pinned commissioning credentials → stable pairing code. Change these
      // (or set the env vars) if you ever want to rotate the code.
      passcode: Number(process.env.AGENT_BRIDGE_GHM_PASSCODE || 20240802),
      discriminator: Number(process.env.AGENT_BRIDGE_GHM_DISCRIMINATOR || 3842),
    },
    productDescription: {
      name: cfg.fabricLabel || 'agent-bridge-ghm',
      deviceType: AggregatorEndpoint.deviceType,
    },
    basicInformation: {
      vendorName: 'agent-bridge',
      vendorId: 0xfff1,        // test/dev vendor id range (0xFFF1-0xFFF4)
      productName: 'Google Home Bridge',
      productLabel: cfg.fabricLabel || 'agent-bridge-ghm',
      productId: 0x8001,
      serialNumber: 'agent-bridge-ghm-0001',
      uniqueId: 'agent-bridge-ghm-0001',
    },
  });

  // The Aggregator endpoint — the container all bridged devices hang off.
  const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
  await server.add(aggregator);

  // Build one bridged child endpoint per configured device.
  for (const device of cfg.devices) {
    const isDimmable = device.dimmable === true;
    // Compose the chosen light device type (OnOffLight, or DimmableLight which
    // adds the LevelControl/brightness cluster) WITH a
    // BridgedDeviceBasicInformation cluster. That bridged-info cluster is what
    // makes Google show this as a discrete, individually-named sub-device under
    // the aggregator (rather than one anonymous endpoint). This is the canonical
    // matter.js "bridge" composition — device-type `.with(bridgedInfoServer)`,
    // added directly to the Aggregator endpoint.
    const baseDevice = isDimmable ? DimmableLightDevice : OnOffLightDevice;
    const endpoint = new Endpoint(
      baseDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: device.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        bridgedDeviceBasicInformation: {
          nodeLabel: device.name,    // the name Google/voice uses
          productName: device.name,
          reachable: true,
        },
        // Start "off" so toggling on is a real state change Google can drive.
        onOff: { onOff: false },
      },
    );
    await aggregator.add(endpoint);

    // Reader for the device's CURRENT settled state (used by the debounce flush).
    const getState = () => ({
      onOff: endpoint.state.onOff.onOff,
      level: isDimmable ? endpoint.state.levelControl?.currentLevel : null,
    });

    // ── Subscribe to OnOff changes ──
    // onOff$Changed fires whenever the on/off attribute flips (from Google, the
    // app, or voice). We re-fire the (debounced) injection on every change.
    endpoint.events.onOff.onOff$Changed.on(() => {
      fireInjection(device, target, ttlSeconds, getState);
    });

    // ── Subscribe to LevelControl (brightness) changes, dimmable only ──
    // "Set Claude to 40%" arrives as a currentLevel change (~102/254). We fire
    // the same injection so the new brightness % + preset get encoded. The
    // debounce collapses the on+level burst on "turn on to X%".
    if (isDimmable && endpoint.events.levelControl?.currentLevel$Changed) {
      endpoint.events.levelControl.currentLevel$Changed.on(() => {
        // Only inject on level change while ON (a level change while off is just
        // Google pre-staging brightness; the on-event will carry it).
        if (endpoint.state.onOff.onOff) {
          fireInjection(device, target, ttlSeconds, getState);
        }
      });
    }
  }

  // Bring the node online. If uncommissioned, matter.js logs the pairing code
  // here. If already commissioned, it just starts advertising over mDNS.
  await server.start();

  // Print the pairing info explicitly so the LaunchAgent log captures it even
  // if matter.js's own log level is quiet. When already commissioned this block
  // is skipped (commissioned nodes have no open commissioning window by default).
  try {
    if (!server.lifecycle.isCommissioned) {
      const pairing = server.state.commissioning.pairingCodes;
      console.log('========================================================');
      console.log('[ghm] NODE IS UNCOMMISSIONED — pair it in Google Home:');
      console.log(`[ghm]   Manual pairing code: ${pairing.manualPairingCode}`);
      console.log(`[ghm]   QR code URL:         ${pairing.qrPairingCode}`);
      console.log('[ghm]   Google Home app → + Add → Matter-enabled device →');
      console.log('[ghm]   "Set up without QR code" → enter the manual code above.');
      console.log('========================================================');
    } else {
      console.log('[ghm] node already commissioned — advertising on the LAN. No pairing code needed.');
    }
  } catch (err) {
    console.error('[ghm] could not read pairing codes:', err.message);
  }

  console.log('[ghm] Matter server running. Ctrl-C to stop.');

  // Graceful shutdown so matter.js flushes storage cleanly (keeps commissioning).
  const shutdown = async () => {
    console.log('[ghm] shutting down…');
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ghm] fatal:', err);
  process.exit(1);
});
