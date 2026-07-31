/**
 * Test helpers — temp volume layout mimicking H2 with category folders.
 * NEVER points at real /Volumes/H2.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function makeTempRoot(prefix = 'theesync-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Create a fake H2 volume: volumeRoot with .rockbox, update.upt, optional categories.
 */
export async function makeFakeVolume(opts = {}) {
  const root = await makeTempRoot('theesync-vol-');
  if (opts.rockbox !== false) {
    await fs.promises.mkdir(path.join(root, '.rockbox'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.rockbox', 'config.cfg'), 'x');
  }
  if (opts.updateUpt !== false) {
    await fs.promises.writeFile(path.join(root, 'update.upt'), 'firmware');
  }
  // macOS junk at root
  await fs.promises.writeFile(path.join(root, '.DS_Store'), 'junk');
  await fs.promises.writeFile(path.join(root, '._update.upt'), 'junk');

  if (opts.withMusic) {
    await fs.promises.mkdir(path.join(root, 'Music'), { recursive: true });
  }
  if (opts.withBooks) {
    await fs.promises.mkdir(path.join(root, 'Books'), { recursive: true });
  }
  // Unknown root folder — must never be touched
  await fs.promises.mkdir(path.join(root, 'Screenshots'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'Screenshots', 'shot.png'), 'png');

  return root;
}

export async function writeTree(root, tree) {
  // tree: { 'rel/path': 'content' | null for dir }
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, ...rel.split('/'));
    if (content === null) {
      await fs.promises.mkdir(abs, { recursive: true });
    } else {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content);
    }
  }
}

export async function listRelFiles(root) {
  const out = [];
  async function walk(dir, rel) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, r);
      else out.push(r);
    }
  }
  if (fs.existsSync(root)) await walk(root, '');
  return out.sort();
}

export async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function rmrf(p) {
  await fs.promises.rm(p, { recursive: true, force: true });
}
