import { expect, it } from 'vitest';
import type { AICallFn } from '@openmaic/generation';
import { generateCaseAnalysis, generateSceneContent } from '@openmaic/generation';
import {
  caseOutline,
  pblOutline,
  quizOutline,
  slideOutline,
  validCaseResponse,
  validPBLResponse,
  widgetOutline,
} from './scene-fixtures.js';

it('pins representative system and user prompts for every scene kind', async () => {
  const captured: Record<string, { system: string; user: string }> = {};

  const capture =
    (kind: string, response: string): AICallFn =>
    async (system, user) => {
      captured[kind] = { system, user };
      return response;
    };

  await generateSceneContent(
    slideOutline(),
    capture(
      'slide',
      JSON.stringify({ elements: [], background: { type: 'solid', color: '#fff' } }),
    ),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneContent(quizOutline(), capture('quiz', '[]'), {
    languageDirective: 'Teach in English.',
  });
  await generateSceneContent(
    widgetOutline(),
    capture('interactive', '<!DOCTYPE html><html><head></head><body></body></html>'),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneContent(pblOutline(), capture('pbl', validPBLResponse()), {
    languageDirective: 'Reply in English.',
    targetLanguage: 'en-US',
  });
  // The case kind is captured WITH research attached: the post-search prompt is
  // the one whose wording carries a contract (`sources` may only cite the
  // supplied list, and one event must be chosen from many), so pinning it is
  // what stops a later template edit from quietly relaxing either rule.
  await generateSceneContent(caseOutline(), capture('case', validCaseResponse()), {
    languageDirective: 'Teach in English.',
    caseContext: '### Environmental externality\n\nA mill discharged dye after dark.',
    caseSources: [
      { title: 'Official investigation report', url: 'https://example.gov.cn/report' },
      { title: 'Local news', url: 'https://news.example.com/story' },
    ],
  });

  expect(captured).toMatchSnapshot();
});

it('pins the case-analysis prompt, whose wording carries the point contract', async () => {
  const captured: Record<string, { system: string; user: string }> = {};

  const aiCall: AICallFn = async (system, user) => {
    captured.analysis = { system, user };
    return JSON.stringify({
      analysis: {
        entries: [
          { point: 'Environmental externality', bearing: 'The mill paid nothing for the river.' },
        ],
      },
    });
  };

  const analysis = await generateCaseAnalysis(
    {
      caseTitle: 'The mill that dyed the river',
      narrative: 'A mill discharged dye after dark.\n\nThe tributary ran red for a week.',
      knowledgePoints: ['Environmental externality', 'Regulatory failure'],
    },
    aiCall,
    { languageDirective: 'Teach in English.' },
  );

  expect(analysis).not.toBeNull();
  expect(captured).toMatchSnapshot();
});
