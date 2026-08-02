/**
 * Dest-only transforms for H2 / Rockbox.
 *
 * Never modifies source files. Applied only when writing into the category
 * directory on the card (Books today).
 *
 * Books:
 *   - .m4b → write as .m4a (Rockbox/H2 expects m4a extension); re-embed H2 cover
 *   - path segments: Unicode → ASCII-safe (e.g. ’ U+2019 → ') for FAT32/Rockbox fonts
 *   - .jpg/.jpeg → baseline JPEG, longest edge ≤ H2_JPEG_MAX_EDGE
 *     (Rockbox cannot decode progressive/multi-scan JPEGs; H2 is 320×240)
 *
 * Note: plain `sips -s format jpeg` can preserve progressive encoding. We go
 * through a PNG intermediate so the final JPEG is true baseline (SOF0).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { assertWritablePath, resolveAbs } from './safety.js';
import { tempNameFor, ensureParentDir } from './copy.js';

/** Longest edge for cover art on H2 (2.0" 320×240). Matches common Rockbox advice. */
export const H2_JPEG_MAX_EDGE = 500;

const TRANSFORM_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TRANSFORM_DIR, '..');
const VENDOR_MUTAGEN = path.join(REPO_ROOT, 'vendor', 'py');

/**
 * Stable short ASCII id from original segment (for pure non-Latin names).
 * @param {string} original
 * @returns {string}
 */
function pathSegmentFallbackId(original) {
  const hash = crypto.createHash('sha1').update(String(original), 'utf8').digest('hex').slice(0, 10);
  // Preserve extension if present so .m4a/.jpg stay usable after collapse
  const ext = path.extname(String(original));
  const asciiExt = ext && /^(\.[A-Za-z0-9]+)$/.test(ext) ? ext.toLowerCase() : '';
  return `u_${hash}${asciiExt}`;
}

/**
 * Make a single path segment safe for FAT32 + Rockbox UI fonts.
 * Curly quotes / dashes / accents → ASCII; other non-ASCII stripped.
 * Pure non-Latin names become `u_<hash>` so distinct titles do not collide on `_`.
 * Source library names are never modified — only dest paths use this.
 *
 * @param {string} segment
 * @returns {string}
 */
