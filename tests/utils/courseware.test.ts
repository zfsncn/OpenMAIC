import { describe, expect, it } from 'vitest';

import { coursewarePool, isCourseware } from '@/lib/utils/courseware';

describe('isCourseware', () => {
  it('reads a missing lessonKind as a teaching lesson', () => {
    // Every course generated before the field existed reads this way, and so
    // does every row the generation step stamps without a kind. Treating it as
    // hidden would make those courses vanish from the home grid.
    expect(isCourseware({})).toBe(true);
    expect(isCourseware({ lessonKind: undefined })).toBe(true);
  });

  it('keeps the teaching lesson', () => {
    expect(isCourseware({ lessonKind: 'lesson' })).toBe(true);
  });

  it('hides both assessment kinds', () => {
    expect(isCourseware({ lessonKind: 'unitQuiz' })).toBe(false);
    expect(isCourseware({ lessonKind: 'caseTeaching' })).toBe(false);
  });
});

describe('coursewarePool', () => {
  const rows = [
    { id: 'a', lessonKind: 'lesson' as const },
    { id: 'b', lessonKind: 'unitQuiz' as const },
    { id: 'c' }, // generated before the field existed
    { id: 'd', lessonKind: 'caseTeaching' as const },
  ];

  it('drops the assessments and preserves order when not searching', () => {
    expect(coursewarePool(rows, false).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('returns the ORIGINAL reference while searching', () => {
    // The contract `filterByName` (lib/workbench/workspace-tree.ts) already
    // keeps: a caller memoising on identity must not re-render for a no-op.
    expect(coursewarePool(rows, true)).toBe(rows);
  });

  it('does not mutate the input', () => {
    const snapshot = rows.map((r) => r.id);
    coursewarePool(rows, false);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });
});
