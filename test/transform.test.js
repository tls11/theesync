import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  mapDestPath,
  contentTransformFor,
  inspectJpegBuffer,
  inspectJpegFile,
  jpegNeedsH2Convert,
  writeJpegForH2,
  H2_JPEG_MAX_EDGE,
  buildDestOwnership,
  sanitizePathSegment,
  sanitizeRelPath,
  audioSourcesForSidecar,
  collectSidecarCoverAudioUpdates,
  createCategoryTransforms,
  shouldSkipCoverRewrite,
} from '../src/transform.js';
import { makeTempRoot, rmrf } from './helpers.js';

describe('sanitizePathSegment / mapDestPath ASCII', () => {
  it('folds curly apostrophe to ASCII apostrophe', () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK (what Mac/Audible often use)
    const curly = 'Harry Potter and the Sorcerer\u2019s Stone';
    assert.equal(sanitizePathSegment(curly), "Harry Potter and the Sorcerer's Stone");
  });

  it('strips accents and exotic chars', () => {
    assert.equal(sanitizePathSegment('café'), 'cafe');
    assert.equal(sanitizePathSegment('naïve — test'), 'naive - test');
  });

  it('pure non-Latin segments become stable u_<hash> (not bare _)', () => {
    const a = sanitizePathSegment('村上春樹');
    const b = sanitizePathSegment('東野圭吾');
    assert.match(a, /^u_[0-9a-f]{10}$/);
    assert.match(b, /^u_[0-9a-f]{10}$/);
    assert.notEqual(a, b, 'distinct titles must not collide');
    assert.equal(sanitizePathSegment('村上春樹'), a, 'stable across calls');
    // Extension preserved when whole segment is non-Latin + ext
    const file = sanitizePathSegment('本.m4b');
    assert.match(file, /^u_[0-9a-f]{10}\.m4b$/);
  });
});

describe('mapDestPath (Books)', () => {
  it('renames m4b to m4a for Books only', () => {
    assert.equal(mapDestPath('Author/book.m4b', 'Books'), 'Author/book.m4a');
    assert.equal(mapDestPath('Author/Book.M4B', 'Books'), 'Author/Book.m4a');
    assert.equal(mapDestPath('Author/book.m4b', 'Music'), 'Author/book.m4b');
    assert.equal(mapDestPath('Author/book.m4a', 'Books'), 'Author/book.m4a');
    assert.equal(mapDestPath('Author/cover.jpg', 'Books'), 'Author/cover.jpg');
  });

  it('ASCII-sanitizes Books paths including curly quotes', () => {
    const src =
      'J.K. Rowling/Harry Potter/Harry Potter and the Sorcerer\u2019s Stone [B0F14RPXHR].m4b';
    const dest = mapDestPath(src, 'Books');
    assert.equal(
      dest,
      "J.K. Rowling/Harry Potter/Harry Potter and the Sorcerer's Stone [B0F14RPXHR].m4a",
    );
    assert.equal(/[^\x00-\x7F]/.test(dest), false);
    // Music leaves Unicode alone
    assert.ok(mapDestPath(src.replace(/\.m4b$/i, '.flac'), 'Music').includes('\u2019'));
  });
});

describe('contentTransformFor', () => {
  it('marks Books JPEGs', () => {
    assert.equal(contentTransformFor('a/cover.jpg', 'Books'), 'jpeg-h2');
    assert.equal(contentTransformFor('a/cover.JPEG', 'Books'), 'jpeg-h2');
    assert.equal(contentTransformFor('a/cover.jpg', 'Music'), null);
    assert.equal(contentTransformFor('a/book.m4b', 'Books'), null);
  });
});

describe('buildDestOwnership', () => {
  it('detects m4b/m4a collision', () => {
    const { destToSource, collisions } = buildDestOwnership(
      ['a/book.m4b', 'a/book.m4a', 'a/other.epub'],
      (r) => mapDestPath(r, 'Books'),
    );
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].dest, 'a/book.m4a');
    assert.equal(destToSource.get('a/book.m4a'), 'a/book.m4a'); // prefer exact name
    assert.equal(destToSource.get('a/other.epub'), 'a/other.epub');
  });
});

