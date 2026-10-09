import { describe, expect, it } from 'vitest';

import {
  chapterDisplayName,
  chapterTitleFromFileName,
  resolveChapterTitle,
  type ChapterTitleClassroom,
} from '@/lib/utils/chapter-naming';

describe('chapterDisplayName', () => {
  it('drops the file’s own numbering but keeps the extension', () => {
    expect(chapterDisplayName('01-第一章-舆论的形成.md')).toBe('第一章-舆论的形成.md');
  });

  it('leaves a four-digit year alone', () => {
    expect(chapterDisplayName('2024-年度报告.md')).toBe('2024-年度报告.md');
  });

  it('falls back to the original name when stripping would empty it', () => {
    expect(chapterDisplayName('3-')).toBe('3-');
  });
});

describe('chapterTitleFromFileName', () => {
  it('drops numbering and extension', () => {
    expect(chapterTitleFromFileName('01-第一章-舆论的形成.pdf')).toBe('第一章-舆论的形成');
  });

  it('does not treat a trailing dotted number as an extension', () => {
    expect(chapterTitleFromFileName('圆周率 3.14')).toBe('圆周率 3.14');
  });

  it('falls back to the display name when only an extension is left', () => {
    expect(chapterTitleFromFileName('.md')).toBe('.md');
  });
});

describe('resolveChapterTitle', () => {
  const classrooms: ChapterTitleClassroom[] = [
    { name: '第一章：舆论的定义与构成要素', sourceDigests: ['d8debe21'], lessonKind: 'lesson' },
    { name: '第一章 单元测验', sourceDigests: ['d8debe21'], lessonKind: 'unitQuiz' },
    { name: '第一章 案例教学', sourceDigests: ['d8debe21'], lessonKind: 'caseTeaching' },
  ];

  it('names the chapter after the lesson it already produced', () => {
    expect(
      resolveChapterTitle(
        { name: '01-第一章-舆论的定义.pdf', contentDigest: 'd8debe21' },
        classrooms,
      ),
    ).toBe('第一章：舆论的定义与构成要素');
  });

  it('never names a lesson after an assessment built from the same chapter', () => {
    // The quiz row shares the digest; only the kind filter keeps it out of the
    // sentence.
    expect(
      resolveChapterTitle({ name: '01-第一章-舆论的定义.pdf', contentDigest: 'd8debe21' }, [
        { name: '第一章 单元测验', sourceDigests: ['d8debe21'], lessonKind: 'unitQuiz' },
      ]),
    ).toBe('第一章-舆论的定义');
  });

  it('reads a course generated before lessonKind existed as a teaching lesson', () => {
    expect(
      resolveChapterTitle({ name: '01-第一章-舆论的定义.pdf', contentDigest: 'd8debe21' }, [
        { name: '第一章：舆论的定义与构成要素', sourceDigests: ['d8debe21'] },
      ]),
    ).toBe('第一章：舆论的定义与构成要素');
  });

  it('falls back to the file name when no course names the chapter', () => {
    expect(
      resolveChapterTitle({ name: '02-第二章-方法.pdf', contentDigest: 'ffffffff' }, classrooms),
    ).toBe('第二章-方法');
    // No digest at all: the chapter predates the material ↔ course link.
    expect(resolveChapterTitle({ name: '02-第二章-方法.pdf' }, classrooms)).toBe('第二章-方法');
  });

  it('ignores a matching row whose name is blank', () => {
    expect(
      resolveChapterTitle({ name: '02-第二章-方法.pdf', contentDigest: 'ffffffff' }, [
        { name: '   ', sourceDigests: ['ffffffff'] },
      ]),
    ).toBe('第二章-方法');
  });
});
