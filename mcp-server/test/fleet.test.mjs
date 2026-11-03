// The extension sends JSON intact to the shared CLI, never through a shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetRequest, registerFleetTools } from '../build/fleet.js';

test('Fleet extension registers discovery and one common action tool', () => {
  const names=[]; registerFleetTools({registerTool(name){names.push(name)}});
  assert.deepEqual(names,['bridge_fleet_state','bridge_fleet']);
});
test('Fleet extension preserves argv and JSON without shell interpretation', async () => {
  const root=mkdtempSync(join(tmpdir(),'fleet extension ')), before=process.env.THE_FLEET_BIN;
  try {
    const bin=join(root,'fake fleet');
    writeFileSync(bin,'#!/usr/bin/env node\nlet body="";for await (const chunk of process.stdin) body+=chunk;console.log(JSON.stringify({argv:process.argv.slice(2),body:JSON.parse(body)}));\n',{mode:0o700});
    process.env.THE_FLEET_BIN=bin;
    const body={owner:'quotes " and newline\n; $(no-command)',cwd:'/some path'};
    const result=JSON.parse(await fleetRequest('POST','/v1/submit',body));
    assert.deepEqual(result.argv,['rpc','POST','/v1/submit','-']); assert.deepEqual(result.body,body);
  } finally { if(before===undefined) delete process.env.THE_FLEET_BIN;else process.env.THE_FLEET_BIN=before;rmSync(root,{recursive:true,force:true}); }
});
