import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { walkTree, walkTreeSync, shouldSkipName, listImmediateDirs, listImmediateEntries } from '../src/walk.js';
import { makeTempRoot, writeTree, rmrf } from './helpers.js';

describe('shouldSkipName', () => {
  it('skips all hidden names', () => {
    assert.equal(shouldSkipName('.DS_Store'), true);
    assert.equal(shouldSkipName('._foo'), true);
    assert.equal(shouldSkipName('.Trash'), true);
    assert.equal(shouldSkipName('track.flac'), false);
  });
});

describe('walkTree', () => {
  it('skips macOS junk and inventories files', async () => {
    const root = await makeTempRoot();
    await writeTree(root, {
      'Tool/Lateralus/01 - Schism.flac': 'audio',
      'Tool/Lateralus/cover.jpg': 'img',
      'Tool/.DS_Store': 'junk',
      'Tool/._Lateralus': 'junk',
      '.Spotlight-V100/store': 'junk',
    });
    // nested hidden dir
    await fs.promises.mkdir(path.join(root, '.fseventsd'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.fseventsd', 'x'), 'j');

    const { files, dirs, skipped } = await walkTree(root);
    assert.ok(files.has('Tool/Lateralus/01 - Schism.flac'));
    assert.ok(files.has('Tool/Lateralus/cover.jpg'));
    assert.equal(files.has('Tool/.DS_Store'), false);
    assert.equal(files.has('Tool/._Lateralus'), false);
    assert.ok(skipped >= 2);
    assert.ok(dirs.has('Tool'));
    assert.ok(dirs.has('Tool/Lateralus'));

    const sync = walkTreeSync(root);
    assert.equal(sync.files.size, files.size);

    await rmrf(root);
  });

  it('prunes excludePrefixes at the folder (no files, no dir entry)', async () => {
    const root = await makeTempRoot();
    await writeTree(root, {
      'Tool/Lateralus/01 - Schism.flac': 'audio',
      'Tool/10,000 Days/01 - Vicarious.flac': 'audio',
      'Nirvana/Nevermind/01 - Smells.flac': 'audio',
    });
    const skipped = [];
    const { files, dirs } = await walkTree(root, {
      excludePrefixes: ['Tool/Lateralus'],
      onSkip: (rel, reason) => skipped.push({ rel, reason }),
    });
    assert.equal(files.has('Tool/Lateralus/01 - Schism.flac'), false);
    assert.equal(dirs.has('Tool/Lateralus'), false);
    assert.ok(files.has('Tool/10,000 Days/01 - Vicarious.flac'));
    assert.ok(files.has('Nirvana/Nevermind/01 - Smells.flac'));
    assert.ok(dirs.has('Tool'));
    assert.ok(skipped.some((s) => s.rel === 'Tool/Lateralus' && s.reason === 'excluded'));

    const sync = walkTreeSync(root, { excludePrefixes: ['Tool/Lateralus'] });
    assert.equal(sync.files.has('Tool/Lateralus/01 - Schism.flac'), false);

    await rmrf(root);
  });

  it('skips a single excluded file and still walks sibling tracks', async () => {
    const root = await makeTempRoot();
    await writeTree(root, {
      'Tool/Lateralus/01 - Schism.flac': 'a',
      'Tool/Lateralus/02 - Parabola.flac': 'b',
    });
    const { files, dirs } = await walkTree(root, {
      excludePrefixes: ['Tool/Lateralus/01 - Schism.flac'],
    });
    assert.equal(files.has('Tool/Lateralus/01 - Schism.flac'), false);
    assert.ok(files.has('Tool/Lateralus/02 - Parabola.flac'));
    assert.ok(dirs.has('Tool/Lateralus'));
    await rmrf(root);
  });
});

describe('listImmediateDirs', () => {
  it('lists non-hidden child dirs only', async () => {
    const root = await makeTempRoot();
    await writeTree(root, {
      'Tool/a.flac': 'x',
      'Nirvana/b.flac': 'y',
      'track.flac': 'file',
    });
    await fs.promises.mkdir(path.join(root, '.hidden'), { recursive: true });
    const dirs = await listImmediateDirs(root);
    assert.deepEqual(dirs, ['Nirvana', 'Tool']);
    const entries = await listImmediateEntries(root);
    assert.deepEqual(entries.dirs, ['Nirvana', 'Tool']);
    assert.deepEqual(entries.files, ['track.flac']);
    await rmrf(root);
  });
});
