/**
 * Case Analysis Generation API
 *
 * Writes the analysis that binds a case back to its chapter's knowledge points.
 *
 * Deliberately separate from /api/generate/scene-content: that route builds a
 * scene *from an outline*, while this one explains a case that already exists.
 * Folding the two together would mean one route whose inputs are meaningful in
 * opposite directions, and it would drag the vision slice, the research context
 * and the attempt counter into a call none of them belong to.
 *
 * The input is the case **as rendered** — title, narrative, knowledge points —
 * and not the outline. The analysis has to explain the case the learner read, so
 * re-deriving anything from the outline would let the two drift apart.
 *
 * ⚠️ `resolveModelFromRequest` resolves through the `case-analysis` key: an
 * unregistered stage yields no model at all (see LLM_STAGES in
 * lib/server/model-routes.ts).
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { generateCaseAnalysis, type CaseAnalysisInput } from '@openmaic/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';

const log = createLogger('Case Analysis API');

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let caseTitle: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();
    const {
      caseTitle: rawCaseTitle,
      narrative: rawNarrative,
      knowledgePoints: rawKnowledgePoints,
      languageDirective,
    } = body as {
      caseTitle?: unknown;
      narrative?: unknown;
      knowledgePoints?: unknown;
      languageDirective?: string;
    };

    const title = typeof rawCaseTitle === 'string' ? rawCaseTitle.trim() : '';
    const narrative = typeof rawNarrative === 'string' ? rawNarrative.trim() : '';
    const knowledgePoints = Array.isArray(rawKnowledgePoints)
      ? rawKnowledgePoints.filter((point): point is string => typeof point === 'string')
      : [];

    if (!title || !narrative) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'caseTitle and narrative are required');
    }
    // The analysis's entire contract is "one entry per chapter knowledge point,
    // in the chapter's own words". With no points there is nothing to bind to
    // and nothing to check the model against, so this is a bad request rather
    // than a case that fails to analyse.
    if (knowledgePoints.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'knowledgePoints is required: the analysis is generated against them',
      );
    }

    caseTitle = title;

    // ── Model resolution from request headers/body ──
    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
      serverManaged,
    } = await resolveModelFromRequest(req, body, 'case-analysis');
    resolvedModelString = modelString;

    // No vision: the analysis is written from the text of a case that is already
    // on screen, and there is no image the model has not already been shown.
    const aiCall = async (systemPrompt: string, userPrompt: string): Promise<string> => {
      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: modelInfo?.outputWindow,
          maxRetries: 0,
        },
        'case-analysis',
        undefined,
        thinkingConfig,
        { serverManaged },
      );
      return result.text;
    };

    log.info(`Generating case analysis: "${title}" [model=${modelString}]`);

    const input: CaseAnalysisInput = { caseTitle: title, narrative, knowledgePoints };
    const analysis = await generateCaseAnalysis(input, aiCall, {
      ...(languageDirective ? { languageDirective } : {}),
    });

    if (!analysis) {
      log.error(`Failed to generate case analysis: "${title}"`);

      return apiError('GENERATION_FAILED', 500, `Failed to analyse case: ${title}`);
    }

    log.info(`Case analysis assembled: "${title}" — ${analysis.entries.length} entry(ies)`);

    return apiSuccess({ analysis });
  } catch (error) {
    log.error(
      `Case analysis generation failed [case="${caseTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error);
  }
}
