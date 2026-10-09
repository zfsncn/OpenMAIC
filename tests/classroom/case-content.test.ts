import { describe, expect, it } from 'vitest';
import { caseContentFromGeneratedContent } from '@/lib/classroom/case-content';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    caseTitle: 'The mill that dyed the river',
    summary: 'A tributary ran red for a week.',
    knowledgePoints: ['Environmental externality', 'Regulatory failure'],
    narrative: 'A mill discharged dye after dark.\n\nThe tributary ran red.',
    discussionQuestions: [
      { id: 'cq1', question: 'Who bore the cost?', point: 'Environmental externality' },
    ],
    sources: [{ title: 'Official report', url: 'https://example.gov.cn/report' }],
    ...overrides,
  };
}

const keys = (value: unknown) => Object.keys(value ?? {});

describe('case content adaptation', () => {
  it('stamps the discriminant the generated payload does not carry', () => {
    const content = caseContentFromGeneratedContent(payload());

    expect(content).toEqual({
      type: 'case',
      caseTitle: 'The mill that dyed the river',
      summary: 'A tributary ran red for a week.',
      knowledgePoints: ['Environmental externality', 'Regulatory failure'],
      narrative: 'A mill discharged dye after dark.\n\nThe tributary ran red.',
      discussionQuestions: [
        { id: 'cq1', question: 'Who bore the cost?', point: 'Environmental externality' },
      ],
      sources: [{ title: 'Official report', url: 'https://example.gov.cn/report' }],
    });
  });

  it('never carries an analysis over from the generated payload', () => {
    // The payload type allows one and the route would pass it through, but an
    // analysis explains a specific event: reusing it would render the previous
    // case's explanation underneath the new case.
    const content = caseContentFromGeneratedContent(
      payload({ analysis: { entries: [{ point: 'Regulatory failure', bearing: 'Old event.' }] } }),
    );

    expect(content).not.toBeNull();
    expect(keys(content)).not.toContain('analysis');
  });

  it('never fabricates a variant list on a freshly generated case', () => {
    // A new case is a one-case document. Writing a list here would claim the
    // chapter already holds three, and the swap action would rotate through a
    // single case instead of generating the second one.
    const content = caseContentFromGeneratedContent(payload());

    expect(keys(content)).not.toContain('caseVariants');
    expect(keys(content)).not.toContain('activeVariantIndex');
  });

  it('omits an absent or blank summary rather than storing an empty one', () => {
    expect(
      caseContentFromGeneratedContent(payload({ summary: undefined }))?.summary,
    ).toBeUndefined();
    expect(caseContentFromGeneratedContent(payload({ summary: '   ' }))?.summary).toBeUndefined();
  });

  it('drops knowledge points that are blank and trims the rest', () => {
    const content = caseContentFromGeneratedContent(
      payload({ knowledgePoints: ['  Pigouvian tax ', '', '   ', 7] }),
    );

    expect(content?.knowledgePoints).toEqual(['Pigouvian tax']);
  });

  it('drops a question with no text and ids the rest positionally', () => {
    const content = caseContentFromGeneratedContent(
      payload({ discussionQuestions: [{ question: '   ' }, { question: 'Who bore the cost?' }] }),
    );

    expect(content?.discussionQuestions).toEqual([{ id: 'cq_1', question: 'Who bore the cost?' }]);
  });

  it('drops a source with no openable URL, falling back to the URL as its title', () => {
    const content = caseContentFromGeneratedContent(
      payload({
        sources: [
          { title: 'Dangling', url: 'not-a-url' },
          { title: '   ', url: 'https://news.example.com/story' },
        ],
      }),
    );

    expect(content?.sources).toEqual([
      { title: 'https://news.example.com/story', url: 'https://news.example.com/story' },
    ]);
  });

  it('omits sources entirely when none survive', () => {
    const content = caseContentFromGeneratedContent(payload({ sources: [] }));

    expect(content).not.toBeNull();
    expect(keys(content)).not.toContain('sources');
  });

  it.each([
    ['a null payload', null],
    ['an array', []],
    ['a string', 'nope'],
    ['a payload with no title', payload({ caseTitle: '  ' })],
    ['a payload with no narrative', payload({ narrative: '' })],
  ])('returns null for %s', (_label, value) => {
    expect(caseContentFromGeneratedContent(value)).toBeNull();
  });
});