export function sanitizePathSegment(segment) {
  if (segment == null || segment === '') return '_';

  const original = String(segment);
  let s = original;

  // Compatibility decomposition (é → e + ́) then strip combining marks
  s = s.normalize('NFKD').replace(/\p{M}/gu, '');

  // Common punctuation that looks “wrong” on limited fonts (often like a gap)
  s = s.replace(/[\u2018\u2019\u201A\u2032\u00B4]/g, "'"); // ‘ ’ ‚ ′ ´ → '
  s = s.replace(/[\u201C\u201D\u201E\u2033]/g, '"'); // “ ” „ ″ → "
  s = s.replace(/[\u2013\u2014\u2212]/g, '-'); // – — − → -
  s = s.replace(/\u2026/g, '...'); // …
  s = s.replace(/[\u00A0\u202F\u2007\u2009\u200A\u2008]/g, ' '); // nbsp / thin spaces
  s = s.replace(/[\u200B\u200C\u200D\uFEFF]/g, ''); // zero-width

  // Drop anything outside printable ASCII
  s = s.replace(/[^\x20-\x7E]/g, '');

  // FAT32 / Windows-reserved characters in names
  s = s.replace(/[\\/:*?"<>|]/g, '_');

  // Collapse whitespace; trim trailing dots/spaces (FAT32 pain)
  s = s.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');

  // Empty, dots, or extension-only (e.g. "本.m4b" → ".m4b") after stripping non-ASCII
  const collapsed =
    !s || s === '.' || s === '..' || /^\.[A-Za-z0-9]+$/.test(s);
  if (collapsed) {
    // Preserve identity via hash, not bare "_" (collision hazard)
    return pathSegmentFallbackId(original);
  }
  return s;
}

/**
 * Sanitize a relative path (/-separated) for dest.
 * @param {string} rel
 * @returns {string}
 */
export function sanitizeRelPath(rel) {
  if (rel == null || rel === '') return rel;
  return String(rel)
    .split('/')
    .map((seg) => sanitizePathSegment(seg))
    .join('/');
}

/**
 * Map a source-relative path to the dest-relative path for a category.
 * @param {string} sourceRel
 * @param {string} category
 * @returns {string}
 */
export function mapDestPath(sourceRel, category) {
  let rel = sourceRel;
  if (category === 'Books') {
    if (/\.m4b$/i.test(rel)) {
      rel = rel.replace(/\.m4b$/i, '.m4a');
    }
    rel = sanitizeRelPath(rel);
  }
  return rel;
}

/**
 * Fold a metadata string to ASCII the same way as path segments (for tags on dest).
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMetadataText(text) {
  if (text == null) return text;
  if (String(text).trim() === '') return '';
  return sanitizePathSegment(String(text));
}

/**
 * Content transform id for plan/apply, or null if plain copy (path may still map).
 * @param {string} sourceRel
 * @param {string} category
 * @returns {'jpeg-h2'|null}
 */
export function contentTransformFor(sourceRel, category) {
  if (category === 'Books' && /\.jpe?g$/i.test(sourceRel)) {
    return 'jpeg-h2';
  }
  return null;
}

/**
 * True when dest content may differ from source (size is not comparable).
 * JPEG mtime-only is decided at plan time after inspect (`resolveTransforms`);
 * here only audiobook paths that always may change size after cover rewrite.
 * @param {string} sourceRel
 * @param {string} category
 */
export function usesMtimeOnlyCompare(sourceRel, category) {
  if (category !== 'Books') return false;
  // Cover re-embed changes size; m4b→m4a path may also rewrite tags.
  if (/\.(m4b|m4a)$/i.test(sourceRel)) return true;
  return false;
}

/**
 * Parse JPEG SOF markers for dimensions + progressive flag.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, progressive: boolean } | null}
 */
export function inspectJpegBuffer(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }

  let i = 2;
  while (i < buf.length - 1) {
    // Seek to next 0xFF marker
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < buf.length && buf[i] === 0xff) i += 1;
    if (i >= buf.length) break;

    const marker = buf[i];
    i += 1;

    // Standalone markers (no length)
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break; // EOI
      continue;
    }
    // SOS — image data follows
    if (marker === 0xda) break;

    if (i + 1 >= buf.length) break;
    const segLen = (buf[i] << 8) | buf[i + 1];
    if (segLen < 2 || i + segLen > buf.length) break;

    // SOF0–SOF15 except DHT(0xC4), JPG(0xC8), DAC(0xCC)
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSof && segLen >= 8) {
      const height = (buf[i + 3] << 8) | buf[i + 4];
      const width = (buf[i + 5] << 8) | buf[i + 6];
      // Progressive DCT: SOF2, SOF6, SOF10, SOF14
      const progressive =
        marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
      return { width, height, progressive };
    }

    i += segLen;
  }

  return null;
}

/**
 * Inspect a JPEG file (header only).
 * @param {string} absPath
 * @returns {Promise<{ width: number, height: number, progressive: boolean } | null>}
 */
export async function inspectJpegFile(absPath) {
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const st = await fh.stat();
    const len = Math.min(st.size, 65536);
    if (len < 4) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return inspectJpegBuffer(buf);
  } finally {
    await fh.close();
  }
}

/**
 * Whether a Books JPEG should be re-encoded for H2 (progressive or oversized).
 * Unknown / unreadable headers → convert (safe).
 * @param {string} absPath
 * @param {number} [maxEdge]
 */
export async function jpegNeedsH2Convert(absPath, maxEdge = H2_JPEG_MAX_EDGE) {
  const info = await inspectJpegFile(absPath);
  if (!info) return true;
  if (info.progressive) return true;
  if (Math.max(info.width, info.height) > maxEdge) return true;
  return false;
}

/**
 * Build path/compare helpers for a category job.
 * @param {string} category
 */
