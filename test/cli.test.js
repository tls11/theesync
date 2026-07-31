import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFakeVolume, makeTempRoot, writeTree, exists, rmrf, listRelFiles } from './helpers.js';
import { resolveNoDelete, EXIT_OK, EXIT_USAGE, EXIT_RUNTIME } from '../src/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'theesync.js');

function runBin(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd || path.join(__dirname, '..'),
      env: { ...process.env, ...(opts.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('resolveNoDelete', () => {
  it('detects flag forms', () => {
    assert.equal(resolveNoDelete({ noDelete: true }), true);
    assert.equal(resolveNoDelete({ delete: false }), true);
    assert.equal(resolveNoDelete({}), false);
  });
});

describe('CLI integration', () => {
  const cleanups = [];
  after(async () => {
    for (const p of cleanups) await rmrf(p);
  });

  it('plan --json-lines emits NDJSON and writes nothing', async () => {
    const vol = await makeFakeVolume({ withMusic: true });
    const src = await makeTempRoot();
    cleanups.push(vol, src);
    await writeTree(src, { 'a/track.flac': 'x' });
    const dest = path.join(vol, 'Music');
    const before = await listRelFiles(vol);

    const r = await runBin([
      'plan', '-s', src, '-d', dest, '--json-lines',
    ]);
    assert.equal(r.code, EXIT_OK, r.stderr);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      const ev = JSON.parse(line);
      assert.ok(ev.type);
    }
    assert.deepEqual(await listRelFiles(vol), before);
  });

  it('one-shot sync then plan shows no adds', async () => {
    const vol = await makeFakeVolume({ withMusic: true });
    const src = await makeTempRoot();
    cleanups.push(vol, src);
    await writeTree(src, { 'Artist/album/t.flac': 'data' });
    const dest = path.join(vol, 'Music');

    const sync = await runBin(['-s', src, '-d', dest, '-v']);
    assert.equal(sync.code, EXIT_OK, sync.stderr + sync.stdout);
    assert.equal(await exists(path.join(dest, 'Artist/album/t.flac')), true);

    const plan = await runBin(['plan', '-s', src, '-d', dest, '--json-lines']);
    assert.equal(plan.code, EXIT_OK, plan.stderr);
    const planEv = plan.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'plan');
    assert.ok(planEv);
    assert.equal(planEv.add, 0);
    assert.equal(planEv.update, 0);
  });

  it('plan -o + apply -p', async () => {
    const vol = await makeFakeVolume({ withMusic: true });
    const src = await makeTempRoot();
    const tmp = await makeTempRoot();
    cleanups.push(vol, src, tmp);
    await writeTree(src, { 'B/book.epub': 'e' });
    // use Music for this test
    const dest = path.join(vol, 'Music');
    const planFile = path.join(tmp, 'p.json');

    const p = await runBin(['plan', '-s', src, '-d', dest, '-o', planFile]);
    assert.equal(p.code, EXIT_OK, p.stderr);
    assert.equal(await exists(planFile), true);
    assert.equal(await exists(path.join(dest, 'B/book.epub')), false);

    const a = await runBin(['apply', '-p', planFile, '-v']);
    assert.equal(a.code, EXIT_OK, a.stderr);
    assert.equal(await exists(path.join(dest, 'B/book.epub')), true);
  });

  it('refuses bare volume dest (usage/runtime)', async () => {
    const vol = await makeFakeVolume();
    const src = await makeTempRoot();
    cleanups.push(vol, src);
    await writeTree(src, { 'x.txt': '1' });
    const r = await runBin(['plan', '-s', src, '-d', vol]);
    assert.notEqual(r.code, EXIT_OK);
    assert.match(r.stderr, /Safety|allowlist|category/i);
  });

  it('missing args → usage', async () => {
    const r = await runBin(['plan']);
    assert.equal(r.code, EXIT_USAGE);
  });

  it('--category sugar', async () => {
    const vol = await makeFakeVolume();
    const src = await makeTempRoot();
    cleanups.push(vol, src);
    await writeTree(src, { 't.flac': '1' });
    const r = await runBin(['-s', src, '-d', vol, '--category', 'Music']);
    assert.equal(r.code, EXIT_OK, r.stderr);
    assert.equal(await exists(path.join(vol, 'Music', 't.flac')), true);
  });

  it('--dry-run does not write', async () => {
    const vol = await makeFakeVolume({ withMusic: true });
    const src = await makeTempRoot();
    cleanups.push(vol, src);
    await writeTree(src, { 't.flac': '1' });
    const dest = path.join(vol, 'Music');
    const before = await listRelFiles(vol);
    const r = await runBin(['-s', src, '-d', dest, '--dry-run']);
    assert.equal(r.code, EXIT_OK, r.stderr);
    assert.deepEqual(await listRelFiles(vol), before);
  });

  it('--no-delete via CLI omits deletes', async () => {
    const vol = await makeFakeVolume({ withMusic: true });
    const src = await makeTempRoot();
    cleanups.push(vol, src);
    await writeTree(src, { 'keep.flac': 'k' });
    const dest = path.join(vol, 'Music');
    // seed dest with orphan
    await writeTree(dest, { 'orphan.flac': 'gone' });
    const r = await runBin([
      'plan', '-s', src, '-d', dest, '--no-delete', '--json-lines',
    ]);
    assert.equal(r.code, EXIT_OK, r.stderr);
    const planEv = r.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'plan');
    assert.ok(planEv);
    assert.equal(planEv.delete, 0);
    assert.equal(planEv.schemaVersion, 1);
    // orphan still present (plan only, and no delete in plan)
    assert.equal(await exists(path.join(dest, 'orphan.flac')), true);
  });

  it('flag-only --dry-run is usage error (exit 2)', async () => {
    const r = await runBin(['--dry-run']);
    assert.equal(r.code, EXIT_USAGE, r.stderr + r.stdout);
  });

  it('safety failure with --json-lines emits done ok:false', async () => {
    const vol = await makeFakeVolume();
    const src = await makeTempRoot();
    cleanups.push(vol, src);
    await writeTree(src, { 'x.txt': '1' });
    const r = await runBin(['plan', '-s', src, '-d', vol, '--json-lines']);
    assert.notEqual(r.code, EXIT_OK);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'error'));
    assert.ok(events.some((e) => e.type === 'done' && e.ok === false));
    assert.ok(events.every((e) => e.schemaVersion === 1));
  });

  it('categories --json prints allowlist', async () => {
    const r = await runBin(['categories', '--json']);
    assert.equal(r.code, EXIT_OK, r.stderr);
    const list = JSON.parse(r.stdout.trim());
    assert.ok(Array.isArray(list));
    assert.ok(list.includes('Music'));
    assert.ok(list.includes('Books'));
  });
});
