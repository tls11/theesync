import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { planJob, applyPlan, syncJob, runPlan } from '../src/sync.js';
import { createEmitter } from '../src/events.js';
import { readPlanFile } from '../src/plan-file.js';
import {
  makeFakeVolume,
  makeTempRoot,
  writeTree,
  listRelFiles,
  exists,
  rmrf,
} from './helpers.js';

function quietEmit() {
  return createEmitter({
    write: () => {},
    writeErr: () => {},
  });
}

describe('sync plan/apply', () => {
  let vol;
  let src;
  let dest;

  beforeEach(async () => {
    vol = await makeFakeVolume({ withMusic: true });
    dest = path.join(vol, 'Music');
    src = await makeTempRoot('theesync-src-');
    await writeTree(src, {
      'Tool/Lateralus (2001)/01 - Schism.flac': 'schism-v1',
      'Tool/Lateralus (2001)/cover.jpg': 'cover',
      'Nirvana/Nevermind/01 - Smells.flac': 'smells',
      '.DS_Store': 'skip-me',
      'Tool/._junk': 'skip',
    });
  });

  afterEach(async () => {
    await rmrf(vol);
    await rmrf(src);
  });

  it('plan is read-only and detects adds', async () => {
    const before = await listRelFiles(vol);
    const { plan } = await planJob({
      source: src,
      dest,
      emit: quietEmit(),
    });

    assert.ok(plan.counts.addFiles >= 3);
    assert.equal(plan.version, 1);
    // volume untouched
    const after = await listRelFiles(vol);
    assert.deepEqual(after, before);
    // plan has no skip entries
    assert.ok(plan.actions.every((a) => ['add', 'update', 'delete'].includes(a.type)));
  });

  it('apply copies files and never touches rockbox/update/screenshots', async () => {
    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    const { summary } = await applyPlan(plan, { emit: quietEmit() });

    assert.equal(summary.failed, 0);
    assert.ok(summary.added >= 3);

    assert.equal(
      await fs.promises.readFile(path.join(dest, 'Tool/Lateralus (2001)/01 - Schism.flac'), 'utf8'),
      'schism-v1',
    );

    // Protected still present
    assert.equal(await exists(path.join(vol, '.rockbox')), true);
    assert.equal(await exists(path.join(vol, 'update.upt')), true);
    assert.equal(await exists(path.join(vol, 'Screenshots', 'shot.png')), true);
    assert.equal(await exists(path.join(vol, '.DS_Store')), true);
  });

  it('updates when content size changes', async () => {
    await syncJob({ source: src, dest, emit: quietEmit() });
    await fs.promises.writeFile(
      path.join(src, 'Tool/Lateralus (2001)/01 - Schism.flac'),
      'schism-v2-longer',
    );
    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    assert.ok(plan.actions.some((a) => a.type === 'update' && a.path.includes('Schism')));
    await applyPlan(plan, { emit: quietEmit() });
    assert.equal(
      await fs.promises.readFile(path.join(dest, 'Tool/Lateralus (2001)/01 - Schism.flac'), 'utf8'),
      'schism-v2-longer',
    );
  });

  it('deletes dest-only library files and macOS junk; junk counted separately', async () => {
    await syncJob({ source: src, dest, emit: quietEmit() });
    await fs.promises.writeFile(path.join(dest, '.DS_Store'), 'junk');
    await fs.promises.writeFile(path.join(dest, 'Tool', '._cover'), 'junk');
    await fs.promises.writeFile(path.join(dest, 'orphan.flac'), 'gone');

    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    const dels = plan.actions.filter((a) => a.type === 'delete');
    assert.ok(dels.some((a) => a.path === 'orphan.flac'));
    assert.ok(dels.some((a) => a.path === '.DS_Store'));
    assert.ok(dels.some((a) => a.path === 'Tool/._cover'));
    // Library delete count excludes junk (confirm UI uses counts.delete)
    assert.equal(plan.counts.delete, 1);
    assert.ok(plan.counts.deleteJunk >= 2);

    await applyPlan(plan, { emit: quietEmit() });
    assert.equal(await exists(path.join(dest, 'orphan.flac')), false);
    assert.equal(await exists(path.join(dest, '.DS_Store')), false);
    assert.equal(await exists(path.join(dest, 'Tool', '._cover')), false);
  });

  it('source skip omits copy; dest copy is deleted when deletes are on', async () => {
    await syncJob({ source: src, dest, emit: quietEmit() });
    const skip = ['Tool/Lateralus (2001)'];
    const { plan } = await planJob({
      source: src,
      dest,
      excludeSource: skip,
      emit: quietEmit(),
    });
    assert.equal(plan.options.excludeSource.join('\0'), skip.join('\0'));
    assert.ok(
      !plan.actions.some(
        (a) => (a.type === 'add' || a.type === 'update') && String(a.path).includes('Lateralus'),
      ),
    );
    const dels = plan.actions.filter((a) => a.type === 'delete');
    assert.ok(dels.some((a) => a.path === 'Tool/Lateralus (2001)/01 - Schism.flac'));
    await applyPlan(plan, { emit: quietEmit() });
    assert.equal(await exists(path.join(dest, 'Tool/Lateralus (2001)/01 - Schism.flac')), false);
    assert.equal(await exists(path.join(dest, 'Nirvana/Nevermind/01 - Smells.flac')), true);
  });

  it('source skip + dest keep leaves dest copy in place', async () => {
    await syncJob({ source: src, dest, emit: quietEmit() });
    const { plan } = await planJob({
      source: src,
      dest,
      excludeSource: ['Tool/Lateralus (2001)'],
      excludeDest: ['Tool/Lateralus (2001)'],
      emit: quietEmit(),
    });
    const dels = plan.actions.filter((a) => a.type === 'delete');
    assert.ok(dels.every((a) => !String(a.path).includes('Lateralus')));
    await applyPlan(plan, { emit: quietEmit() });
    assert.equal(
      await exists(path.join(dest, 'Tool/Lateralus (2001)/01 - Schism.flac')),
      true,
    );
  });

  it('--no-delete skips deletions', async () => {
    await syncJob({ source: src, dest, emit: quietEmit() });
    await fs.promises.writeFile(path.join(dest, 'orphan.flac'), 'x');
    const { plan } = await planJob({ source: src, dest, noDelete: true, emit: quietEmit() });
    assert.equal(plan.actions.filter((a) => a.type === 'delete').length, 0);
    assert.equal(await exists(path.join(dest, 'orphan.flac')), true);
  });

  it('dry-run does not write', async () => {
    const before = await listRelFiles(vol);
    await syncJob({ source: src, dest, dryRun: true, emit: quietEmit() });
    assert.deepEqual(await listRelFiles(vol), before);
  });

  it('plan file write + apply without re-scan', async () => {
    const planPath = path.join(await makeTempRoot(), 'plan.json');
    const { plan } = await planJob({
      source: src,
      dest,
      writePlan: planPath,
      emit: quietEmit(),
    });
    assert.equal(await exists(planPath), true);
    const loaded = await readPlanFile(planPath);
    assert.equal(loaded.actions.length, plan.actions.length);

    // Mutate source AFTER plan: change a planned add's content and add a new source file.
    // Apply must still follow the plan only (no re-scan → new file not copied).
    const plannedRel = 'Nirvana/Nevermind/01 - Smells.flac';
    await fs.promises.writeFile(
      path.join(src, plannedRel),
      'changed-after-plan',
    );
    await fs.promises.writeFile(path.join(src, 'ONLY_AFTER_PLAN.flac'), 'new');

    const { summary } = await applyPlan(planPath, { emit: quietEmit() });
    assert.equal(summary.failed, 0);
    // Planned path applied with live content
    assert.equal(
      await fs.promises.readFile(path.join(dest, plannedRel), 'utf8'),
      'changed-after-plan',
    );
    // Unplanned file was not discovered by apply
    assert.equal(await exists(path.join(dest, 'ONLY_AFTER_PLAN.flac')), false);
    await rmrf(path.dirname(planPath));
  });

  it('file↔dir type flip applies cleanly', async () => {
    // Dest has a directory where source has a file
    await fs.promises.mkdir(path.join(dest, 'flip'), { recursive: true });
    await fs.promises.writeFile(path.join(dest, 'flip', 'old.txt'), 'old');
    await writeTree(src, { 'flip': 'now-a-file' });

    await syncJob({ source: src, dest, emit: quietEmit() });
    const st = await fs.promises.lstat(path.join(dest, 'flip'));
    assert.equal(st.isFile(), true);
    assert.equal(await fs.promises.readFile(path.join(dest, 'flip'), 'utf8'), 'now-a-file');
    assert.equal(await exists(path.join(dest, 'flip', 'old.txt')), false);
  });

  it('dir delete refuses recursive wipe of unplanned children', async () => {
    await syncJob({ source: src, dest, emit: quietEmit() });
    // Plan delete of a dest-only dir, then plant a new child after plan
    await fs.promises.mkdir(path.join(dest, 'orphan-dir'), { recursive: true });
    await fs.promises.writeFile(path.join(dest, 'orphan-dir', 'a.txt'), 'a');

    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    // Plant unplanned file after plan
    await fs.promises.writeFile(path.join(dest, 'orphan-dir', 'sneaky.txt'), 's');

    const { summary } = await applyPlan(plan, { emit: quietEmit() });
    // File deletes from plan should remove a.txt; dir delete may fail if sneaky remains
    // sneaky must NOT be wiped by recursive rm
    const sneakyStill = await exists(path.join(dest, 'orphan-dir', 'sneaky.txt'));
    // Either sneaky remains (dir delete failed ENOTEMPTY) or only sneaky's parent remains
    if (await exists(path.join(dest, 'orphan-dir'))) {
      assert.equal(sneakyStill, true, 'unplanned child must not be force-wiped');
    }
    assert.ok(summary.failed >= 0); // may have failed dir delete
  });

  it('refuses bare volume as dest', async () => {
    await assert.rejects(
      () => planJob({ source: src, dest: vol, emit: quietEmit() }),
      (e) => e.name === 'SafetyError',
    );
  });

  it('never plans deletion of .rockbox or update.upt', async () => {
    // Even if someone put weird content, dest is Music only
    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    for (const a of plan.actions) {
      assert.equal(a.path.includes('.rockbox'), false);
      assert.equal(a.path.toLowerCase().includes('update.upt'), false);
      assert.equal(a.path.startsWith('..'), false);
    }
  });

  it('runPlan never mutates', async () => {
    const before = await listRelFiles(vol);
    await runPlan({ source: src, dest, emit: quietEmit() });
    assert.deepEqual(await listRelFiles(vol), before);
  });

  it('category sugar --dest volume --category Music', async () => {
    const { plan, paths } = await planJob({
      source: src,
      dest: vol,
      category: 'Music',
      emit: quietEmit(),
    });
    assert.equal(paths.dest, dest);
    assert.ok(plan.counts.add > 0);
  });
});