export function createCategoryTransforms(category) {
  return {
    category,
    mapDestPath: (sourceRel) => mapDestPath(sourceRel, category),
    contentTransformFor: (sourceRel) => contentTransformFor(sourceRel, category),
    usesMtimeOnlyCompare: (sourceRel) => usesMtimeOnlyCompare(sourceRel, category),
  };
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runSips(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('sips', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'sips not found — JPEG conversion for H2 requires macOS sips. Install Xcode CLT or convert covers to baseline JPEG ≤500px manually.',
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sips failed (exit ${code}): ${stderr.trim() || 'no stderr'}`));
    });
  });
}

/**
 * Run `sips` (macOS) to produce a **baseline** JPEG ≤ maxEdge on the longest side.
 * Uses PNG intermediate — direct jpeg→jpeg often keeps progressive (SOF2), which
 * Rockbox only partially decodes (looks cropped / cut off).
 *
 * @param {string} sourceAbs
 * @param {string} outAbs
 * @param {{ maxEdge?: number }} [opts]
 */
export async function sipsWriteH2Jpeg(sourceAbs, outAbs, opts = {}) {
  const maxEdge = opts.maxEdge ?? H2_JPEG_MAX_EDGE;
  const pngTmp = `${outAbs}.theesync-h2.png`;

  try {
    // Decode + resize to PNG (loses progressive), then encode baseline JPEG.
    await runSips([
      '-Z', String(maxEdge),
      '-s', 'format', 'png',
      sourceAbs,
      '--out', pngTmp,
    ]);
    await runSips([
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '80',
      pngTmp,
      '--out', outAbs,
    ]);

    const info = await inspectJpegFile(outAbs);
    if (!info) {
      throw new Error(`H2 JPEG write produced unreadable output: ${outAbs}`);
    }
    if (info.progressive) {
      throw new Error(
        `H2 JPEG write still progressive after convert (SOF progressive) — ${outAbs}`,
      );
    }
    if (Math.max(info.width, info.height) > maxEdge) {
      throw new Error(
        `H2 JPEG still oversized ${info.width}×${info.height} (max ${maxEdge})`,
      );
    }
  } finally {
    try {
      await fs.promises.unlink(pngTmp);
    } catch {
      // ignore
    }
  }
}

/**
 * Write a source JPEG to dest as H2-friendly baseline (or plain copy if already ideal).
 * Never touches the source file.
 *
 * @param {string} sourceAbs
 * @param {string} targetAbs
 * @param {string} destRoot
 * @param {{ mtimeMs?: number, maxEdge?: number, forceConvert?: boolean }} [options]
 */
export async function writeJpegForH2(sourceAbs, targetAbs, destRoot, options = {}) {
  const target = resolveAbs(targetAbs);
  assertWritablePath(target, destRoot);
  await ensureParentDir(target, destRoot);

  const tmp = tempNameFor(target);
  assertWritablePath(tmp, destRoot);

  try {
    const force = Boolean(options.forceConvert);
    const needs = force || (await jpegNeedsH2Convert(sourceAbs, options.maxEdge));

    if (needs) {
      await sipsWriteH2Jpeg(sourceAbs, tmp, { maxEdge: options.maxEdge });
    } else {
      await fs.promises.copyFile(sourceAbs, tmp);
    }

    if (options.mtimeMs != null) {
      const mtime = new Date(options.mtimeMs);
      await fs.promises.utimes(tmp, mtime, mtime);
    } else {
      const st = await fs.promises.stat(sourceAbs);
      await fs.promises.utimes(tmp, st.atime, st.mtime);
    }

    await fs.promises.rename(tmp, target);
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Source-relative audiobook paths that would use this JPEG as a sidecar cover.
 * Same-basename .jpg pairs with .m4b/.m4a; cover.jpg / folder.jpg pair with all
 * audiobooks in that directory.
 *
 * @param {string} sidecarSrcRel source-relative path to a .jpg/.jpeg
 * @param {Map<string, unknown>|Iterable<string>} sourceFiles keys or Map of source rels
 * @returns {string[]}
 */
export function audioSourcesForSidecar(sidecarSrcRel, sourceFiles) {
  if (!/\.jpe?g$/i.test(sidecarSrcRel)) return [];
  const segs = String(sidecarSrcRel).split('/');
  const name = segs[segs.length - 1] || '';
  const dir = segs.slice(0, -1).join('/');
  const base = name.replace(/\.jpe?g$/i, '');
  const isGeneric = /^cover$/i.test(base) || /^folder$/i.test(base);

  const keys =
    sourceFiles instanceof Map
      ? sourceFiles.keys()
      : sourceFiles;

  const out = [];
  for (const rel of keys) {
    if (!/\.(m4b|m4a)$/i.test(rel)) continue;
    const rSegs = String(rel).split('/');
    const rName = rSegs[rSegs.length - 1] || '';
    const rDir = rSegs.slice(0, -1).join('/');
    if (rDir !== dir) continue;
    const rBase = rName.replace(/\.(m4b|m4a)$/i, '');
    if (isGeneric || rBase === base) out.push(rel);
  }
  return out;
}

/**
 * When a Books JPEG is add/update, force cover rewrite on paired audiobooks
 * (Rockbox prefers embedded art over the folder image).
 *
 * @param {import('./compare.js').PlanAction[]} actions
 * @param {Map<string, import('./walk.js').WalkEntry>} sourceFiles
 * @param {Map<string, import('./walk.js').WalkEntry>} destFiles
 * @param {{
 *   mapDestPath: (rel: string) => string,
 *   contentTransformFor: (rel: string) => string|null|undefined,
 * }} transforms
 * @returns {{ extras: import('./compare.js').PlanAction[], forcedUpdateCount: number }}
 */
export function collectSidecarCoverAudioUpdates(actions, sourceFiles, destFiles, transforms) {
  const mapDest = transforms.mapDestPath || ((r) => r);
  const contentTransformFor = transforms.contentTransformFor || (() => null);

  /** @type {Map<string, import('./compare.js').PlanAction>} */
  const planned = new Map();
  for (const a of actions) {
    if (a.kind === 'file' && (a.type === 'add' || a.type === 'update')) {
      planned.set(a.path, a);
    }
  }

  /** @type {import('./compare.js').PlanAction[]} */
  const extras = [];
  let forcedUpdateCount = 0;
  const seen = new Set();

  for (const a of actions) {
    if (a.kind !== 'file' || (a.type !== 'add' && a.type !== 'update')) continue;
    const srcRel = a.sourcePath || a.path;
    if (!/\.jpe?g$/i.test(srcRel)) continue;

    for (const audioSrc of audioSourcesForSidecar(srcRel, sourceFiles)) {
      const destRel = mapDest(audioSrc);
      if (seen.has(destRel)) continue;
      seen.add(destRel);

      const transform = contentTransformFor(audioSrc) || undefined;
      const sourcePath = audioSrc !== destRel ? audioSrc : undefined;
      const sFile = sourceFiles.get(audioSrc);
      if (!sFile) continue;

      const existing = planned.get(destRel);
      if (existing) {
        if (!existing.transform && transform) existing.transform = transform;
        // Mark so apply can force re-embed even if source embed is already H2-ideal
        if (existing.reason !== 'sidecar-cover') {
          existing.reason = existing.reason
            ? `${existing.reason}+sidecar-cover`
            : 'sidecar-cover';
        }
        continue;
      }

      const dFile = destFiles.get(destRel);
      if (!dFile) {
        extras.push({
          type: 'add',
          path: destRel,
          sourcePath,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'sidecar-cover',
          transform,
        });
        planned.set(destRel, extras[extras.length - 1]);
      } else {
        extras.push({
          type: 'update',
          path: destRel,
          sourcePath,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'sidecar-cover',
          transform,
        });
        planned.set(destRel, extras[extras.length - 1]);
        forcedUpdateCount += 1;
      }
    }
  }

  return { extras, forcedUpdateCount };
}

/**
 * Find a sidecar cover image next to an audiobook file (source side).
 * Prefer same-basename .jpg/.jpeg, then cover.jpg / folder.jpg in the same dir.
 * @param {string} audioSourceAbs
 * @returns {Promise<string|null>}
 */
export async function findAudiobookSidecarCover(audioSourceAbs) {
  const dir = path.dirname(audioSourceAbs);
  const base = path.basename(audioSourceAbs, path.extname(audioSourceAbs));
  const candidates = [
    path.join(dir, `${base}.jpg`),
    path.join(dir, `${base}.jpeg`),
    path.join(dir, `${base}.JPG`),
    path.join(dir, `${base}.JPEG`),
    path.join(dir, 'cover.jpg'),
    path.join(dir, 'cover.jpeg'),
    path.join(dir, 'folder.jpg'),
    path.join(dir, 'folder.jpeg'),
  ];
  for (const c of candidates) {
    try {
      const st = await fs.promises.stat(c);
      if (st.isFile()) return c;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Run a short python3 snippet with vendored mutagen on PYTHONPATH.
 * @param {string} code
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runMutagenPython(code, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'python3',
      ['-c', code, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONPATH: VENDOR_MUTAGEN + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ''),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('python3 not found — needed for audiobook cover embedding'));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            `mutagen failed (exit ${code}): ${stderr.trim() || 'no stderr'}. ` +
              `Run: python3 -m pip install 'mutagen==1.47.0' -t ${VENDOR_MUTAGEN}`,
          ),
        );
      }
    });
  });
}

/**
 * Embed H2 cover and ASCII-fold common text tags on a dest-side m4a path.
 * Prefer calling via rewriteDestAudiobookCover (temp + rename). Source never modified.
 * @param {string} audioAbs path mutagen will open and save
 * @param {string} jpegAbs
 */
export async function embedM4aCover(audioAbs, jpegAbs) {
  // Template literal preserves real Unicode in REPL keys for Python.
  const py = `
import sys, unicodedata, re
from mutagen.mp4 import MP4, MP4Cover

REPL = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u2032": "'", "\u00B4": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u2033": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\u2026": "...",
    "\u00A0": " ", "\u202F": " ", "\u2007": " ", "\u2009": " ", "\u200A": " ",
    "\u200B": "", "\u200C": "", "\u200D": "", "\uFEFF": "",
}

def sanitize_text(s):
    if s is None:
        return s
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    for a, b in REPL.items():
        s = s.replace(a, b)
    s = "".join(c for c in s if 32 <= ord(c) <= 126)
    return re.sub(r" +", " ", s).strip()

audio_path, jpeg_path = sys.argv[1], sys.argv[2]
data = open(jpeg_path, "rb").read()
audio = MP4(audio_path)
audio["covr"] = [MP4Cover(data, imageformat=MP4Cover.FORMAT_JPEG)]
for key in ("\xa9nam", "\xa9alb", "\xa9ART", "aART", "\xa9wrt", "\xa9cmt"):
    if key in audio and audio[key]:
        audio[key] = [sanitize_text(x) if isinstance(x, str) else x for x in audio[key]]
audio.save()
`;
  await runMutagenPython(py, [audioAbs, jpegAbs]);
}

/**
 * Inspect embedded MP4 cover (if any).
 * @param {string} audioAbs
 * @returns {Promise<{ hasCover: boolean, width?: number, height?: number, progressive?: boolean, bytes?: number }>}
 */
export async function inspectM4aCover(audioAbs) {
  const py = `
import sys, json
from mutagen.mp4 import MP4

def inspect_jpeg(data: bytes):
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    i = 2
    n = len(data)
    while i < n - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker in (0xD9, 0xDA):
            break
        if marker == 0x01 or (0xD0 <= marker <= 0xD8):
            continue
        if i + 1 >= n:
            break
        seg_len = (data[i] << 8) | data[i + 1]
        is_sof = (0xC0 <= marker <= 0xCF) and marker not in (0xC4, 0xC8, 0xCC)
        if is_sof and seg_len >= 8 and i + 7 < n:
            height = (data[i + 3] << 8) | data[i + 4]
            width = (data[i + 5] << 8) | data[i + 6]
            progressive = marker in (0xC2, 0xC6, 0xCA, 0xCE)
            return {"width": width, "height": height, "progressive": progressive}
        i += seg_len
    return None

audio = MP4(sys.argv[1])
covr = audio.get("covr") or []
if not covr:
    print(json.dumps({"hasCover": False}))
    raise SystemExit(0)
data = bytes(covr[0])
info = inspect_jpeg(data) or {}
print(json.dumps({
    "hasCover": True,
    "bytes": len(data),
    "width": info.get("width"),
    "height": info.get("height"),
    "progressive": info.get("progressive"),
}))
`;
  const { stdout } = await runMutagenPython(py, [audioAbs]);
  const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
  return JSON.parse(line);
}

/**
 * True if this file's embedded cover is progressive, oversized, or unreadable.
 * Missing cover alone is **not** "needs fix" (would re-plan forever when source
 * has no art either). Use `sourceCanProvideCover` when deciding plan updates.
 *
 * @param {string} audioAbs
 * @param {{ maxEdge?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function m4aCoverNeedsH2Fix(audioAbs, options = {}) {
  const maxEdge = options.maxEdge ?? H2_JPEG_MAX_EDGE;
  try {
    const info = await inspectM4aCover(audioAbs);
    if (!info.hasCover) return false;
    if (info.progressive) return true;
    if (info.width == null || info.height == null) return true;
    if (Math.max(info.width, info.height) > maxEdge) return true;
    return false;
  } catch {
    // Not a readable MP4 (or mutagen missing) — don't force endless plan updates
    return false;
  }
}

/**
 * Whether dest audiobook still needs a cover rewrite given source art availability.
 * Avoids infinite plan updates when neither side has cover art.
 *
 * @param {string} sourceAudioAbs
 * @param {string} destAudioAbs
 * @param {number} [maxEdge]
 */
export async function destAudiobookCoverStillNeedsFix(
  sourceAudioAbs,
  destAudioAbs,
  maxEdge = H2_JPEG_MAX_EDGE,
) {
  let destInfo;
  try {
    destInfo = await inspectM4aCover(destAudioAbs);
  } catch {
    return false;
  }

  const destIdeal =
    destInfo.hasCover &&
    !destInfo.progressive &&
    destInfo.width != null &&
    destInfo.height != null &&
    Math.max(destInfo.width, destInfo.height) <= maxEdge;

  if (destIdeal) return false;

  // Dest missing or non-ideal — only plan an update if source can supply art.
  if (await findAudiobookSidecarCover(sourceAudioAbs)) return true;
  try {
    const srcInfo = await inspectM4aCover(sourceAudioAbs);
    return Boolean(srcInfo.hasCover);
  } catch {
    return false;
  }
}

/**
 * Extract embedded cover bytes to a temp JPEG path (may be progressive).
 * @param {string} audioAbs
 * @param {string} outJpegAbs
 * @returns {Promise<boolean>} true if a cover was written
 */
export async function extractM4aCover(audioAbs, outJpegAbs) {
  const py = `
import sys
from mutagen.mp4 import MP4
audio = MP4(sys.argv[1])
covr = audio.get("covr") or []
if not covr:
    raise SystemExit(2)
open(sys.argv[2], "wb").write(bytes(covr[0]))
`;
  try {
    await runMutagenPython(py, [audioAbs, outJpegAbs]);
    return true;
  } catch (err) {
    if (String(err.message).includes('exit 2')) return false;
    throw err;
  }
}

/**
 * Whether to skip cover rewrite given sidecar/force and dest quality.
 * Exported for tests.
 * @param {{ force?: boolean, hasSidecar?: boolean, destNeedsFix?: boolean }} p
 */
export function shouldSkipCoverRewrite({ force = false, hasSidecar = false, destNeedsFix = false }) {
  // Sidecar present or explicit force → always re-embed (prefer folder art / plan intent)
  if (force || hasSidecar) return false;
  // No sidecar: only rewrite when dest embed is non-ideal and source can supply art
  return !destNeedsFix;
}

/**
 * After copying a Books audiobook to dest, re-embed an H2-friendly cover.
 * Prefer sidecar image next to source; else extract embedded art from source.
 * Mutagen save runs on a temp copy then renames over dest (atomic).
 * Source files are never modified.
 *
 * @param {string} sourceAudioAbs
 * @param {string} destAudioAbs
 * @param {string} destRoot
 * @param {{ force?: boolean }} [options] force: re-embed even if dest embed looks ideal
 *   (e.g. plan reason sidecar-cover). Sidecar presence also bypasses the ideal short-circuit.
 * @returns {Promise<boolean>} true if cover was re-embedded
 */
export async function rewriteDestAudiobookCover(
  sourceAudioAbs,
  destAudioAbs,
  destRoot,
  options = {},
) {
  const force = Boolean(options.force);
  const sidecar = await findAudiobookSidecarCover(sourceAudioAbs);

  let destNeedsFix = true;
  try {
    destNeedsFix = await destAudiobookCoverStillNeedsFix(sourceAudioAbs, destAudioAbs);
  } catch {
    destNeedsFix = true;
  }

  if (shouldSkipCoverRewrite({ force, hasSidecar: Boolean(sidecar), destNeedsFix })) {
    return false;
  }

  const tmpRaw = tempNameFor(path.join(path.dirname(destAudioAbs), 'cover-raw.theesync.jpg'));
  const tmpJpeg = tempNameFor(path.join(path.dirname(destAudioAbs), 'cover-h2.theesync.jpg'));
  const tmpAudio = tempNameFor(destAudioAbs);
  assertWritablePath(tmpRaw, destRoot);
  assertWritablePath(tmpJpeg, destRoot);
  assertWritablePath(tmpAudio, destRoot);

  let sourceImage = sidecar;

  try {
    if (!sourceImage) {
      const ok = await extractM4aCover(sourceAudioAbs, tmpRaw);
      if (!ok) return false;
      sourceImage = tmpRaw;
    }

    await sipsWriteH2Jpeg(sourceImage, tmpJpeg, { maxEdge: H2_JPEG_MAX_EDGE });

    // Embed on a temp copy of dest audio, then rename over the real file.
    await fs.promises.copyFile(destAudioAbs, tmpAudio);
    await embedM4aCover(tmpAudio, tmpJpeg);

    try {
      const st = await fs.promises.stat(sourceAudioAbs);
      await fs.promises.utimes(tmpAudio, st.atime, st.mtime);
    } catch {
      // non-fatal
    }

    await fs.promises.rename(tmpAudio, destAudioAbs);
    return true;
  } finally {
    for (const p of [tmpRaw, tmpJpeg, tmpAudio]) {
      try {
        await fs.promises.unlink(p);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Detect dest-path collisions after mapping (e.g. both book.m4b and book.m4a).
 * @param {Iterable<string>} sourceRels
 * @param {(rel: string) => string} mapFn
 * @returns {{ destToSource: Map<string, string>, collisions: Array<{ dest: string, sources: string[] }> }}
 */
export function buildDestOwnership(sourceRels, mapFn) {
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  for (const src of sourceRels) {
    const dest = mapFn(src);
    if (!buckets.has(dest)) buckets.set(dest, []);
    buckets.get(dest).push(src);
  }

  /** @type {Map<string, string>} */
  const destToSource = new Map();
  /** @type {Array<{ dest: string, sources: string[] }>} */
  const collisions = [];

  for (const [dest, sources] of buckets) {
    if (sources.length > 1) {
      collisions.push({ dest, sources: [...sources].sort() });
      // Prefer exact-name match (e.g. .m4a over remapped .m4b) then lexical
      const preferred =
        sources.find((s) => s === dest) ||
        [...sources].sort((a, b) => a.localeCompare(b))[0];
      destToSource.set(dest, preferred);
    } else {
      destToSource.set(dest, sources[0]);
    }
  }

  return { destToSource, collisions };
}
