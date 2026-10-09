/**
 * A chapter arrives as a file name (`01-第一章-舆论的形成.md`) and is asked for
 * its text under three different rules, which is why this module keeps them
 * apart instead of exposing one "clean up the name" helper:
 *
 * - the directory panel drops the file's own numbering but **keeps** the
 *   extension. Every row already carries the app's positional ordinal, and the
 *   two numbers disagree as soon as a chapter is removed — `order` is
 *   re-derived from the position in the set while the file name never changes —
 *   so showing both puts two conflicting numbers on one line. At most three
 *   digits, so a four-digit year (`2024-年度报告.md`) is left as-is. The
 *   tooltip keeps the original name;
 * - a requirement is a *sentence*, so there the extension is noise too
 *   (`chapterTitleFromFileName`);
 * - and the best title is not the file name at all, but the name of the
 *   classroom the chapter already produced (`resolveChapterTitle`).
 */

const LEADING_ORDINAL_PREFIX = /^\s*\d{1,3}\s*[-–—_.,)）:：、]\s*/;

/**
 * The file name's extension. It must start with a letter so a dotted number —
 * a chapter named `3.14 圆周率` — keeps its digits, which is the only way a
 * name reaching this module could end in `.` + digits without being a suffix.
 */
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** The file name as the directory panel shows it: numbering dropped, extension kept. */
export function chapterDisplayName(name: string): string {
  const stripped = name.replace(LEADING_ORDINAL_PREFIX, '');
  return stripped.length > 0 ? stripped : name;
}

/**
 * The file name as a title inside a sentence: numbering and extension dropped.
 * Falls back to the display name when stripping would leave nothing (a file
 * literally called `.md`), so a title is never empty.
 */
export function chapterTitleFromFileName(name: string): string {
  const display = chapterDisplayName(name);
  const withoutExtension = display.replace(FILE_EXTENSION, '').trim();
  return withoutExtension.length > 0 ? withoutExtension : display;
}

/** The parts of a material row this module reads. */
export interface ChapterTitleMaterial {
  name: string;
  contentDigest?: string;
}

/**
 * The parts of a course-list row this module reads. `lessonKind` is absent on
 * courses generated before the field existed, which reads as an ordinary
 * teaching lesson — the same reading the generation step applies.
 */
export interface ChapterTitleClassroom {
  name: string;
  sourceDigests?: readonly string[];
  lessonKind?: string;
}

/**
 * The chapter's title, preferring the classroom it already produced.
 *
 * A material that has been generated from is named by its course: the file is
 * an abbreviation of the chapter (`01-第一章-舆论的定义.pdf`) while the course
 * carries the title the outline gave it, and the sentence reads better with the
 * latter. The link is `contentDigest` ↔ `sourceDigests`, which costs no request.
 *
 * A quiz or case classroom built from the same chapter carries the **same**
 * digest, so the kind filter is what keeps the sentence from naming a lesson
 * after an assessment. The list arrives newest-first, so the first match is the
 * most recently updated one — the rule the generation step uses to decide which
 * classroom a re-upload should reopen.
 *
 * Falls back to the cleaned-up file name: a chapter that has never been
 * generated from, or one whose digest predates the link, still gets a title.
 */
export function resolveChapterTitle(
  material: ChapterTitleMaterial,
  classrooms: readonly ChapterTitleClassroom[],
): string {
  const digest = material.contentDigest;
  if (digest) {
    const lesson = classrooms.find(
      (classroom) =>
        (classroom.lessonKind ?? 'lesson') === 'lesson' &&
        classroom.sourceDigests?.includes(digest) === true,
    );
    if (lesson && lesson.name.trim().length > 0) return lesson.name;
  }

  return chapterTitleFromFileName(material.name);
}
