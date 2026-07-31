import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  isProtectedRootName,
  isAllowedCategory,
  isPathInside,
  isStrictlyInside,
  validateDest,
  validateSource,
  assertMutablePath,
  assertDeletablePath,
  assertWritablePath,
  expandDestCategory,
  resolveJobPaths,
  SafetyError,
  ALLOWED_CATEGORIES,
  probeRockbox,
} from '../src/safety.js';
import { makeFakeVolume, makeTempRoot, writeTree, rmrf } from './helpers.js';

describe('isProtectedRootName', () => {
  it('protects dot-names and update.upt', () => {
    assert.equal(isProtectedRootName('.rockbox'), true);
    assert.equal(isProtectedRootName('.rockbox 2'), true);
    assert.equal(isProtectedRootName('.DS_Store'), true);
    assert.equal(isProtectedRootName('._Music'), true);
    assert.equal(isProtectedRootName('.fseventsd'), true);
    assert.equal(isProtectedRootName('update.upt'), true);
    assert.equal(isProtectedRootName('UPDATE.UPT'), true);
    assert.equal(isProtectedRootName('Music'), false);
    assert.equal(isProtectedRootName('Books'), false);
    assert.equal(isProtectedRootName('Screenshots'), false);
  });
});

describe('isAllowedCategory', () => {
  it('allows Music and Books only', () => {
    assert.equal(isAllowedCategory('Music'), true);
    assert.equal(isAllowedCategory('Books'), true);
    assert.equal(isAllowedCategory('music'), false);
    assert.equal(isAllowedCategory('Screenshots'), false);
    assert.ok(ALLOWED_CATEGORIES.includes('Music'));
    assert.ok(ALLOWED_CATEGORIES.includes('Books'));
    assert.ok(ALLOWED_CATEGORIES.length >= 2);
  });
});

describe('isPathInside', () => {
  it('uses boundary-safe prefix', () => {
    assert.equal(isPathInside('/foo/bar', '/foo/bar/baz'), true);
    assert.equal(isPathInside('/foo/bar', '/foo/bar'), true);
    assert.equal(isPathInside('/foo/bar', '/foo/barbaz'), false);
    assert.equal(isPathInside('/foo/bar', '/foo'), false);
    assert.equal(isStrictlyInside('/foo/bar', '/foo/bar'), false);
    assert.equal(isStrictlyInside('/foo/bar', '/foo/bar/x'), true);
  });
});

describe('validateDest', () => {
  let vol;
  before(async () => {
    vol = await makeFakeVolume();
  });
  after(async () => {
    await rmrf(vol);
  });

  it('accepts allowlisted category path', () => {
    const r = validateDest(path.join(vol, 'Music'));
    assert.equal(r.category, 'Music');
    assert.equal(r.volumeRoot, vol);
    assert.equal(r.rockbox.present, true);
  });

  it('refuses bare volume root', () => {
    assert.throws(() => validateDest(vol), (e) => e instanceof SafetyError && e.code === 'NOT_CATEGORY');
  });

  it('refuses unknown category', () => {
    assert.throws(
      () => validateDest(path.join(vol, 'Screenshots')),
      (e) => e instanceof SafetyError && e.code === 'NOT_CATEGORY',
    );
  });

  it('refuses / and home', () => {
    assert.throws(() => validateDest('/Music'), SafetyError);
    assert.throws(() => validateDest(path.join(os.homedir(), 'Music')), (e) => {
      // home/Music might pass category check but volume root = home is dangerous
      return e instanceof SafetyError;
    });
  });

  it('warns without rockbox unless requireRockbox', async () => {
    const plain = await makeTempRoot('theesync-plain-');
    await fs.promises.mkdir(path.join(plain, 'Music'));
    const r = validateDest(path.join(plain, 'Music'));
    assert.ok(r.warnings.length >= 1);
    assert.throws(
      () => validateDest(path.join(plain, 'Music'), { requireRockbox: true }),
      (e) => e.code === 'REQUIRE_ROCKBOX',
    );
    await rmrf(plain);
  });
});

describe('expandDestCategory', () => {
  it('joins volume + category', () => {
    assert.equal(
      expandDestCategory('/Volumes/H2', 'Music'),
      path.resolve('/Volumes/H2/Music'),
    );
  });

  it('rejects bad category', () => {
    assert.throws(() => expandDestCategory('/Volumes/H2', 'Foo'), SafetyError);
  });
});

