/**
 * Quiz prompt wiring.
 *
 * The quiz-content template gained three optional blocks, all driven by
 * `outline.quizConfig`: `questionMix` (exact per-type quotas), `optionCount`
 * (exact number of distractors) and `attempt` (the "shuffle a fresh set"
 * regeneration counter). Ordinary quiz scenes set none of them and must render
 * a byte-identical prompt to before; the unit-quiz path sets all three.
 *
 * `optionCount` also tightens the choice-option contract, so this file pins
 * both halves: the prompt says what the counts are, and the generator rejects a
 * model output that breaks them.
 */

import { describe, expect, test } from 'vitest';
import { generateSceneContent, type AICallFn } from '@openmaic/generation';

type QuizConfig = {
  questionCount: number;
  difficulty: 'easy' | 'medium' | 'hard';
  questionTypes: ('single' | 'multiple' | 'text')[];
  questionMix?: Array<{ type: 'single' | 'multiple' | 'text'; count: number }>;
  optionCount?: number;
  attempt?: number;
};

function quizOutline(quizConfig: QuizConfig) {
  return {
    id: 'quiz-1',
    type: 'quiz' as const,
    title: 'Coordinates',
    description: 'Pick a point.',
    keyPoints: ['Pairs'],
    order: 1,
    quizConfig,
  };
}

const UNIT_QUIZ_CONFIG: QuizConfig = {
  questionCount: 11,
  difficulty: 'medium',
  questionTypes: ['single', 'multiple', 'text'],
  questionMix: [
    { type: 'single', count: 5 },
    { type: 'multiple', count: 5 },
    { type: 'text', count: 1 },
  ],
  optionCount: 5,
};

/** Five options — what the unit-quiz config demands. */
const FIVE_OPTIONS = [
  { value: 'A', label: '(6, 2)' },
  { value: 'B', label: '(2, -4)' },
  { value: 'C', label: '(0, 0)' },
  { value: 'D', label: '(1, 1)' },
  { value: 'E', label: '(3, 3)' },
];

function captureUserPrompt(question: unknown): { aiCall: AICallFn; prompt: () => string } {
  let captured = '';
  const aiCall: AICallFn = async (_system, user) => {
    captured = user;
    return JSON.stringify([question]);
  };
  return { aiCall, prompt: () => captured };
}

describe('quiz prompt wiring', () => {
  test('renders the mix, option-count and attempt blocks when the config sets them', async () => {
    const { aiCall, prompt } = captureUserPrompt({
      id: 'q1',
      type: 'single',
      question: 'Which coordinate is (6, 2)?',
      options: FIVE_OPTIONS,
      answer: ['A'],
    });

    await generateSceneContent(quizOutline({ ...UNIT_QUIZ_CONFIG, attempt: 2 }), aiCall);

    const rendered = prompt();
    expect(rendered).toContain('Question Mix (MANDATORY): exactly 5 single, 5 multiple, 1 text');
    expect(rendered).toContain('Options Per Choice Question (MANDATORY): exactly 5');
    expect(rendered).toContain('Regeneration Attempt 2');
  });

  test('omits every new block for an ordinary quiz scene', async () => {
    const { aiCall, prompt } = captureUserPrompt({
      id: 'q1',
      type: 'single',
      question: 'Which coordinate is (6, 2)?',
      options: FIVE_OPTIONS,
      answer: ['A'],
    });

    await generateSceneContent(
      quizOutline({ questionCount: 1, difficulty: 'easy', questionTypes: ['single'] }),
      aiCall,
    );

    const rendered = prompt();
    expect(rendered).not.toContain('Question Mix (MANDATORY)');
    expect(rendered).not.toContain('Options Per Choice Question (MANDATORY)');
    expect(rendered).not.toContain('Regeneration Attempt');
  });

  test('rejects a choice question whose option count breaks the fixed contract', async () => {
    const failures: { code: string }[] = [];
    const { aiCall } = captureUserPrompt({
      id: 'q1',
      type: 'single',
      question: 'Which coordinate is (6, 2)?',
      options: FIVE_OPTIONS.slice(0, 4),
      answer: ['A'],
    });

    const content = await generateSceneContent(quizOutline(UNIT_QUIZ_CONFIG), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  test('accepts a choice question that meets the fixed option count', async () => {
    const failures: { code: string }[] = [];
    const { aiCall } = captureUserPrompt({
      id: 'q1',
      type: 'single',
      question: 'Which coordinate is (6, 2)?',
      options: FIVE_OPTIONS,
      answer: ['A'],
    });

    const content = await generateSceneContent(quizOutline(UNIT_QUIZ_CONFIG), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(failures).toEqual([]);
    expect(content && 'questions' in content).toBe(true);
  });
});