describe('shouldSkipCoverRewrite', () => {
  it('does not skip when sidecar exists even if dest ideal', () => {
    assert.equal(
      shouldSkipCoverRewrite({ force: false, hasSidecar: true, destNeedsFix: false }),
      false,
    );
  });
  it('does not skip when force even without sidecar', () => {
    assert.equal(
      shouldSkipCoverRewrite({ force: true, hasSidecar: false, destNeedsFix: false }),
      false,
    );
  });
  it('skips only when no sidecar, not forced, and dest does not need fix', () => {
    assert.equal(
      shouldSkipCoverRewrite({ force: false, hasSidecar: false, destNeedsFix: false }),
      true,
    );
    assert.equal(
      shouldSkipCoverRewrite({ force: false, hasSidecar: false, destNeedsFix: true }),
      false,
    );
  });
});

describe('audioSourcesForSidecar / collectSidecarCoverAudioUpdates', () => {
  it('pairs same-basename jpg with m4b', () => {
    const files = new Map([
      ['A/book.m4b', {}],
      ['A/book.jpg', {}],
      ['A/other.m4b', {}],
    ]);
    assert.deepEqual(audioSourcesForSidecar('A/book.jpg', files), ['A/book.m4b']);
  });

  it('cover.jpg pairs with all audiobooks in the folder', () => {
    const files = new Map([
      ['A/one.m4b', {}],
      ['A/two.m4a', {}],
      ['A/cover.jpg', {}],
      ['B/three.m4b', {}],
    ]);
    assert.deepEqual(audioSourcesForSidecar('A/cover.jpg', files).sort(), [
      'A/one.m4b',
      'A/two.m4a',
    ]);
  });

  it('forces audio update when sidecar jpg is updated', () => {
    const transforms = createCategoryTransforms('Books');
    transforms.contentTransformFor = (rel) =>
      /\.m4b$/i.test(rel) ? 'm4b-h2' : /\.m4a$/i.test(rel) ? 'm4a-cover' : null;

    const sourceFiles = new Map([
      [
        'A/book.m4b',
        { rel: 'A/book.m4b', abs: '/s/A/book.m4b', size: 100, mtimeMs: 1, isDir: false },
      ],
      [
        'A/book.jpg',
        { rel: 'A/book.jpg', abs: '/s/A/book.jpg', size: 10, mtimeMs: 2, isDir: false },
      ],
    ]);
    const destFiles = new Map([
      [
        'A/book.m4a',
        { rel: 'A/book.m4a', abs: '/d/A/book.m4a', size: 100, mtimeMs: 1, isDir: false },
      ],
    ]);
    const actions = [
      {
        type: 'update',
        path: 'A/book.jpg',
        kind: 'file',
        size: 10,
        mtimeMs: 2,
        reason: 'size',
        transform: 'jpeg-h2',
      },
    ];
    const { extras, forcedUpdateCount } = collectSidecarCoverAudioUpdates(
      actions,
      sourceFiles,
      destFiles,
      transforms,
    );
    assert.equal(forcedUpdateCount, 1);
    assert.equal(extras.length, 1);
    assert.equal(extras[0].type, 'update');
    assert.equal(extras[0].path, 'A/book.m4a');
    assert.equal(extras[0].sourcePath, 'A/book.m4b');
    assert.equal(extras[0].reason, 'sidecar-cover');
    assert.equal(extras[0].transform, 'm4b-h2');
  });
});

/** Minimal baseline SOF0 1×1 JPEG (not progressive). */
function minimalBaselineJpeg() {
  // FF D8 SOI
  // FF E0 APP0 JFIF
  // FF C0 SOF0 8-bit 1×1 1 component
  // FF C4 DHT (minimal)
  // FF DA SOS
  // entropy
  // FF D9 EOI
  // Use a known tiny baseline JPEG base64
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
      'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
      'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR' +
      'CAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z',
    'base64',
  );
}

