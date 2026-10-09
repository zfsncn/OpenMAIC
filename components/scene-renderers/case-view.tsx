'use client';

import { useCallback, useState } from 'react';
import {
  BookOpenText,
  EyeOff,
  HelpCircle,
  Link2,
  Loader2,
  RefreshCw,
  Sparkles,
  Tags,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchCaseAnalysis, fetchSceneContent } from '@/lib/hooks/use-scene-generator';
import { collectCaseResearch } from '@/lib/classroom/case-research';
import { caseContentFromGeneratedContent } from '@/lib/classroom/case-content';
import {
  activeVariantIndex,
  appendVariant,
  applyVariant,
  isAtCap,
  nextVariantIndex,
  readVariants,
  toVariant,
  updateActiveVariant,
} from '@/lib/classroom/case-variants';
import { createCaseWebSearchFn } from '@/lib/classroom/case-web-search';
import type { CaseContent } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const log = createLogger('CaseView');

interface CaseViewProps {
  readonly content: CaseContent;
  readonly sceneId: string;
  readonly stageId: string;
}

/**
 * Split a plain-text narrative into paragraphs.
 *
 * The narrative arrives as plain text with blank lines between paragraphs —
 * the contract forbids headings and markup so the model cannot smuggle a
 * layout decision into the content. Splitting on runs of blank lines (rather
 * than on every newline) keeps a sentence the model hard-wrapped by accident
 * in one paragraph instead of shredding it into fragments.
 */
