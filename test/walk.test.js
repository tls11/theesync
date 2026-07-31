import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { walkTree, walkTreeSync, shouldSkipName } from '../src/walk.js';
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
});
