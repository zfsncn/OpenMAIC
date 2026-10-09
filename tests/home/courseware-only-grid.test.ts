import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * "单元测试" / "案例教学" are hidden from the two BROWSING views — the home grid
 * (root and folder) and the workspace tree — and shown nowhere else. The
 * invariants that matter are not observable from one render: they are *scope*
 * (which surfaces read the filtered projection and which deliberately do not),
 * and the silent failure of the reuse predicate if the filter ever moves into
 * the `classrooms` list itself. Each is a property of the source.
 *
 * A source test on purpose, following `generated-course-folder-filing.test.ts`
 * next door.
 */
describe('home grid lists courseware only', () => {
  const home = () => source('app/page.tsx');

  it('derives the projection from `classrooms`, once', () => {
    expect(home()).toContain(
      'const coursewareClassrooms = useMemo(() => classrooms.filter(isCourseware), [classrooms]);',
    );
  });

  it('filters the two browsing views, and only those', () => {
    const t = home();
    // Root view: unfiled courseware (a folder id that no longer exists is
    // unfiled too).
    expect(t).toContain(
      'return coursewareClassrooms.filter((c) => c.folderId === undefined || !folderIds.has(c.folderId));',
    );
    // Folder view.
    expect(t).toContain(
      'if (currentFolderId) return coursewareClassrooms.filter((c) => c.folderId === currentFolderId);',
    );
  });

  it('keeps the search view over the whole list', () => {
    // The one door left to rename, move or delete a hidden assessment. Deleting
    // this line is the failure mode; catch it here so it cannot be silent.
    expect(home()).toContain('if (isSearching) return filteredClassrooms;');
  });

  it('counts and covers folders from the projection, not the raw list', () => {
    const t = home();
    // Report button count and the folder title count read the same pool as the
    // grid — a mismatch renders "14" over twelve tiles.
    expect(t).toContain('for (const c of coursewareClassrooms) {');
    expect(t).toContain('for (const c of [...coursewareClassrooms].sort((a, b) => b.updatedAt - a.updatedAt)) {');
    expect(t).toContain(
      '{currentFolder ? currentFolderClassrooms.length : coursewareClassrooms.length}',
    );
  });

  it('treats a folder of nothing but assessments as empty', () => {
    // Paired with the grid: without this the folder renders neither tiles nor
    // the "empty folder" hint — a blank panel.
    const t = home();
    expect(t).toContain('folders.length === 0 && coursewareClassrooms.length === 0');
    expect(t).toContain('currentFolderClassrooms.length === 0');
  });

  it('never lets the filter reach the reuse predicate (red line)', () => {
    // `classrooms` is ALSO the reuse predicate's search set. Filtering it would
    // make every "单元测试" / "案例教学" click generate a brand new course
    // instead of reopening the existing one — silently, every time.
    const t = home();
    expect(t).toContain('classrooms.find(');
    expect(t).not.toContain('coursewareClassrooms.find(');
  });
});

describe('workspace rail lists courseware only', () => {
  const rail = () => source('components/workbench/workspace/WorkspaceRail.tsx');

  it('projects the ordered courses before the search filter', () => {
    const t = rail();
    expect(t).toContain('coursewarePool(orderedCourses, searchingCourses)');
    expect(t).toContain('filterByName(visibleCourses, courseQuery)');
  });

  it('counts the courses tab from the projection', () => {
    // The rail's twin of the home "recent" count: a title of 14 over a tree of
    // twelve is the same defect on the other surface.
    expect(rail()).toContain('count={visibleCourses.length}');
  });
});