describe('inspectJpegBuffer', () => {
  it('detects baseline tiny jpeg', () => {
    const buf = minimalBaselineJpeg();
    const info = inspectJpegBuffer(buf);
    assert.ok(info, 'should parse');
    assert.equal(info.progressive, false);
    assert.ok(info.width >= 1);
    assert.ok(info.height >= 1);
  });

  it('detects progressive SOF2', () => {
    // Craft: SOI + SOF2 segment with 100×80
    const parts = [
      Buffer.from([0xff, 0xd8]), // SOI
      // SOF2: marker, len=11, precision=8, height=80, width=100, components=1, then 3 bytes
      Buffer.from([0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x50, 0x00, 0x64, 0x01, 0x01, 0x11, 0x00]),
      Buffer.from([0xff, 0xd9]), // EOI
    ];
    const info = inspectJpegBuffer(Buffer.concat(parts));
    assert.ok(info);
    assert.equal(info.progressive, true);
    assert.equal(info.width, 100);
    assert.equal(info.height, 80);
  });

  it('rejects non-jpeg', () => {
    assert.equal(inspectJpegBuffer(Buffer.from('not a jpeg')), null);
  });
});

describe('writeJpegForH2', () => {
  it('does not modify source; converts oversized progressive to baseline', async () => {
    const root = await makeTempRoot('theesync-jpeg-');
    const destRoot = path.join(root, 'Books');
    await fs.promises.mkdir(destRoot, { recursive: true });

    // Build a large baseline JPEG with sips from a solid PNG
    const png = path.join(root, 'big.png');
    const srcJpg = path.join(root, 'cover.jpg');
    // 800×800 red PNG via Python Pillow
    const py = `
from PIL import Image
Image.new("RGB", (800, 800), (200, 30, 30)).save(${JSON.stringify(png)})
`;
    const pr = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
    assert.equal(pr.status, 0, pr.stderr);

    const sipsPng = spawnSync('sips', ['-s', 'format', 'jpeg', png, '--out', srcJpg], {
      encoding: 'utf8',
    });
    assert.equal(sipsPng.status, 0, sipsPng.stderr);

    const srcBefore = await fs.promises.readFile(srcJpg);
    const srcStat = await fs.promises.stat(srcJpg);
    assert.equal(await jpegNeedsH2Convert(srcJpg), true);

    const target = path.join(destRoot, 'cover.jpg');
    await writeJpegForH2(srcJpg, target, destRoot, { mtimeMs: srcStat.mtimeMs });

    // Source unchanged
    const srcAfter = await fs.promises.readFile(srcJpg);
    assert.ok(srcBefore.equals(srcAfter));

    const destInfo = await inspectJpegFile(target);
    assert.ok(destInfo);
    assert.equal(destInfo.progressive, false, 'must be baseline (SOF0), not progressive');
    assert.ok(Math.max(destInfo.width, destInfo.height) <= H2_JPEG_MAX_EDGE);

    const destStat = await fs.promises.stat(target);
    assert.ok(Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < 2000);

    await rmrf(root);
  });

  it('forces baseline even when sips jpeg→jpeg would keep progressive', async () => {
    const root = await makeTempRoot('theesync-prog-');
    const destRoot = path.join(root, 'Books');
    await fs.promises.mkdir(destRoot, { recursive: true });

    // Always synthesize progressive JPEG (no host library dependency)
    const srcJpg = path.join(root, 'prog.jpg');
    const py = `
from PIL import Image
im = Image.new("RGB", (600, 600), (20, 40, 200))
im.save(${JSON.stringify(srcJpg)}, "JPEG", quality=85, progressive=True)
`;
    assert.equal(spawnSync('python3', ['-c', py]).status, 0);

    assert.equal((await inspectJpegFile(srcJpg))?.progressive, true);
    const target = path.join(destRoot, 'out.jpg');
    await writeJpegForH2(srcJpg, target, destRoot, { forceConvert: true });
    const out = await inspectJpegFile(target);
    assert.equal(out?.progressive, false);
    assert.ok(Math.max(out.width, out.height) <= H2_JPEG_MAX_EDGE);
    await rmrf(root);
  });

  it('plain-copies already-ideal baseline jpeg', async () => {
    const root = await makeTempRoot('theesync-jpeg2-');
    const destRoot = path.join(root, 'Books');
    await fs.promises.mkdir(destRoot, { recursive: true });

    const srcJpg = path.join(root, 'small.jpg');
    await fs.promises.writeFile(srcJpg, minimalBaselineJpeg());
    assert.equal(await jpegNeedsH2Convert(srcJpg), false);

    const target = path.join(destRoot, 'small.jpg');
    await writeJpegForH2(srcJpg, target, destRoot);

    const a = await fs.promises.readFile(srcJpg);
    const b = await fs.promises.readFile(target);
    assert.ok(a.equals(b));

    await rmrf(root);
  });
});
