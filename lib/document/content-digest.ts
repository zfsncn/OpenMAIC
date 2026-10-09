/**
 * SHA-256 of a file's bytes, computed in the browser.
 *
 * This is the stable half of the extraction-derivation key
 * (`lib/persistence/material-extraction.ts`): the server hashes the bytes it
 * receives anyway, so the two only have to agree on the algorithm for a row
 * written on one path to be found from the other. That is why this helper
 * exists at all — the digest travels with the *directory entry*
 * (`SelectedCourseMaterial.contentDigest`), and the directory is what a device
 * keeps when it no longer has the bytes. Without a digest on the entry, a
 * chapter restored on another device could be listed but never resolved back to
 * the derivation that was already paid for.
 *
 * ## It is allowed to fail, and callers must allow it too
 *
 * `crypto.subtle` exists only in a **secure context** (HTTPS, or `localhost`).
 * A deployment reached over plain HTTP on a LAN address has no `crypto.subtle`
 * at all, and a digest is then simply unavailable — the chapter still attaches,
 * still uploads, and is still extracted; it just cannot be found again by
 * digest from a device that lacks its bytes. Returning `undefined` rather than
 * throwing is what makes that a degradation instead of a broken upload.
 *
 * Browser-safe by construction: no Node imports, no `Buffer`. The hex encoding
 * is done over the raw bytes so the result matches the server's
 * `crypto.createHash('sha256').digest('hex')` byte for byte.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('ContentDigest');

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The lowercase-hex SHA-256 of `file`'s bytes, or `undefined` when this
 * context cannot compute one (see the module note).
 */
export async function computeContentDigest(file: Blob): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== 'function') return undefined;
  try {
    const bytes = await file.arrayBuffer();
    return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  } catch (error) {
    log.warn('Could not compute the content digest for this material:', error);
    return undefined;
  }
}
