/**
 * What counts as a *courseware* row — the only thing the home grid and the
 * workspace tree are allowed to list.
 *
 * The three lesson kinds are generated from the SAME material and therefore
 * carry the SAME `sourceDigests`; `lessonKind` is the only field that tells
 * them apart (`packages/@openmaic/dsl/src/stage.ts`). The teaching lesson —
 * `'lesson'`, which is also what a row without the field reads as — is the
 * courseware; the two assessments ("单元测试" / "案例教学") are not.
 *
 * ── The invariant this module exists to protect ─────────────────────────
 *
 * Hiding the assessments is a **read-side** projection and nothing else. It
 * must never be folded into the `classrooms` list itself, because that same
 * list is the search set of the reuse predicate in `app/page.tsx` ("this
 * material already has a course — reopen it instead of generating a second
 * one"). Filter the list, and the predicate finds nothing, so every click
 * silently generates a brand new course instead of reopening the existing
 * one — permanently, and with no visible error.
 *
 * So: reshape the list you *render*, never the list you *look things up in*.
 */

import type { LessonKind } from '@/lib/types/stage';

/**
 * The only field this module reads — deliberately the same shape a
 * `StageListItem`, a `DiscoveryCourse` (home grid) and a tree row all satisfy,
 * so one predicate serves every surface.
 */
export interface LessonKindLike {
  readonly lessonKind?: LessonKind;
}

/**
 * True for a row that belongs in the course lists.
 *
 * Absent `lessonKind` is an ordinary teaching lesson: every course generated
 * before the field existed reads that way, and so does every row the
 * generation step stamps without a kind.
 */
export function isCourseware(item: LessonKindLike): boolean {
  return (item.lessonKind ?? 'lesson') === 'lesson';
}

/**
 * The pool a list renders from. Searching is deliberately exempt: a hidden
 * assessment is otherwise unreachable from the UI, and the search view is the
 * one door left to rename, move or delete it.
 *
 * Returns the ORIGINAL array reference when searching, so a caller memoising
 * on identity does not re-render for a no-op — the same contract
 * `filterByName` (`lib/workbench/workspace-tree.ts`) already keeps.
 */
export function coursewarePool<T extends LessonKindLike>(
  items: readonly T[],
  searching: boolean,
): readonly T[] {
  if (searching) return items;
  return items.filter(isCourseware);
}
