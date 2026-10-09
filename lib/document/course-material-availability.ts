/**
 * Whether a chapter can still become part of a lesson on *this* device.
 *
 * There are two ways to resolve a chapter's content, and a chapter needs only
 * one of them:
 *
 * - **Its bytes** — present when this is the device the file was attached on
 *   (and its IndexedDB copy is still there). The pipeline parses them.
 * - **Its digest** — present on every entry of a directory written by a build
 *   that records digests. It names an extraction archived server-side
 *   (`lib/persistence/material-extraction.ts`, read through
 *   `app/api/material-extraction`), which is what lets a chapter restored on
 *   another device generate without its file being selected again.
 *
 * Neither one means the chapter is stuck, and the directory and the generate
 * guard both have to agree about what "stuck" is: a directory row that looks
 * usable but is refused on generate (or the reverse) is exactly the kind of
 * mismatch that reads as a bug. Hence one predicate, two callers.
 *
 * A chapter that has *neither* — a `v1` directory entry (written before
 * digests existed) or one whose browser could not compute one, because
 * `crypto.subtle` needs a secure context (`lib/document/content-digest.ts`) —
 * really does occur, and for it the answer stays "select the file again". That
 * is why this returns a boolean rather than assuming a digest is always there.
 */
export function isCourseMaterialUsable(material: { file?: File; contentDigest?: string }): boolean {
  return Boolean(material.file) || Boolean(material.contentDigest);
}
