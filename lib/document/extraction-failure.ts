/**
 * A classified extraction failure: what went wrong, in terms the person
 * waiting on it can act on, plus the handle needed to resume the job that
 * failed.
 *
 * ## Why a classification instead of a message
 *
 * Extraction providers talk to remote services with their own error
 * vocabularies — numeric status codes, prose messages, stage names — and every
 * one of them differs. Relaying that text to the user answers nothing they can
 * act on, and relaying it to the client as a bare string leaves the client
 * unable to choose a localized, actionable message of its own. So an extractor
 * classifies its own failure into one of the kinds below and throws this error;
 * the transport relays `kind` verbatim and keeps the provider's own text where
 * it belongs — the server log.
 *
 * ## Why this module is provider-neutral
 *
 * The class has to be nameable by every layer between the provider and the
 * client, the route included, and that route is under a guard that refuses new
 * vendor vocabulary. A vendor-neutral error contract is therefore not a
 * stylistic choice here: it is what lets the neutral layer talk about a
 * provider failure at all.
 */

/** What an extraction failure means for the person waiting on it. */
export type ExtractionFailureKind =
  /** The extraction did not finish within its deadline. */
  | 'timeout'
  /** The remote service is reachable but not serving requests right now. */
  | 'service-unavailable'
  /** The remote service refused the request because the account is out of quota. */
  | 'quota'
  /** The remote service refused the credentials. */
  | 'auth'
  /** Anything else the remote service reported as a failure. */
  | 'failed';

export interface ExtractionFailureInit {
  kind: ExtractionFailureKind;
  /**
   * An opaque handle to the remote job this failure belongs to, when a job was
   * submitted before the failure happened.
   *
   * A caller that keeps it can hand it back on the next attempt to *resume*
   * that job instead of starting a new one: the bytes are already on the
   * remote side, and re-submitting the same document pays for a second parse
   * while the first one may still be running. Absent when nothing was
   * submitted yet — there is nothing to resume, and the caller must start over.
   */
  resumeToken?: string;
  cause?: unknown;
}

export class ExtractionFailureError extends Error {
  readonly kind: ExtractionFailureKind;
  readonly resumeToken?: string;

  constructor(message: string, init: ExtractionFailureInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ExtractionFailureError';
    this.kind = init.kind;
    this.resumeToken = init.resumeToken;
  }
}

/**
 * Whether a value is a classified extraction failure. Route handlers and
 * transports use this to decide between relaying a classification and
 * answering a generic error, without importing a concrete provider.
 */
export function isExtractionFailure(error: unknown): error is ExtractionFailureError {
  return error instanceof ExtractionFailureError;
}

/**
 * A resume token is an opaque id a provider issued in an earlier run, handed
 * back to that same provider to name the job to resume. Nothing outside the
 * issuing provider may interpret it, and the shape below is the only thing the
 * neutral layers know about it — which is also why it is validated here rather
 * than per provider: a token is caller-supplied, travels through the route, and
 * ends up in a provider request. Two providers accepting two different
 * alphabets would be one provider accepting too much.
 *
 * Anything outside the alphabet is refused (undefined) rather than escaped, so
 * a token can never widen what a request can address.
 */
export function normalizeResumeToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : undefined;
}
