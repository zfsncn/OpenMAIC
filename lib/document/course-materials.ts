import type { SelectedCourseMaterial } from '@/lib/types/generation';

type CourseMaterialFingerprintInput = Pick<File, 'name' | 'size' | 'lastModified'>;

export function courseMaterialFingerprint(file: CourseMaterialFingerprintInput): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function dedupeCourseMaterialFiles(
  existing: SelectedCourseMaterial[],
  incoming: File[],
): File[] {
  const seen = new Set(existing.map(courseMaterialFingerprint));
  return incoming.filter((file) => {
    const fingerprint = courseMaterialFingerprint(file);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

/**
 * The materials the active folder view shows.
 *
 * One list holds every folder's rows; the view decides which of them are on
 * screen. Two views:
 *
 * - **A folder** (`folderId` set) shows exactly the rows filed under it. A new
 *   folder therefore starts empty, and stays empty until something is attached
 *   while that folder is open — which is the point: the folder's chapter list
 *   is built by being in the folder.
 * - **The root** shows unfiled rows *and* rows filed under a folder that no
 *   longer exists. The second half matters because folders are deleted
 *   elsewhere as well: dropping a folder in `ungroup` mode leaves its courses
 *   unfiled, and its materials have to follow them back to the root rather than
 *   becoming unreachable rows nobody can see or delete. `knownFolderIds` is
 *   what makes that distinction possible — an id absent from it is a folder
 *   that was deleted, not a folder with nothing in it.
 *
 * This shares its rule with the course grid below the panel (`visibleClassrooms`
 * in the homepage), so the two never disagree about what the current view
 * contains.
 */
export function courseMaterialsInView(
  materials: readonly SelectedCourseMaterial[],
  view: { folderId?: string; knownFolderIds: ReadonlySet<string> },
): SelectedCourseMaterial[] {
  if (view.folderId) return materials.filter((material) => material.folderId === view.folderId);
  return materials.filter(
    (material) => !material.folderId || !view.knownFolderIds.has(material.folderId),
  );
}