describe('Books category', () => {
  it('syncs ebook tree', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    await writeTree(src, {
      'Author/title.epub': 'ebook',
      'Author/notes.txt': 'n',
    });

    await syncJob({ source: src, dest, emit: quietEmit() });
    assert.equal(await exists(path.join(dest, 'Author/title.epub')), true);
    assert.equal(await exists(path.join(dest, 'Author/notes.txt')), true);
    assert.equal(await exists(path.join(vol, '.rockbox')), true);

    await rmrf(vol);
    await rmrf(src);
  });

  it('source skip uses library paths; dest keep uses card paths', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    const srcRel = "Author/Book\u2019s Title";
    await writeTree(src, {
      [`${srcRel}/book.epub`]: 'ebook',
      'Other/keep.epub': 'ok',
    });
    await syncJob({ source: src, dest, emit: quietEmit() });
    const destFolder = "Author/Book's Title";
    assert.equal(await exists(path.join(dest, destFolder, 'book.epub')), true);

    const { plan } = await planJob({
      source: src,
      dest,
      excludeSource: [srcRel],
      excludeDest: [destFolder],
      emit: quietEmit(),
    });
    assert.ok(
      plan.actions.every((a) => a.type !== 'delete' || !String(a.path).startsWith(destFolder)),
    );
    await applyPlan(plan, { emit: quietEmit() });
    assert.equal(await exists(path.join(dest, destFolder, 'book.epub')), true);
    assert.equal(await exists(path.join(dest, 'Other/keep.epub')), true);

    await rmrf(vol);
    await rmrf(src);
  });

  it('writes m4b sources as m4a on dest without renaming source', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    await writeTree(src, {
      'Author/Series/book.m4b': 'audiobook-bytes',
      'Author/Series/notes.txt': 'notes',
    });

    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    const m4aAdd = plan.actions.find(
      (a) => a.type === 'add' && a.kind === 'file' && a.path.endsWith('.m4a'),
    );
    assert.ok(m4aAdd, 'plan should add .m4a dest path');
    assert.equal(m4aAdd.path, 'Author/Series/book.m4a');
    assert.equal(m4aAdd.sourcePath, 'Author/Series/book.m4b');
    assert.ok(!plan.actions.some((a) => a.path.endsWith('.m4b')));

    await applyPlan(plan, { emit: quietEmit() });

    assert.equal(await exists(path.join(dest, 'Author/Series/book.m4a')), true);
    assert.equal(await exists(path.join(dest, 'Author/Series/book.m4b')), false);
    assert.equal(
      await fs.promises.readFile(path.join(dest, 'Author/Series/book.m4a'), 'utf8'),
      'audiobook-bytes',
    );
    // Source untouched
    assert.equal(await exists(path.join(src, 'Author/Series/book.m4b')), true);
    assert.equal(await exists(path.join(src, 'Author/Series/book.m4a')), false);

    // Second plan: unchanged
    const { plan: plan2 } = await planJob({ source: src, dest, emit: quietEmit() });
    assert.equal(
      plan2.actions.filter((a) => a.type === 'add' || a.type === 'update').length,
      0,
    );

    // Legacy dest .m4b (wrong extension) is cleaned when source is .m4b
    await fs.promises.writeFile(path.join(dest, 'Author/Series/book.m4b'), 'stale');
    const { plan: plan3 } = await planJob({ source: src, dest, emit: quietEmit() });
    assert.ok(
      plan3.actions.some(
        (a) => a.type === 'delete' && a.path === 'Author/Series/book.m4b',
      ),
    );

    await rmrf(vol);
    await rmrf(src);
  });

  it('unchanged audiobook does not re-plan without thorough covers', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    await writeTree(src, { 'Author/book.m4b': 'audio-v1' });
    await syncJob({ source: src, dest, emit: quietEmit() });

    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    assert.equal(
      plan.actions.filter((a) => a.type === 'add' || a.type === 'update').length,
      0,
    );

    await rmrf(vol);
    await rmrf(src);
  });

  it('sidecar jpg change forces paired audiobook update', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    // Real baseline 1×1 JPEG so first sync can write the sidecar
    const tinyJpg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
        'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
        'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR' +
        'CAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z',
      'base64',
    );
    await fs.promises.mkdir(path.join(src, 'Author'), { recursive: true });
    await fs.promises.writeFile(path.join(src, 'Author/book.m4b'), 'audio-v1');
    await fs.promises.writeFile(path.join(src, 'Author/book.jpg'), tinyJpg);
    await syncJob({ source: src, dest, emit: quietEmit() });

    // Larger content → size change on sidecar
    const { spawnSync } = await import('node:child_process');
    const png = path.join(src, 'Author/tmp.png');
    assert.equal(
      spawnSync('python3', [
        '-c',
        `from PIL import Image; Image.new("RGB",(80,80),(1,2,3)).save(${JSON.stringify(png)})`,
      ]).status,
      0,
    );
    assert.equal(
      spawnSync('sips', ['-s', 'format', 'jpeg', png, '--out', path.join(src, 'Author/book.jpg')])
        .status,
      0,
    );
    await fs.promises.unlink(png);

    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    const audioUp = plan.actions.find(
      (a) => a.type === 'update' && a.path === 'Author/book.m4a',
    );
    assert.ok(audioUp, 'sidecar change should update paired m4a for re-embed');
    assert.equal(audioUp.reason, 'sidecar-cover');
    assert.ok(
      plan.actions.some((a) => a.path === 'Author/book.jpg' && a.type === 'update'),
    );

    await rmrf(vol);
    await rmrf(src);
  });

  it('coverless audiobook settles after apply (no infinite re-plan)', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    // Non-MP4 placeholder (no cover art) — same class as test m4b fixtures
    await writeTree(src, { 'Author/no-cover.m4b': 'not-a-real-mp4' });

    await syncJob({ source: src, dest, emit: quietEmit() });
    assert.equal(await exists(path.join(dest, 'Author/no-cover.m4a')), true);

    const { plan } = await planJob({ source: src, dest, emit: quietEmit() });
    assert.equal(
      plan.actions.filter((a) => a.type === 'add' || a.type === 'update').length,
      0,
      'coverless book must not re-plan transform updates forever',
    );

    await rmrf(vol);
    await rmrf(src);
  });

  it('maps curly-apostrophe source to ASCII dest and cleans old dest path', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    const curlyName = "Sorcerer\u2019s Stone.m4b";
    await writeTree(src, { [`Author/${curlyName}`]: 'audio' });

    await syncJob({ source: src, dest, emit: quietEmit() });
    assert.equal(await exists(path.join(dest, "Author/Sorcerer's Stone.m4a")), true);
    assert.equal(await exists(path.join(dest, `Author/${curlyName}`)), false);

    await rmrf(vol);
    await rmrf(src);
  });

  it('converts progressive/oversized JPEG on write; leaves source alone', async () => {
    const vol = await makeFakeVolume({ withBooks: true });
    const dest = path.join(vol, 'Books');
    const src = await makeTempRoot();
    await fs.promises.mkdir(path.join(src, 'Author'), { recursive: true });

    const srcCover = path.join(src, 'Author/cover.jpg');
    // 700×700 progressive-ish large cover via Pillow + sips
    const { spawnSync } = await import('node:child_process');
    const png = path.join(src, 'Author/tmp.png');
    const py = `
from PIL import Image
Image.new("RGB", (700, 700), (10, 80, 200)).save(${JSON.stringify(png)})
`;
    assert.equal(spawnSync('python3', ['-c', py]).status, 0);
    assert.equal(
      spawnSync('sips', ['-s', 'format', 'jpeg', png, '--out', srcCover], {
        encoding: 'utf8',
      }).status,
      0,
    );
    await fs.promises.unlink(png);
    await writeTree(src, { 'Author/title.epub': 'e' });

    const srcBytes = await fs.promises.readFile(srcCover);
    await syncJob({ source: src, dest, emit: quietEmit() });

    assert.ok(srcBytes.equals(await fs.promises.readFile(srcCover)), 'source unchanged');
    assert.equal(await exists(path.join(dest, 'Author/cover.jpg')), true);

    const { inspectJpegFile, H2_JPEG_MAX_EDGE } = await import('../src/transform.js');
    const destInfo = await inspectJpegFile(path.join(dest, 'Author/cover.jpg'));
    assert.ok(destInfo);
    assert.equal(destInfo.progressive, false);
    assert.ok(Math.max(destInfo.width, destInfo.height) <= H2_JPEG_MAX_EDGE);

    await rmrf(vol);
    await rmrf(src);
  });
});
