import { describe, expect, it } from 'vitest';

import { isCourseMaterialUsable } from '@/lib/document/course-material-availability';

describe('isCourseMaterialUsable', () => {
  const bytes = () => new File(['# Chapter'], 'chapter-01.md', { type: 'text/markdown' });

  it('accepts a chapter whose bytes are on this device', () => {
    expect(isCourseMaterialUsable({ file: bytes() })).toBe(true);
  });

  it('accepts a chapter restored on another device, because its digest names an archived extraction', () => {
    // The cross-device case: no bytes anywhere near this browser, and the
    // chapter is still generatable (via `/api/material-extraction`).
    expect(isCourseMaterialUsable({ contentDigest: 'a'.repeat(64) })).toBe(true);
  });

  it('refuses a row with neither, which is the pre-digest directory entry', () => {
    expect(isCourseMaterialUsable({})).toBe(false);
  });

  it('does not treat an empty digest as a digest', () => {
    // An empty string is what a partially written row looks like, and treating
    // it as a key would send the pipeline after a derivation that cannot exist.
    expect(isCourseMaterialUsable({ contentDigest: '' })).toBe(false);
  });
});