describe('assertMutablePath / protected roots', () => {
  let vol;
  before(async () => {
    vol = await makeFakeVolume({ withMusic: true });
  });
  after(async () => {
    await rmrf(vol);
  });

  const dest = () => path.join(vol, 'Music');

  it('allows file inside Music', () => {
    assert.doesNotThrow(() =>
      assertWritablePath(path.join(dest(), 'Tool', 'track.flac'), dest()),
    );
  });

  it('refuses .rockbox under volume', () => {
    assert.throws(
      () => assertDeletablePath(path.join(vol, '.rockbox', 'config.cfg'), dest()),
      (e) => e.code === 'PROTECTED_ROOT' || e.code === 'OUTSIDE_DEST' || e.code === 'WRONG_CATEGORY',
    );
  });

  it('refuses update.upt', () => {
    assert.throws(
      () => assertDeletablePath(path.join(vol, 'update.upt'), dest()),
      SafetyError,
    );
  });

  it('refuses Screenshots', () => {
    assert.throws(
      () => assertDeletablePath(path.join(vol, 'Screenshots', 'shot.png'), dest()),
      SafetyError,
    );
  });

  it('refuses path outside dest', () => {
    assert.throws(
      () => assertDeletablePath(path.join(vol, 'Books', 'x.epub'), dest()),
      (e) => e.code === 'OUTSIDE_DEST' || e.code === 'WRONG_CATEGORY',
    );
  });

  it('refuses deleting category root itself as deletable', () => {
    assert.throws(() => assertDeletablePath(dest(), dest()), SafetyError);
  });
});

describe('validateSource', () => {
  it('rejects missing / nested / same', async () => {
    const t = await makeTempRoot();
    const src = path.join(t, 'src');
    await fs.promises.mkdir(src);
    const dest = path.join(t, 'Music');
    await fs.promises.mkdir(dest);

    assert.doesNotThrow(() => validateSource(src, dest));
    assert.throws(() => validateSource(src, src), (e) => e.code === 'SOURCE_EQ_DEST');
    assert.throws(() => validateSource(path.join(t, 'nope'), dest), (e) => e.code === 'SOURCE_MISSING');

    // nested: dest inside source
    const nestedDest = path.join(src, 'Music');
    await fs.promises.mkdir(nestedDest);
    assert.throws(() => validateSource(src, nestedDest), (e) => e.code === 'NESTED_PATHS');

    // nested: source inside dest
    const innerSrc = path.join(dest, 'sub');
    await fs.promises.mkdir(innerSrc);
    assert.throws(() => validateSource(innerSrc, dest), (e) => e.code === 'NESTED_PATHS');

    await rmrf(t);
  });
});

describe('symlink dest protection', () => {
  it('refuses symlink category dest', async () => {
    const { assertDestNotSymlink, SafetyError } = await import('../src/safety.js');
    const t = await makeTempRoot();
    const real = path.join(t, 'real');
    await fs.promises.mkdir(real);
    const link = path.join(t, 'Music');
    try {
      await fs.promises.symlink(real, link);
    } catch (err) {
      // Windows without symlink privilege — skip
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        await rmrf(t);
        return;
      }
      throw err;
    }
    assert.throws(() => assertDestNotSymlink(link), (e) => e.code === 'DEST_SYMLINK');
    await rmrf(t);
  });
});

describe('probeRockbox', () => {
  it('detects markers', async () => {
    const vol = await makeFakeVolume();
    const p = probeRockbox(vol);
    assert.equal(p.present, true);
    assert.equal(p.hasRockboxDir, true);
    assert.equal(p.hasUpdate, true);
    await rmrf(vol);
  });
});

describe('resolveJobPaths', () => {
  it('resolves full job', async () => {
    const vol = await makeFakeVolume();
    const src = await makeTempRoot('theesync-src-');
    await writeTree(src, { 'a.txt': 'hi' });

    const r = resolveJobPaths({
      source: src,
      dest: vol,
      category: 'Music',
    });
    assert.equal(r.dest, path.join(vol, 'Music'));
    assert.equal(r.category, 'Music');

    await rmrf(vol);
    await rmrf(src);
  });
});
