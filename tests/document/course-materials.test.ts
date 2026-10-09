import { describe, expect, it } from 'vitest';

import {
  courseMaterialFingerprint,
  courseMaterialsInView,
  dedupeCourseMaterialFiles,
} from '@/lib/document/course-materials';
import type { SelectedCourseMaterial } from '@/lib/types/generation';

function fileOf(name: string, content: string, lastModified: number): File {
  return new File([content], name, { type: 'text/plain', lastModified });
}

function material(file: File, id: string): SelectedCourseMaterial {
  return {
    id,
    file,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
    order: 1,
  };
}

function row(id: string, order: number, folderId?: string): SelectedCourseMaterial {
  return {
    id,
    name: `${id}.md`,
    size: 10,
    lastModified: 1000,
    type: 'text/markdown',
    order,
    storageKey: `key-${id}`,
    ...(folderId ? { folderId } : {}),
  };
}

describe('courseMaterialFingerprint', () => {
  it('is stable for the same name, size, and lastModified', () => {
    const a = fileOf('lesson.pdf', 'same bytes', 1_700_000_000_000);
    const b = fileOf('lesson.pdf', 'same bytes', 1_700_000_000_000);
    expect(courseMaterialFingerprint(a)).toBe(courseMaterialFingerprint(b));
  });

  it('changes when the name changes', () => {
    expect(courseMaterialFingerprint(fileOf('a.pdf', 'x', 1000))).not.toBe(
      courseMaterialFingerprint(fileOf('b.pdf', 'x', 1000)),
    );
  });

  it('changes when the size changes', () => {
    expect(courseMaterialFingerprint(fileOf('a.pdf', 'x', 1000))).not.toBe(
      courseMaterialFingerprint(fileOf('a.pdf', 'xy', 1000)),
    );
  });

  it('changes when lastModified changes', () => {
    expect(courseMaterialFingerprint(fileOf('a.pdf', 'x', 1000))).not.toBe(
      courseMaterialFingerprint(fileOf('a.pdf', 'x', 1001)),
    );
  });

  it('also fingerprints an existing SelectedCourseMaterial by the same fields', () => {
    const file = fileOf('a.pdf', 'x', 1000);
    expect(courseMaterialFingerprint(material(file, 'm1'))).toBe(courseMaterialFingerprint(file));
  });
});

describe('dedupeCourseMaterialFiles', () => {
  it('drops incoming files already present in the existing list', () => {
    const existing = fileOf('a.pdf', 'x', 1000);
    const incoming = fileOf('a.pdf', 'x', 1000);
    expect(dedupeCourseMaterialFiles([material(existing, 'm1')], [incoming])).toEqual([]);
  });

  it('drops duplicates within a single incoming batch', () => {
    const one = fileOf('a.pdf', 'x', 1000);
    const two = fileOf('a.pdf', 'x', 1000);
    const other = fileOf('b.pdf', 'y', 2000);
    expect(dedupeCourseMaterialFiles([], [one, two, other])).toEqual([one, other]);
  });

  it('keeps distinct files even when only one field differs', () => {
    const one = fileOf('a.pdf', 'x', 1000);
    const two = fileOf('a.pdf', 'x', 1001);
    expect(dedupeCourseMaterialFiles([], [one, two])).toEqual([one, two]);
  });
});

describe('courseMaterialsInView', () => {
  const root = row('root', 1);
  const filed = row('filed', 1, 'folder-a');
  const other = row('other', 1, 'folder-b');
  const all = [root, filed, other];
  const known = new Set(['folder-a', 'folder-b']);

  it('shows only the rows filed under the open folder', () => {
    expect(courseMaterialsInView(all, { folderId: 'folder-a', knownFolderIds: known })).toEqual([
      filed,
    ]);
  });

  it('shows an empty list for a folder nothing is filed under', () => {
    // The point of the whole change: a brand-new folder is empty, and an empty
    // folder must not fall back to someone else's chapters.
    expect(courseMaterialsInView(all, { folderId: 'folder-c', knownFolderIds: known })).toEqual([]);
  });

  it('shows unfiled rows and nothing else at the root', () => {
    expect(courseMaterialsInView(all, { knownFolderIds: known })).toEqual([root]);
  });

  it('shows rows filed under a folder that no longer exists at the root', () => {
    // A folder deleted elsewhere (or ungrouped here) leaves this device holding
    // rows whose folderId nothing answers to. They belong to the root — the
    // same rule the course grid applies — or they would be unreachable.
    const orphan = row('orphan', 1, 'folder-gone');
    expect(courseMaterialsInView([root, orphan, filed], { knownFolderIds: known })).toEqual([
      root,
      orphan,
    ]);
  });

  it('does not confuse a deleted folder with an empty one', () => {
    const orphan = row('orphan', 1, 'folder-gone');
    expect(
      courseMaterialsInView([orphan], { folderId: 'folder-c', knownFolderIds: known }),
    ).toEqual([]);
  });

  it('scopes dedupe to the view: the same file may be filed in two folders', () => {
    // Why dedupe takes the visible rows and not the whole directory — two
    // folders are two chapter lists, so the same document is two entries.
    const shared = fileOf('shared.pdf', 'same bytes', 1000);
    expect(dedupeCourseMaterialFiles([], [shared])).toHaveLength(1);
    expect(
      dedupeCourseMaterialFiles(
        courseMaterialsInView([material(shared, 'm1')], {
          folderId: 'folder-b',
          knownFolderIds: known,
        }),
        [shared],
      ),
    ).toHaveLength(1);
  });
});
