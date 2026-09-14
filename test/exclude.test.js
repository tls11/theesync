import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExcludeError,
  normalizeExcludeRel,
  normalizeExcludeList,
  isUnderPrefix,
  isUnderAnyPrefix,
  isDestDeleteProtected,
} from '../src/exclude.js';

describe('normalizeExcludeRel', () => {
  it('trims, strips slashes, converts backslashes', () => {
    assert.equal(normalizeExcludeRel('  Tool/Lateralus  '), 'Tool/Lateralus');
    assert.equal(normalizeExcludeRel('Tool\\Lateralus\\'), 'Tool/Lateralus');
    assert.equal(normalizeExcludeRel('Playlists/'), 'Playlists');
  });

  it('rejects empty, absolute, and unsafe segments', () => {
    assert.throws(() => normalizeExcludeRel(''), ExcludeError);
    assert.throws(() => normalizeExcludeRel('   '), ExcludeError);
    assert.throws(() => normalizeExcludeRel(null), ExcludeError);
    assert.throws(() => normalizeExcludeRel('/Tool'), ExcludeError);
    assert.throws(() => normalizeExcludeRel('.'), ExcludeError);
    assert.throws(() => normalizeExcludeRel('..'), ExcludeError);
    assert.throws(() => normalizeExcludeRel('Tool/../x'), ExcludeError);
    assert.throws(() => normalizeExcludeRel('Tool//x'), ExcludeError);
    assert.throws(() => normalizeExcludeRel('Tool/./x'), ExcludeError);
  });
});

describe('normalizeExcludeList', () => {
  it('dedupes and sorts', () => {
    assert.deepEqual(
      normalizeExcludeList(['Radiohead/Kid A', 'Tool', 'Tool/', 'Radiohead/Kid A']),
      ['Radiohead/Kid A', 'Tool'],
    );
  });

  it('empty / null is []', () => {
    assert.deepEqual(normalizeExcludeList(null), []);
    assert.deepEqual(normalizeExcludeList(undefined), []);
    assert.deepEqual(normalizeExcludeList([]), []);
  });

  it('accepts a single string', () => {
    assert.deepEqual(normalizeExcludeList('Playlists'), ['Playlists']);
  });
});

describe('isUnderPrefix', () => {
  it('matches the folder and descendants, not a sibling prefix', () => {
    assert.equal(isUnderPrefix('Tool', 'Tool'), true);
    assert.equal(isUnderPrefix('Tool/Lateralus/01.flac', 'Tool'), true);
    assert.equal(isUnderPrefix('Tool/Lateralus', 'Tool/Lateralus'), true);
    assert.equal(isUnderPrefix('Toolbox', 'Tool'), false);
    assert.equal(isUnderPrefix('Tool', 'Tool/Lateralus'), false);
    assert.equal(isUnderPrefix('', 'Tool'), false);
  });
});

describe('isUnderAnyPrefix', () => {
  it('true when any prefix matches', () => {
    const prefixes = ['Tool/Lateralus', 'Radiohead/Kid A'];
    assert.equal(isUnderAnyPrefix('Tool/Lateralus/01.flac', prefixes), true);
    assert.equal(isUnderAnyPrefix('Nirvana/Nevermind', prefixes), false);
    assert.equal(isUnderAnyPrefix('x', []), false);
  });
});

describe('isDestDeleteProtected', () => {
  it('protects the kept folder, contents, and ancestors', () => {
    const keep = ['KeepMe/sub'];
    assert.equal(isDestDeleteProtected('KeepMe/sub', keep), true);
    assert.equal(isDestDeleteProtected('KeepMe/sub/file.flac', keep), true);
    assert.equal(isDestDeleteProtected('KeepMe', keep), true);
    assert.equal(isDestDeleteProtected('KeepMe/other', keep), false);
    assert.equal(isDestDeleteProtected('orphan.flac', keep), false);
  });

  it('protects a top-level keep folder without matching a sibling name', () => {
    const keep = ['Tool'];
    assert.equal(isDestDeleteProtected('Tool/Lateralus', keep), true);
    assert.equal(isDestDeleteProtected('Toolbox', keep), false);
  });
});
