/**
 * The status line for an in-flight material extraction.
 *
 * Which of the three shapes a progress report renders as is a real decision,
 * not a formatting detail: the page counter is the only precise one, a
 * percentage is what some services publish instead of a counter, and neither
 * means the job is queued — which must never be dressed up as progress, because
 * a fabricated `0/0` reads as a stall.
 */
import { describe, expect, it } from 'vitest';

import { getExtractionProgressText, getExtractionFailureKey } from '@/app/generation-preview/types';

describe('getExtractionProgressText', () => {
  it('prefers a page counter when the extractor reports one', () => {
    expect(getExtractionProgressText('lesson.pdf', { completedPages: 3, totalPages: 24 })).toEqual({
      key: 'generation.courseMaterialExtractProgress',
      values: { name: 'lesson.pdf', done: 3, total: 24 },
    });
  });

  it('prefers the page counter over a percentage when both are present', () => {
    const text = getExtractionProgressText('lesson.pdf', {
      completedPages: 3,
      totalPages: 24,
      percent: 12.5,
    });
    expect(text.key).toBe('generation.courseMaterialExtractProgress');
  });

  it('falls back to the service percentage when there is no counter', () => {
    expect(getExtractionProgressText('lesson.pdf', { percent: 42.5 })).toEqual({
      key: 'generation.courseMaterialExtractProgressPercent',
      // Rounded for display; the underlying report keeps the service's number.
      values: { name: 'lesson.pdf', percent: 43 },
    });
  });

  it.each([[0], [-1], [101], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'treats a nonsensical percentage (%s) as nothing to report',
    (percent) => {
      expect(getExtractionProgressText('lesson.pdf', { percent })).toEqual({
        key: 'generation.courseMaterialExtractWaiting',
        values: { name: 'lesson.pdf' },
      });
    },
  );

  it('waits when the extractor has nothing to report yet', () => {
    expect(getExtractionProgressText('lesson.pdf', {})).toEqual({
      key: 'generation.courseMaterialExtractWaiting',
      values: { name: 'lesson.pdf' },
    });
  });

  it('waits when a page count is half-reported', () => {
    // A completed count without a total cannot be rendered as `n/m`, and
    // inventing the missing half is exactly the fabrication this avoids.
    expect(getExtractionProgressText('lesson.pdf', { completedPages: 3 })).toEqual({
      key: 'generation.courseMaterialExtractWaiting',
      values: { name: 'lesson.pdf' },
    });
  });
});

describe('getExtractionFailureKey', () => {
  it.each([
    ['timeout', 'generation.courseMaterialExtractFailedTimeout'],
    ['service-unavailable', 'generation.courseMaterialExtractFailedUnavailable'],
    ['quota', 'generation.courseMaterialExtractFailedQuota'],
    ['auth', 'generation.courseMaterialExtractFailedAuth'],
  ])('maps %s to its own copy', (kind, key) => {
    expect(getExtractionFailureKey(kind)).toBe(key);
  });

  it.each([[undefined], ['failed'], ['something-new']])(
    'falls back to the generic copy for %s',
    (kind) => {
      // An unclassified failure is not guessed into a specific remedy.
      expect(getExtractionFailureKey(kind)).toBe('generation.courseMaterialParseFailed');
    },
  );
});