function toParagraphs(narrative: string): string[] {
  return narrative
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

const ACTION_BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100';

/**
 * Case study playback view.
 *
 * A reading scene, not an interactive one: the learner reads the case, meets
 * the chapter's knowledge points as tags, and then meets the discussion
 * questions. Everything here is one scrolling column on purpose — the point of
 * the scene is that the narrative and the questions are read together, so
 * paginating them would be the one thing that breaks it.
 *
 * The analysis is written on demand, in a second pass, and rendered when
 * present and omitted when absent (below the questions, where the reveal
 * belongs). That is why the two buttons here are the whole of the staging: the
 * case is written once, the analysis only when asked for, and a replacement case
 * only when the learner wants a different event.
 */
export function CaseView({ content, sceneId, stageId }: CaseViewProps) {
  const { t } = useI18n();
  const stage = useStageStore.use.stage();
  const [analysing, setAnalysing] = useState(false);
  const [changingCase, setChangingCase] = useState(false);

  const paragraphs = toParagraphs(content.narrative);
  const sources = content.sources ?? [];
  const analysis = content.analysis;
  // Collapsed by the learner, which is a different state from "not written
  // yet": both end up showing the same button, but only one of them calls the
  // model.
  const analysisHidden = content.analysisHidden === true;
  const showAnalysis = analysis !== undefined && !analysisHidden;
  const languageDirective = stage?.languageDirective;

  const variants = readVariants(content);
  const activeIndex = activeVariantIndex(content);
  // Only once there is something to choose between: a lone "案例 1 / 1" would be
  // noise on every case that has ever been generated.
  const showVariantBadge = variants.length > 1;

  /**
   * Write the analysis the learner just asked for.
   *
   * ⚠️ `mergeSceneContentForUpdate` replaces scene content **wholesale** for
   * every kind except PBL (`lib/store/stage.ts`), so spreading the current
   * content is load-bearing rather than tidy: an unspread write persists a case
   * with no narrative and no discussion questions.
   */
  const handleAnalyse = useCallback(async () => {
    if (analysing || analysis) return;
    setAnalysing(true);
    try {
      const result = await fetchCaseAnalysis({
        caseTitle: content.caseTitle,
        narrative: content.narrative,
        knowledgePoints: content.knowledgePoints,
        ...(languageDirective ? { languageDirective } : {}),
      });

      if (!result.success || !result.analysis) {
        log.warn('Case analysis request failed:', result.error);
        toast.error(t('case.analysisFailed'));
        return;
      }

      const store = useStageStore.getState();
      store.updateScene(sceneId, { content: { ...content, analysis: result.analysis } });
      await store.saveToStorage();
    } catch (error) {
      log.warn('Failed to generate the case analysis:', error);
      toast.error(t('case.analysisFailed'));
    } finally {
      setAnalysing(false);
    }
  }, [analysing, analysis, content, languageDirective, sceneId, t]);

  /**
   * Collapse the analysis, or bring it back.
   *
   * The analysis is never touched: hiding is a display state, so showing it
   * again is a flag flip that costs nothing rather than a second generation.
   *
   * ⚠️ Deliberately not `handleAnalyse` — that one bails out as soon as an
   * analysis exists (`if (analysing || analysis) return`), so routing the
   * re-expand through it would make the button do nothing at all.
   *
   * ⚠️ The flag goes through `updateActiveVariant` because it has to land on
   * the *variant*: `applyVariant` rebuilds the top-level fields from
   * `caseVariants[i]`, so a flag written only to the mirror would be discarded
   * by the next rotation — while still looking correct on screen.
   */
  const handleToggleAnalysis = useCallback(async () => {
    const store = useStageStore.getState();
    store.updateScene(sceneId, {
      content: updateActiveVariant(content, { analysisHidden: !analysisHidden }),
    });
    await store.saveToStorage();
  }, [analysisHidden, content, sceneId]);

  /**
   * Swap the case for a different event — or, once the chapter keeps three,
   * rotate to the next one it already has.
   *
   * At the cap nothing is generated and no request leaves the page: going back
   * to a case the learner liked is the whole reason the chapter caches three.
   * Below the cap, research runs first, exactly as it does at generation time.
   * Without it the replacement would have no sources at all — the previous
   * list describes the previous event and is discarded — so every swap would
   * silently undo the "written from verified reporting" guarantee that this
   * scene exists to provide.
   */
  const handleChangeCase = useCallback(async () => {
    if (changingCase) return;

    // Rotation is local and instant, so it deliberately does not raise the
    // busy flag: the label would claim a search that is not happening.
    if (isAtCap(content)) {
      const store = useStageStore.getState();
      store.updateScene(sceneId, { content: applyVariant(content, nextVariantIndex(content)) });
      await store.saveToStorage();
      return;
    }

    const state = useStageStore.getState();
    const currentStage = state.stage;
    if (!currentStage) return;

    const baseOutline =
      state.outlines.find((outline) => outline.type === 'case') ?? state.outlines[0];
    if (!baseOutline) {
      log.warn('Cannot change the case: this stage has no outline to regenerate from');
      return;
    }

    setChangingCase(true);
    try {
      const wsSettings = useSettingsStore.getState();
      const wsProviderId = wsSettings.webSearchProviderId;
      const wsConfig = wsSettings.webSearchProvidersConfig?.[wsProviderId];
      // Gated on the same toggle that gates the generation flow's `case-search`
      // step (`getActiveSteps`), and for the same reason: with search off — or no
      // provider configured — the fan-out would only produce one error per
      // knowledge point, and the result (a case written without research) is what
      // happens either way. Two entry points disagreeing about when a case gets
      // sourced would be the confusing part.
      const outcome = wsSettings.webSearchEnabled
        ? await collectCaseResearch({
            knowledgePoints: baseOutline.keyPoints ?? [],
            search: createCaseWebSearchFn({
              providerId: wsProviderId,
              apiKey: wsConfig?.apiKey,
              baseUrl: wsConfig?.baseUrl,
              baiduSubSources: wsSettings.baiduSubSources,
              claudeModelId: wsConfig?.modelId,
            }),
          })
        : null;

      const nextOutline: SceneOutline = {
        ...baseOutline,
        caseConfig: {
          ...baseOutline.caseConfig,
          attempt: (baseOutline.caseConfig?.attempt ?? 0) + 1,
        },
      };

      const result = await fetchSceneContent({
        outline: nextOutline,
        allOutlines: [nextOutline],
        stageId,
        stageInfo: {
          name: currentStage.name,
          ...(currentStage.description ? { description: currentStage.description } : {}),
          ...(currentStage.style ? { style: currentStage.style } : {}),
        },
        ...(currentStage.languageDirective
          ? { languageDirective: currentStage.languageDirective }
          : {}),
        ...(outcome?.caseContext ? { caseContext: outcome.caseContext } : {}),
        ...(outcome && outcome.sources.length > 0 ? { caseSources: outcome.sources } : {}),
      });

      const generated = result.success ? caseContentFromGeneratedContent(result.content) : null;
      if (!generated) {
        log.warn('Case regeneration returned no usable content:', result.error);
        toast.error(t('case.changeCaseFailed'));
        return;
      }

      const store = useStageStore.getState();
      // Appended, not substituted. `mergeSceneContentForUpdate` replaces scene
      // content wholesale for every kind except PBL, so writing the bare
      // generated content back would drop the cases this cache exists to hold.
      // `appendVariant` adds the new case *and* mirrors it into the fields the
      // renderer reads, so the two never disagree.
      store.updateScene(sceneId, { content: appendVariant(content, toVariant(generated)) });
      // The attempt counter lives on the outline, and it has to go back through
      // `setOutlines` — `setStage` replaces the stage wholesale and would take
      // `scenes` with it. Same reasoning as the quiz "fresh set" path.
      store.setOutlines(
        store.outlines.map((outline) => (outline.id === baseOutline.id ? nextOutline : outline)),
      );
      await store.saveToStorage();
    } catch (error) {
      log.warn('Failed to change the case:', error);
      toast.error(t('case.changeCaseFailed'));
    } finally {
      setChangingCase(false);
    }
  }, [changingCase, content, sceneId, stageId, t]);

  // The analysis binds one entry per knowledge point, so a case without points
  // has nothing to analyse against — that request would be refused.
  const canAnalyse =
    !analysis && content.narrative.length > 0 && content.knowledgePoints.length > 0;
  const canChangeCase = content.narrative.length > 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10 sm:py-12">
          {/* Header */}
          <header className="border-b border-gray-200 pb-6 dark:border-gray-700">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                    <BookOpenText aria-hidden="true" className="size-3.5" />
                    {t('case.title')}
                  </div>
                  {showVariantBadge ? (
                    // Which of the cached cases is on screen. The swap button
                    // rotates instead of generating once three exist, and
                    // without this the learner cannot tell where in the set
                    // they are — or that there is a set at all.
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                      {t('case.variantBadge', {
                        index: activeIndex + 1,
                        total: variants.length,
                      })}
                    </span>
                  ) : null}
                </div>
                <h1 className="text-2xl font-semibold leading-snug text-gray-900 dark:text-gray-100">
                  {content.caseTitle}
                </h1>
                {content.summary ? (
                  <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                    {content.summary}
                  </p>
                ) : null}
              </div>
              {canChangeCase ? (
                <button
                  type="button"
                  onClick={handleChangeCase}
                  disabled={changingCase}
                  aria-label={t('case.changeCase')}
                  title={t('case.changeCase')}
                  className={cn(ACTION_BUTTON, 'shrink-0')}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn('size-3.5', changingCase && 'animate-spin')}
                  />
                  <span className="hidden sm:inline">
                    {changingCase ? t('case.changeCaseBusy') : t('case.changeCase')}
                  </span>
                </button>
              ) : null}
            </div>
          </header>

          {/* Knowledge points this case is built around */}
          {content.knowledgePoints.length > 0 ? (
            <section className="mt-6">
              <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <Tags aria-hidden="true" className="size-3.5" />
                {t('case.knowledgePoints')}
              </h2>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {content.knowledgePoints.map((point) => (
                  <li
                    key={point}
                    className="rounded-md bg-white px-2 py-1 text-xs text-gray-700 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-700"
                  >
                    {point}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Narrative */}
          <section className="mt-8 space-y-4">
            {paragraphs.map((paragraph, index) => (
              <p key={index} className="text-[15px] leading-[1.9] text-gray-800 dark:text-gray-200">
                {paragraph}
              </p>
            ))}
          </section>

          {/* Sources */}
          <section className="mt-8 border-t border-gray-200 pt-5 dark:border-gray-700">
            <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
              <Link2 aria-hidden="true" className="size-3.5" />
              {t('case.sources')}
            </h2>
            {sources.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {sources.map((source) => (
                  <li key={source.url} className="text-xs leading-relaxed">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-violet-600 underline decoration-violet-300 underline-offset-2 hover:text-violet-700 dark:text-violet-400"
                    >
                      {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              // Said out loud rather than left blank: a case with no citation is
              // written from the model's own knowledge, and a reader deciding how
              // much of it to trust needs to know that. An empty section would
              // read as "sources were not recorded" instead.
              <p className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                {t('case.noSources')}
              </p>
            )}
          </section>

          {/* Discussion questions */}
          {content.discussionQuestions.length > 0 ? (
            <section className="mt-8 border-t border-gray-200 pt-5 dark:border-gray-700">
              <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <HelpCircle aria-hidden="true" className="size-3.5" />
                {t('case.discussion')}
              </h2>
              <ol className="mt-3 space-y-4">
                {content.discussionQuestions.map((question, index) => (
                  <li key={question.id} className="flex gap-3">
                    <span
                      className={cn(
                        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                        'bg-gray-900 text-[11px] font-medium text-white',
                        'dark:bg-gray-100 dark:text-gray-900',
                      )}
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm leading-relaxed text-gray-800 dark:text-gray-200">
                        {question.question}
                      </p>
                      {question.point ? (
                        <span className="mt-1.5 inline-block rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                          {question.point}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {/* Analysis — revealed on request, collapsible once revealed, or the
              button that writes it */}
          {showAnalysis && analysis ? (
            <section className="mt-8 border-t border-gray-200 pt-5 dark:border-gray-700">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  {t('case.analysis')}
                </h2>
                {/* Same button as the one in the page header, on purpose: both
                    are "put this scene back a step", and a second style would
                    read as a second kind of action. */}
                <button
                  type="button"
                  onClick={handleToggleAnalysis}
                  aria-label={t('case.hideAnalysis')}
                  title={t('case.hideAnalysis')}
                  className={cn(ACTION_BUTTON, 'shrink-0')}
                >
                  <EyeOff aria-hidden="true" className="size-3.5" />
                  <span className="hidden sm:inline">{t('case.hideAnalysis')}</span>
                </button>
              </div>
              <dl className="mt-3 space-y-4">
                {analysis.entries.map((entry) => (
                  <div key={entry.point}>
                    <dt className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {entry.point}
                    </dt>
                    <dd className="mt-1 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                      {entry.bearing}
                    </dd>
                  </div>
                ))}
              </dl>
              {analysis.closing ? (
                <p className="mt-4 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                  {analysis.closing}
                </p>
              ) : null}
            </section>
          ) : canAnalyse || analysis ? (
            <section className="mt-8 border-t border-gray-200 pt-5 dark:border-gray-700">
              <button
                type="button"
                // With the analysis already written this only un-hides it; an
                // absent one is what actually needs the model.
                onClick={analysis ? handleToggleAnalysis : handleAnalyse}
                disabled={analysing}
                aria-label={t('case.analysisAction')}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white',
                  'transition-colors hover:bg-violet-700',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                {analysing ? (
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  <Sparkles aria-hidden="true" className="size-4" />
                )}
                {analysing ? t('case.analysisBusy') : t('case.analysisAction')}
              </button>
              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-gray-500">
                {t('case.analysisHint')}
              </p>
            </section>
          ) : null}
        </article>
      </div>
    </div>
  );
}
