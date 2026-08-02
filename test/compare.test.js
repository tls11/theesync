import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { buildActions, compareActionsForApply, countActions, hashFile } from '../src/compare.js';
import { makeTempRoot, writeTree, rmrf } from './helpers.js';

function entry(root, rel, size, mtimeMs) {
  return {
    rel,
    abs: path.join(root, ...rel.split('/')),
    size,
    mtimeMs,
    isDir: false,
  };
}

describe('buildActions', () => {
  it('classifies add/update/delete and sorts safely', async () => {
    const src = await makeTempRoot();
    const dst = await makeTempRoot();
    await writeTree(src, {
      'a/b/f.txt': 'hello',
      'a/c.txt': 'c',
    });
    await writeTree(dst, {
      'a/c.txt': 'old', // size may differ
      'orphan.txt': 'x',
      'a/gone-dir/x.txt': 'y',
    });

    const srcFiles = new Map([
      ['a/b/f.txt', entry(src, 'a/b/f.txt', 5, 1000)],
      ['a/c.txt', entry(src, 'a/c.txt', 1, 1000)],
    ]);
    const destFiles = new Map([
      ['a/c.txt', entry(dst, 'a/c.txt', 3, 1000)],
      ['orphan.txt', entry(dst, 'orphan.txt', 1, 1000)],
      ['a/gone-dir/x.txt', entry(dst, 'a/gone-dir/x.txt', 1, 1000)],
    ]);
    const srcDirs = new Map([
      ['a', { rel: 'a', abs: path.join(src, 'a'), size: 0, mtimeMs: 0, isDir: true }],
      ['a/b', { rel: 'a/b', abs: path.join(src, 'a', 'b'), size: 0, mtimeMs: 0, isDir: true }],
    ]);
    const destDirs = new Map([
      ['a', { rel: 'a', abs: path.join(dst, 'a'), size: 0, mtimeMs: 0, isDir: true }],
      ['a/gone-dir', { rel: 'a/gone-dir', abs: path.join(dst, 'a', 'gone-dir'), size: 0, mtimeMs: 0, isDir: true }],
    ]);

    const { actions } = await buildActions(srcFiles, destFiles, srcDirs, destDirs, {});
    const types = actions.map((a) => `${a.type}:${a.kind}:${a.path}`);
    assert.ok(types.includes('add:dir:a/b'));
    assert.ok(types.includes('add:file:a/b/f.txt'));
    assert.ok(types.some((t) => t.startsWith('update:file:a/c.txt')));
    assert.ok(types.includes('delete:file:orphan.txt'));
    assert.ok(types.includes('delete:file:a/gone-dir/x.txt'));
    assert.ok(types.includes('delete:dir:a/gone-dir'));

    // Deletes before adds; file deletes before dir deletes; deepest dir first
    const sorted = [...actions].sort(compareActionsForApply);
    assert.deepEqual(sorted, actions);
    const firstAdd = actions.findIndex((a) => a.type === 'add' || a.type === 'update');
    const lastDelete = actions.map((a) => a.type).lastIndexOf('delete');
    if (firstAdd !== -1 && lastDelete !== -1) {
      assert.ok(lastDelete < firstAdd, 'all deletes should precede adds/updates');
    }

    const counts = countActions(actions);
    assert.ok(counts.add >= 2);
    assert.ok(counts.delete >= 2);

    await rmrf(src);
    await rmrf(dst);
  });

  it('file↔dir type flip: delete dir before add file', async () => {
    const root = await makeTempRoot();
    // dest has dir "x" with child; source has file "x"
    const srcFiles = new Map([
      ['x', { rel: 'x', abs: path.join(root, 'x'), size: 1, mtimeMs: 0, isDir: false }],
    ]);
    const destDirs = new Map([
      ['x', { rel: 'x', abs: path.join(root, 'x'), size: 0, mtimeMs: 0, isDir: true }],
    ]);
    const destFiles = new Map([
      ['x/child.txt', { rel: 'x/child.txt', abs: path.join(root, 'x/child.txt'), size: 1, mtimeMs: 0, isDir: false }],
    ]);
    const { actions } = await buildActions(srcFiles, destFiles, new Map(), destDirs, {});
    const idxDelFile = actions.findIndex((a) => a.type === 'delete' && a.path === 'x/child.txt');
    const idxDelDir = actions.findIndex((a) => a.type === 'delete' && a.kind === 'dir' && a.path === 'x');
    const idxAddFile = actions.findIndex((a) => a.type === 'add' && a.kind === 'file' && a.path === 'x');
    assert.ok(idxDelFile >= 0 && idxDelDir >= 0 && idxAddFile >= 0);
    assert.ok(idxDelFile < idxDelDir, 'child file delete before dir');
    assert.ok(idxDelDir < idxAddFile, 'dir delete before file add');
    await rmrf(root);
  });

  it('noDelete omits deletes', async () => {
    const srcFiles = new Map();
    const destFiles = new Map([
      ['x', { rel: 'x', abs: '/tmp/x', size: 1, mtimeMs: 0, isDir: false }],
    ]);
    const { actions } = await buildActions(srcFiles, destFiles, new Map(), new Map(), { noDelete: true });
    assert.equal(actions.filter((a) => a.type === 'delete').length, 0);
  });

  it('mtime within tolerance is unchanged', async () => {
    const root = await makeTempRoot();
    await writeTree(root, { 'f.txt': 'same' });
    const e1 = entry(root, 'f.txt', 4, 10000);
    const e2 = entry(root, 'f.txt', 4, 12000); // 2s < 3s default
    const { actions, skippedUnchanged } = await buildActions(
      new Map([['f.txt', e1]]),
      new Map([['f.txt', e2]]),
      new Map(),
      new Map(),
      { mtimeToleranceMs: 3000 },
    );
    assert.equal(actions.length, 0);
    assert.equal(skippedUnchanged, 1);
    await rmrf(root);
  });

  it('maps m4b source path to m4a dest path', async () => {
    const root = await makeTempRoot();
    const srcFiles = new Map([
      ['a/book.m4b', entry(root, 'a/book.m4b', 100, 1000)],
    ]);
    const { actions } = await buildActions(srcFiles, new Map(), new Map(), new Map(), {
      mapDestPath: (rel) => (rel.endsWith('.m4b') ? rel.replace(/\.m4b$/, '.m4a') : rel),
    });
    const add = actions.find((a) => a.type === 'add' && a.kind === 'file');
    assert.equal(add.path, 'a/book.m4a');
    assert.equal(add.sourcePath, 'a/book.m4b');
    await rmrf(root);
  });

  it('mtime-only compare ignores size for transforms', async () => {
    const root = await makeTempRoot();
    const srcFiles = new Map([
      ['cover.jpg', entry(root, 'cover.jpg', 50000, 10000)],
    ]);
    const destFiles = new Map([
      ['cover.jpg', entry(root, 'cover.jpg', 12000, 10000)], // smaller after convert
    ]);
    const { actions, skippedUnchanged } = await buildActions(
      srcFiles,
      destFiles,
      new Map(),
      new Map(),
      {
        usesMtimeOnlyCompare: (rel) => rel.endsWith('.jpg'),
        contentTransformFor: (rel) => (rel.endsWith('.jpg') ? 'jpeg-h2' : null),
      },
    );
    assert.equal(actions.length, 0);
    assert.equal(skippedUnchanged, 1);
    await rmrf(root);
  });
});

describe('hashFile', () => {
  it('hashes content', async () => {
    const root = await makeTempRoot();
    const f = path.join(root, 'a.txt');
    await fs.promises.writeFile(f, 'abc');
    const h = await hashFile(f, 'sha256');
    assert.equal(h.length, 64);
    await rmrf(root);
  });
});
