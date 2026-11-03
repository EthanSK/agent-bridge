// The Fleet extension is a thin client. Scheduling, state and ownership live
// in the one per-user The Fleet service, shared with CLI and other apps.
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function fleetRequest(method: string, path: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['rpc', method, path, ...(body === undefined ? [] : ['-'])];
    const child = spawn(process.env.THE_FLEET_BIN || 'the-fleet', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('The Fleet request timed out.')); }, 130_000);
    const collect = (chunk: Buffer, error: boolean) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { child.kill('SIGTERM'); reject(new Error('The Fleet response exceeded 4 MiB.')); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
    child.on('error', (error) => { clearTimeout(timeout); reject(new Error(`The Fleet is unavailable: ${error.message}. Install it or set THE_FLEET_BIN.`)); });
    child.on('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(stdout); else reject(new Error(stderr.trim() || `The Fleet exited ${code}`)); });
    child.stdin.on('error', () => {});
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function registerFleetTools(server: McpServer): void {
  const result = async (method: string, path: string, body?: unknown) => {
    try { return { content: [{ type: 'text' as const, text: await fleetRequest(method, path, body) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
  };
  server.registerTool('bridge_fleet_state', {
    title: 'The Fleet state',
    description: 'Ask the shared The Fleet coordinator about worker availability, load, memory, active processes, job history and reservations from all apps. Observations include timestamps. No job is started.',
    inputSchema: { fresh: z.boolean().optional() },
  }, async ({ fresh }) => result('GET', `/v1/state${fresh ? '?fresh=1' : ''}`));
  server.registerTool('bridge_fleet', {
    title: 'The Fleet',
    description: 'Use the shared coordinator. submit starts a one-time job without registration; command invokes an existing profile; operation polls its output and keeps it alive (poll within 75 seconds); cancel stops it. reserve returns a worker connection for your own SSH; keep its token, renew while working, stop your processes then release. Expired reservations remain blocked until verified release. See The Fleet README for JSON request fields.',
    inputSchema: {
      action: z.enum(['submit', 'command', 'operation', 'cancel', 'reserve', 'renew', 'release', 'recover']),
      payload: z.record(z.unknown()).optional(),
      operationId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
  }, async ({ action, payload, operationId, offset }) => {
    if (action === 'operation' || action === 'cancel') {
      if (!operationId) return { isError: true, content: [{ type: 'text' as const, text: 'operationId is required.' }] };
      return action === 'operation' ? result('GET', `/v1/operations/${operationId}?offset=${offset ?? 0}`) : result('POST', `/v1/operations/${operationId}/cancel`, {});
    }
    const paths = { submit: 'submit', command: 'command', reserve: 'reservations', renew: 'renew', release: 'release', recover: 'recover' };
    return result('POST', `/v1/${paths[action]}`, payload ?? {});
  });
}
