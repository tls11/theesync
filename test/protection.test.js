/**
 * Hard guarantees: no plan/apply path can touch Rockbox or protected root.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { applyPlan } from '../src/sync.js';
import { createEmitter } from '../src/events.js';
import { assertDeletablePath, SafetyError } from '../src/safety.js';
import { makeFakeVolume, makeTempRoot, writeTree, exists, rmrf } from './helpers.js';

function quietEmit() {
  return createEmitter({ write: () => {}, writeErr: () => {} });
}

describe('root protection hard guarantees', () => {
  it('malicious plan actions targeting .rockbox / update.upt are rejected', async () => {
    const vol = await makeFakeVolume({ withMusic: true });
    const src = await makeTempRoot();
    await writeTree(src, { 'ok.flac': 'x' });
    const dest = path.join(vol, 'Music');

    const evilPlan = {
      version: 1,
      createdAt: new Date().toISOString(),
      roots: {
        source: src,
        dest,
        volumeRoot: vol,
        category: 'Music',
      },
      options: { noDelete: false, checksum: false, mtimeToleranceMs: 3000 },
      counts: { add: 0, update: 0, delete: 2, addFiles: 0, addDirs: 0, deleteFiles: 2, deleteDirs: 0, skippedUnchanged: 0, skippedWalk: 0 },
      actions: [
        // These paths resolve outside Music if we used ../ — plan validation rejects ..
        { type: 'delete', path: '../.rockbox/config.cfg', kind: 'file' },
      ],
    };

    await assert.rejects(() => applyPlan(evilPlan, { emit: quietEmit() }), /Unsafe action path/);

    // Craft absolute-looking relative that still stays "under" dest naming but wrong top segment
    // via path join tricks is blocked by assertDeletablePath
    assert.throws(
      () => assertDeletablePath(path.join(vol, '.rockbox', 'config.cfg'), dest),
      SafetyError,
    );
    assert.throws(
      () => assertDeletablePath(path.join(vol, 'update.upt'), dest),
      SafetyError,
    );

    // After failed evil plan attempt, markers intact
    assert.equal(await exists(path.join(vol, '.rockbox')), true);
    assert.equal(await exists(path.join(vol, 'update.upt')), true);
    assert.equal(
      await fs.promises.readFile(path.join(vol, 'update.upt'), 'utf8'),
      'firmware',
    );

    await rmrf(vol);
    await rmrf(src);
  });

  it('path traversal in action is rejected at validatePlan', async () => {
    const vol = await makeFakeVolume({ withMusic: true });
    const src = await makeTempRoot();
    await writeTree(src, { 'ok.flac': 'x' });
    const dest = path.join(vol, 'Music');

    const plan = {
      version: 1,
      createdAt: new Date().toISOString(),
      roots: { source: src, dest, volumeRoot: vol, category: 'Music' },
      options: { noDelete: false, checksum: false, mtimeToleranceMs: 3000 },
      counts: {},
      actions: [{ type: 'delete', path: '../../etc/passwd', kind: 'file' }],
    };

    await assert.rejects(() => applyPlan(plan, { emit: quietEmit() }), /Unsafe action path/);
    await rmrf(vol);
    await rmrf(src);
  });
});
