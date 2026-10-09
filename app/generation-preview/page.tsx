'use client';

import { useEffect, useState, Suspense, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Sparkles, AlertCircle, AlertTriangle, ArrowLeft, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { OutlinesEditor } from '@/components/generation/outlines-editor';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  getEnabledProvidersWithVoices,
  resolveNarratorVoiceForGeneration,
} from '@/lib/audio/voice-resolver';
import { isQwenCloneVoice, resolveTTSModelForVoice } from '@/lib/audio/constants';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { useAllVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  fetchSceneActions,
  fetchSceneContent,
  generateTTSForScene,
  getApiHeaders,
  withThinkingConfig,
} from '@/lib/hooks/use-scene-generator';
import { isAbortError } from '@openmaic/generation/browser';
import { FOREGROUND_SCENE_RETRY_OPTIONS } from './foreground-retry';
import {
  loadImageMapping,
  loadDocumentBlob,
  cleanupOldImages,
  storeImages,
} from '@/lib/utils/image-storage';
import { resolveSessionDocumentSources } from '@/lib/document/session-sources';
import {
  fetchArchivedExtraction,
  type ArchivedExtraction,
  type ParsedDocumentResponseImage,
} from '@/lib/document/extraction-archive-client';
import { requestCourseMaterialExtraction } from '@/lib/document/extraction-stream-client';
import {
  forgetExtractionResume,
  recallExtractionResume,
  rememberExtractionResume,
} from '@/lib/document/extraction-resume-store';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
  buildDocumentBundle,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import { collectCaseResearch } from '@/lib/classroom/case-research';
import { createCaseWebSearchFn } from '@/lib/classroom/case-web-search';
import { nanoid } from 'nanoid';
import { COMPOSER_DRAFT_KEY, resetHomeComposer } from '@/lib/home/composer-reset';
import { setStageFolder } from '@/lib/utils/stage-storage';
import { toast } from 'sonner';
import type { GeneratedAgentConfig, Stage } from '@/lib/types/stage';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
} from '@/lib/types/generation';
import { AgentRevealModal } from '@/components/agent/agent-reveal-modal';
import { createLogger } from '@/lib/logger';
import {
  type GenerationSessionState,
  ALL_STEPS,
  getActiveSteps,
  getExtractionFailureKey,
  getExtractionProgressText,
  getGenerationStepText,
} from './types';
import { StepVisualizer } from './components/visualizers';
import { resolveTaskEngineModeFromOutlineDoneEvent } from './vocational-mode';

const log = createLogger('GenerationPreview');
const OUTLINE_REVIEW_AUTO_CONTINUE_MS = 2500;

/** Provider configuration a source may carry to the extraction route. */
type SourceProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
};

function validateDocumentSources(
  sources: SessionDocumentSource[],
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  if (sources.length > MAX_DOCUMENT_BUNDLE_FILES) {
    throw new Error(t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES }));
  }

  const totalSize = sources.reduce((sum, source) => sum + source.size, 0);
  if (totalSize > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
    throw new Error(
      t('upload.courseMaterialTotalSizeLimit', {
        n: Math.floor(MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES / 1024 / 1024),
      }),
    );
  }
}

type SceneGenerationFailure = {
  error?: string;
  errorCode?: string;
  statusCode?: number;
};

function GenerationPreviewContent() {
  const router = useRouter();
  const { t } = useI18n();
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const outlineReviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outlineReviewResolveRef = useRef<((outlines: SceneOutline[]) => void) | null>(null);
  // Sticky flag: true once the user signals review intent (either by clicking the
  // streaming card mid-stream, or by restoring a session that was already in review).
  // Combined with `reviewOutlineEnabled` to decide whether the post-stream timer fires.
  const outlineReviewIntentRef = useRef(false);
  const { profiles: voiceProfiles } = useAllVoiceProfiles();

  const [session, setSession] = useState<GenerationSessionState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isComplete] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [streamingOutlines, setStreamingOutlines] = useState<SceneOutline[] | null>(null);
  const [isOutlineStreaming, setIsOutlineStreaming] = useState(false);
  const [truncationWarnings, setTruncationWarnings] = useState<string[]>([]);
  const [webSearchSources, setWebSearchSources] = useState<Array<{ title: string; url: string }>>(
    [],
  );
  const [caseResearchSources, setCaseResearchSources] = useState<
    Array<{ title: string; url: string }>
  >([]);
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  const [isConfirmingOutlines, setIsConfirmingOutlines] = useState(false);
  const [generatedAgents, setGeneratedAgents] = useState<
    Array<{
      id: string;
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      priority: number;
    }>
  >([]);
  const agentRevealResolveRef = useRef<(() => void) | null>(null);
  const reviewOutlineEnabled = useSettingsStore((s) => s.reviewOutlineEnabled);
  const setReviewOutlineEnabled = useSettingsStore((s) => s.setReviewOutlineEnabled);

  // Compute active steps based on session state
  const activeSteps = getActiveSteps(session);
  const isOutlineReady = session?.previewPhase === 'outline-ready';
  const isReviewingOutlines = session?.previewPhase === 'review';

  const sceneGenerationErrorMessage = (failure: SceneGenerationFailure): string => {
    if (
      failure.errorCode === 'MISSING_API_KEY' ||
      failure.statusCode === 401 ||
      failure.statusCode === 403
    ) {
      return t('generation.sceneGenerateAuthFailed');
    }

    if (failure.errorCode === 'RATE_LIMITED' || failure.statusCode === 429) {
      return t('generation.sceneGenerateRateLimited');
    }

    if (failure.errorCode === 'UPSTREAM_ERROR' && failure.statusCode && failure.statusCode >= 500) {
      return t('generation.sceneGenerateProviderUnavailable');
    }

    if (failure.errorCode === 'INTERNAL_ERROR') {
      return t('generation.sceneGenerateFailed');
    }

    if (failure.errorCode === 'GENERATION_FAILED') {
      return t('generation.sceneGenerateInvalidResponse');
    }

    return failure.error || t('generation.sceneGenerateFailed');
  };

  const persistSession = (nextSession: GenerationSessionState) => {
    setSession(nextSession);
    sessionStorage.setItem('generationSession', JSON.stringify(nextSession));
  };

  const clearOutlineReviewTimer = () => {
    if (outlineReviewTimerRef.current) {
      clearTimeout(outlineReviewTimerRef.current);
      outlineReviewTimerRef.current = null;
    }
  };

  const waitForOutlineReviewChoice = (
    outlines: SceneOutline[],
    shouldReview: boolean,
    signal: AbortSignal,
  ): Promise<SceneOutline[]> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      outlineReviewResolveRef.current = resolve;
      // Reject on abort so navigating away (`goBackToHome`) or unmounting
      // settles this promise instead of leaking the awaiting startGeneration
      // closure. The catch at the bottom of startGeneration already swallows
      // AbortError silently.
      const onAbort = () => {
        clearOutlineReviewTimer();
        outlineReviewResolveRef.current = null;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (!shouldReview) {
        outlineReviewTimerRef.current = setTimeout(() => {
          outlineReviewTimerRef.current = null;
          outlineReviewResolveRef.current = null;
          signal.removeEventListener('abort', onAbort);
          resolve(outlines);
        }, OUTLINE_REVIEW_AUTO_CONTINUE_MS);
      }
    });

  // Load session from sessionStorage
  useEffect(() => {
    cleanupOldImages(24).catch((e) => log.error(e));

    const saved = sessionStorage.getItem('generationSession');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as GenerationSessionState;
        if (!parsed.previewPhase) {
          parsed.previewPhase = parsed.sceneOutlines?.length ? 'outline-ready' : 'preparing';
        }
        // Restore review intent: a saved 'review' phase without outlines means the user
        // had opened the editor mid-stream before the refresh — preserve that intent so
        // the post-stream auto-continue timer doesn't fire after SSE restart.
        if (parsed.previewPhase === 'review' && !parsed.sceneOutlines?.length) {
          outlineReviewIntentRef.current = true;
        }
        parsed.taskEngineMode = parsed.taskEngineMode === true;
        setSession(parsed);
      } catch (e) {
        log.error('Failed to parse generation session:', e);
      }
    }
    setSessionLoaded(true);
  }, []);

  // Abort all in-flight requests on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      clearOutlineReviewTimer();
    };
  }, []);

  // Auto-start generation when session is loaded
  useEffect(() => {
    if (!session || hasStartedRef.current) return;
    const needsOutlines = !session.sceneOutlines || session.sceneOutlines.length === 0;
    const phase = session.previewPhase;
    const shouldAutoStart =
      !phase ||
      phase === 'preparing' ||
      phase === 'generating-content' ||
      // Refresh during early-review: editor is shown but outlines weren't persisted,
      // so kick off SSE again — the editor will receive streaming outlines.
      (phase === 'review' && needsOutlines);
    if (shouldAutoStart) {
      hasStartedRef.current = true;
      startGeneration();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Main generation flow
  const startGeneration = async (sessionOverride?: GenerationSessionState) => {
    const generationSession = sessionOverride ?? session;
    if (!generationSession) return;

    // Create AbortController for this generation run
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    // Use a local mutable copy so we can update it after document extraction
    let currentSession = generationSession;

    setError(null);
    setCurrentStepIndex(0);

    try {
      // Compute active steps for this session (recomputed after session mutations)
      let activeSteps = getActiveSteps(currentSession);

      // Determine if we need the document analysis step
      const documentSources = resolveSessionDocumentSources(currentSession);
      const hasPdfToAnalyze = documentSources.length > 0 && !currentSession.pdfText;
      // If no document to analyze, skip to the next available step
      if (!hasPdfToAnalyze) {
        const firstNonPdfIdx = activeSteps.findIndex((s) => s.id !== 'pdf-analysis');
        setCurrentStepIndex(Math.max(0, firstNonPdfIdx));
      }

      // Step 0: Extract uploaded course material if needed
      if (hasPdfToAnalyze) {
        log.debug('=== Generation Preview: Extracting course material bundle ===');
        validateDocumentSources(documentSources, t);
        const sortedDocumentSources = [...documentSources].sort((a, b) => a.order - b.order);
        /**
         * The extracted content of one source, from whichever of the two
         * places this device can reach.
         *
         * **The bytes** (this device's IndexedDB) are the preferred source, and
         * the only one that can run a fresh parse: they are what the chapter
         * directory stores locally, and a chapter uploaded on this device
         * always has them.
         *
         * **The archive** (the server, keyed by `contentDigest`) is the
         * fallback for a chapter restored from the synced directory on a
         * device that never held its bytes. Without it such a chapter could be
         * listed but not generated from, because a parse needs bytes and there
         * are none; with it, the extraction paid for on the other device is
         * reused and the chapter generates with no re-upload. The bytes and
         * the digest name the same content (`lib/document/content-digest.ts`),
         * so the two sources cannot disagree about *what* was parsed — only
         * about which device paid for it.
         */
        const parseSource = async (
          source: SessionDocumentSource,
        ): Promise<{ providerId: string | undefined; parseData: ArchivedExtraction }> => {
          const providerId = source.providerId || currentSession.pdfProviderId;
          const legacySourceConfig = (
            source as SessionDocumentSource & {
              providerConfig?: SourceProviderConfig;
            }
          ).providerConfig;
          const providerConfig = currentSession.pdfProviderConfig || legacySourceConfig;

          const documentBlob = await loadDocumentBlob(source.storageKey);
          if (documentBlob instanceof Blob && documentBlob.size > 0) {
            const documentFile = new File([documentBlob], source.name || 'document.pdf', {
              type: source.mimeType || documentBlob.type || 'application/pdf',
            });
            const parseFormData = new FormData();
            parseFormData.append('file', documentFile);
            if (providerId) parseFormData.append('providerId', providerId);
            if (providerConfig?.apiKey?.trim())
              parseFormData.append('apiKey', providerConfig.apiKey);
            if (providerConfig?.baseUrl?.trim())
              parseFormData.append('baseUrl', providerConfig.baseUrl);
            if (providerConfig?.accessKeyId?.trim()) {
              parseFormData.append('accessKeyId', providerConfig.accessKeyId);
            }
            if (providerConfig?.accessKeySecret?.trim()) {
              parseFormData.append('accessKeySecret', providerConfig.accessKeySecret);
            }
            // A handle an earlier attempt left behind means these exact bytes
            // are already queued on *that extractor's* side. Handing it back
            // picks that job up instead of paying for a second parse of the
            // same file; a handle belonging to another extractor is not ours to
            // hand back, and the store will not release it.
            const resumeToken = recallExtractionResume(source.contentDigest, providerId);
            if (resumeToken) {
              parseFormData.append('resumeToken', resumeToken);
              setStatusMessage(
                t('generation.courseMaterialExtractResuming', { name: source.name }),
              );
            }

            const outcome = await requestCourseMaterialExtraction(parseFormData, {
              signal,
              onProgress: (progress) => {
                const { key, values } = getExtractionProgressText(source.name, progress);
                setStatusMessage(t(key, values));
              },
            });
            if (outcome.status === 'failed') {
              // Keep the handle for the next attempt so a retry can resume this
              // job; drop it when the server named no job to resume, because
              // then the remembered one is certainly dead. Either way the
              // message is chosen from the classified kind, never from the
              // server's own unlocalized prose.
              if (outcome.resumeToken) {
                rememberExtractionResume(source.contentDigest, outcome.resumeToken, providerId);
              } else {
                forgetExtractionResume(source.contentDigest);
              }
              throw new Error(t(getExtractionFailureKey(outcome.kind)));
            }
            forgetExtractionResume(source.contentDigest);
            return { providerId, parseData: outcome.data };
          }

          // No bytes here. A source without a digest has nothing to look up —
          // either it was uploaded before the directory carried digests, or
          // this browser cannot compute one (no secure context). Both are the
          // old "select the file again" case.
          if (!source.contentDigest) {
            throw new Error(t('generation.courseMaterialLoadFailed'));
          }
          const archived = await fetchArchivedExtraction({
            contentDigest: source.contentDigest,
            ...(providerId ? { extractorId: providerId } : {}),
            signal,
          });
          if (!archived) {
            // Actionable on purpose: retrying the same request cannot help, and
            // the archive cannot say *why* it has nothing (never archived, or
            // pruned). Re-uploading the file is the one fix that always works.
            throw new Error(t('generation.courseMaterialNotArchived', { name: source.name }));
          }
          const archivedExtractor = archived.metadata?.extractionCache?.extractorId;
          // The server prefers the requested extractor and falls back to the
          // newest non-empty derivation (see `selectArchivedExtraction`), so a
          // different id here is expected when this device's settings differ
          // from the uploading device's. Worth logging because it changes the
          // text, not just where the text came from.
          log.debug(
            `"${source.name}": no bytes on this device; using the archived extraction ` +
              `(${archivedExtractor ?? 'unknown'})` +
              (archivedExtractor && providerId && archivedExtractor !== providerId
                ? `, not the selected ${providerId}`
                : ''),
          );
          return { providerId, parseData: archived };
        };

        const parsedParts = await Promise.all(
          sortedDocumentSources.map(async (source): Promise<ParsedDocumentPart> => {
            const { providerId, parseData } = await parseSource(source);
            const rawImages = parseData.metadata?.pdfImages;
            const images = rawImages
              ? rawImages.map((img: ParsedDocumentResponseImage) => ({
                  id: img.id,
                  src: img.src || '',
                  pageNumber: img.pageNumber ?? 1,
                  description: img.description,
                  width: img.width,
                  height: img.height,
                }))
              : ((parseData.images as string[] | undefined) ?? []).map((src, i) => ({
                  id: `img_${i + 1}`,
                  src,
                  pageNumber: 1,
                }));

            return {
              source: {
                id: source.id,
                name: source.name,
                size: source.size,
                lastModified: source.lastModified,
                mimeType: source.mimeType,
                order: source.order,
                providerId,
                // Carried through so the bundle keeps naming the derivation the
                // source bytes correspond to (the digest computed at upload).
                ...(source.contentDigest ? { contentDigest: source.contentDigest } : {}),
              },
              text: parseData.text,
              rawTextLength: parseData.text.length,
              pageCount: parseData.metadata?.pageCount,
              images,
            };
          }),
        );

        const bundle = buildDocumentBundle(parsedParts);
        const imageStorageIds = await storeImages(bundle.images);

        const pdfImages: PdfImage[] = bundle.images.map((img, i) => ({
          id: img.id,
          src: '',
          pageNumber: img.pageNumber,
          description: img.description,
          width: img.width,
          height: img.height,
          originalId: img.originalId,
          sourceDocumentId: img.sourceDocumentId,
          sourceDocumentName: img.sourceDocumentName,
          sourceDocumentOrder: img.sourceDocumentOrder,
          visionPriority: img.visionPriority,
          storageId: imageStorageIds[i],
        }));

        // Update session with extracted document data
        const updatedSession = {
          ...currentSession,
          documentSources,
          pdfText: bundle.text,
          pdfImages,
          imageStorageIds,
          pdfStorageKey: undefined, // Clear so we don't re-parse
        };
        setSession(updatedSession);
        sessionStorage.setItem('generationSession', JSON.stringify(updatedSession));

        // Truncation warnings
        const warnings: string[] = [];
        if (bundle.totalRawTextLength > bundle.textContentBudget) {
          warnings.push(t('generation.textTruncated', { n: bundle.textContentBudget }));
        }
        if (bundle.totalImageCount > MAX_VISION_IMAGES) {
          warnings.push(
            t('generation.imageTruncated', {
              total: bundle.totalImageCount,
              max: MAX_VISION_IMAGES,
            }),
          );
        }
        if (warnings.length > 0) {
          setTruncationWarnings(warnings);
        }

        // The extraction's progress line has served its purpose: the next step
        // either sets its own or falls back to the step's description.
        setStatusMessage('');

        // Reassign local reference for subsequent steps
        currentSession = updatedSession;
        activeSteps = getActiveSteps(currentSession);
      }

      // ── An extract-only session stops here ──
      // These materials already belong to a classroom (matched by its
      // `sourceDigests`); the file was re-uploaded to fill in the derivation
      // the classroom's chapters need, not to build a second course from the
      // same material. Step 0 above is the whole job — the extract route
      // archives the derivation as a side effect — so hand back to the
      // classroom it belongs to and write nothing: no stage, no outline, no
      // scene, no `store.saveToStorage()`.
      if (currentSession.extractOnly) {
        const target = currentSession.targetStageId;
        sessionStorage.removeItem('generationSession');
        // The home page always sets a target; a session without one is
        // corrupt, and the home page is the only safe place to fall back to.
        router.replace(target ? `/classroom/${target}` : '/');
        return;
      }

      // Step: Web Search (if enabled)
      const webSearchStepIdx = activeSteps.findIndex((s) => s.id === 'web-search');
      if (currentSession.requirements.webSearch && webSearchStepIdx >= 0) {
        setCurrentStepIndex(webSearchStepIdx);
        setWebSearchSources([]);

        const wsSettings = useSettingsStore.getState();
        const wsProviderId = wsSettings.webSearchProviderId;
        const wsConfig = wsSettings.webSearchProvidersConfig?.[wsProviderId];
        const res = await fetch('/api/web-search', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(
            withThinkingConfig({
              query: currentSession.requirements.requirement,
              pdfText: currentSession.pdfText || undefined,
              providerId: wsProviderId,
              apiKey: wsConfig?.apiKey || undefined,
              baseUrl: wsProviderId === 'searxng' ? undefined : wsConfig?.baseUrl || undefined,
              baiduSubSources: wsProviderId === 'baidu' ? wsSettings.baiduSubSources : undefined,
              claudeModelId: wsProviderId === 'claude' ? wsConfig?.modelId || undefined : undefined,
            }),
          ),
          signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Web search failed' }));
          throw new Error(data.error || t('generation.webSearchFailed'));
        }

        const searchData = await res.json();
        const sources = (searchData.sources || []).map((s: { title: string; url: string }) => ({
          title: s.title,
          url: s.url,
        }));
        setWebSearchSources(sources);

        const updatedSessionWithSearch = {
          ...currentSession,
          researchContext: searchData.context || '',
          researchSources: sources,
        };
        setSession(updatedSessionWithSearch);
        sessionStorage.setItem('generationSession', JSON.stringify(updatedSessionWithSearch));
        currentSession = updatedSessionWithSearch;
        activeSteps = getActiveSteps(currentSession);
      }

      // Load imageMapping early (needed for both outline and scene generation).
      let imageMapping: ImageMapping = {};
      if (currentSession.imageStorageIds && currentSession.imageStorageIds.length > 0) {
        log.debug('Loading images from IndexedDB');
        imageMapping = await loadImageMapping(currentSession.imageStorageIds);
      } else if (
        currentSession.imageMapping &&
        Object.keys(currentSession.imageMapping).length > 0
      ) {
        log.debug('Using imageMapping from session (old format)');
        imageMapping = currentSession.imageMapping;
      }

      // Create stage client-side
      const stageId = nanoid(10);
      // Which materials this classroom was built from, in bundle order, taken
      // from the same sources Step 0 just parsed. Written once, at creation: it
      // is the only record of the link — the extraction archive is keyed by
      // `(bytes, extractor)` and knows nothing about classrooms — and it is what
      // lets a later re-upload of the same file find this classroom instead of
      // producing a second one from identical material. Omitted entirely when no
      // source carries a digest (a legacy session, or a browser that could not
      // compute one): an empty list would claim the classroom came from nothing.
      const sourceDigests = [
        ...new Set(
          documentSources
            .map((source) => source.contentDigest)
            .filter((digest): digest is string => typeof digest === 'string' && digest.length > 0),
        ),
      ];
      const stage: Stage = {
        id: stageId,
        name: extractTopicFromRequirement(currentSession.requirements.requirement),
        description: '',
        style: 'professional',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        interactiveMode: !!currentSession.requirements.interactiveMode,
        taskEngineMode: currentSession.taskEngineMode === true,
        ...(sourceDigests.length > 0 ? { sourceDigests } : {}),
        // Which kind of lesson this is. It has to be recorded here rather than
        // inferred later: a single-chapter lesson carries the *same*
        // `sourceDigests` as the teaching classroom built from the same
        // material, so this field is the only thing that lets the home page
        // reopen the right one. `'lesson'` is the default and is never stamped
        // — absent already reads as an ordinary teaching classroom, and writing
        // it would rewrite every course generated before this field existed.
        ...(currentSession.requirements.lessonKind &&
        currentSession.requirements.lessonKind !== 'lesson'
          ? { lessonKind: currentSession.requirements.lessonKind }
          : {}),
      };

      // ── Generate outlines first (infers languageDirective) ──
      let outlines = currentSession.sceneOutlines;
      let languageDirective = currentSession.languageDirective;
      let courseTitle = currentSession.courseTitle;
      /**
       * Case-teaching research, gathered once the knowledge points exist.
       *
       * Kept in local scope rather than on the session: unlike `researchContext`
       * (which is produced before the outline request and read by it, so it has
       * to survive a resume), this is consumed by a single later request in the
       * same run. A resumed session simply researches again, which is cheaper
       * than persisting a large text blob the next run would have to invalidate
       * when the knowledge points change.
       */
      let caseContext: string | undefined;
      let caseSources: Array<{ title: string; url: string }> | undefined;

      const outlineStepIdx = activeSteps.findIndex((s) => s.id === 'outline');
      setCurrentStepIndex(outlineStepIdx >= 0 ? outlineStepIdx : 0);
      if (!outlines || outlines.length === 0) {
        log.debug('=== Generating outlines (SSE) ===');
        setStreamingOutlines([]);
        setIsOutlineStreaming(true);

        const outlineResult = await new Promise<{
          outlines: SceneOutline[];
          languageDirective: string;
          courseTitle?: string;
          taskEngineMode: boolean;
        }>((resolve, reject) => {
          const collected: SceneOutline[] = [];
          let directive: string | undefined;
          let title: string | undefined;

          fetch('/api/generate/scene-outlines-stream', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                requirements: currentSession.requirements,
                pdfText: currentSession.pdfText,
                pdfImages: currentSession.pdfImages,
                imageMapping,
                researchContext: currentSession.researchContext,
              }),
            ),
            signal,
          })
            .then((res) => {
              if (!res.ok) {
                return res.json().then((d) => {
                  reject(new Error(d.error || t('generation.outlineGenerateFailed')));
                });
              }

              const reader = res.body?.getReader();
              if (!reader) {
                reject(new Error(t('generation.streamNotReadable')));
                return;
              }

              const decoder = new TextDecoder();
              let sseBuffer = '';

              const pump = (): Promise<void> =>
                reader.read().then(({ done, value }) => {
                  if (value) {
                    sseBuffer += decoder.decode(value, { stream: !done });
                    const lines = sseBuffer.split('\n');
                    sseBuffer = lines.pop() || '';

                    for (const line of lines) {
                      if (!line.startsWith('data: ')) continue;
                      try {
                        const evt = JSON.parse(line.slice(6));
                        if (evt.type === 'languageDirective') {
                          directive = evt.data;
                        } else if (evt.type === 'courseTitle') {
                          title = evt.data;
                        } else if (evt.type === 'outline') {
                          collected.push(evt.data);
                          setStreamingOutlines([...collected]);
                        } else if (evt.type === 'retry') {
                          collected.length = 0;
                          // Drop any directive/title latched from the failed
                          // attempt — the server resets these per attempt, so a
                          // succeeding attempt that omits them must fall back, not
                          // inherit the previous attempt's stale values.
                          directive = undefined;
                          title = undefined;
                          setStreamingOutlines([]);
                          setStatusMessage(t('generation.outlineRetrying'));
                        } else if (evt.type === 'done') {
                          directive = evt.languageDirective || directive;
                          resolve({
                            outlines: evt.outlines || collected,
                            languageDirective:
                              directive ||
                              'Teach in the language that matches the user requirement.',
                            courseTitle: evt.courseTitle || title,
                            taskEngineMode: resolveTaskEngineModeFromOutlineDoneEvent(evt),
                          });
                          return;
                        } else if (evt.type === 'error') {
                          reject(new Error(evt.error));
                          return;
                        }
                      } catch (e) {
                        log.error('Failed to parse outline SSE:', line, e);
                      }
                    }
                  }
                  if (done) {
                    if (collected.length > 0) {
                      resolve({
                        outlines: collected,
                        languageDirective:
                          directive || 'Teach in the language that matches the user requirement.',
                        // Carry any title latched from a streaming `courseTitle`
                        // event here too — symmetric with languageDirective — so
                        // a stream that ends without an explicit `done` event
                        // does not silently drop a valid inferred title.
                        courseTitle: title,
                        taskEngineMode: false,
                      });
                    } else {
                      reject(new Error(t('generation.outlineEmptyResponse')));
                    }
                    return;
                  }
                  return pump();
                });

              pump().catch(reject);
            })
            .catch(reject);
        });

        outlines = outlineResult.outlines;
        languageDirective = outlineResult.languageDirective;
        courseTitle = outlineResult.courseTitle;
        const effectiveTaskEngineMode = outlineResult.taskEngineMode;
        setIsOutlineStreaming(false);

        // Mid-stream review intent (sticky ref) overrides the auto-continue timer.
        const userOpenedReviewEarly = outlineReviewIntentRef.current;
        const shouldReviewOutlines =
          useSettingsStore.getState().reviewOutlineEnabled || userOpenedReviewEarly;
        const updatedSession: GenerationSessionState = {
          ...currentSession,
          sceneOutlines: outlines,
          languageDirective,
          courseTitle,
          taskEngineMode: effectiveTaskEngineMode,
          previewPhase: shouldReviewOutlines ? 'review' : 'outline-ready',
        };
        persistSession(updatedSession);
        currentSession = updatedSession;
        setStreamingOutlines(outlines);

        setStatusMessage(shouldReviewOutlines ? '' : t('generation.reviewOutlineAutoContinue'));
        setIsConfirmingOutlines(false);
        outlines = await waitForOutlineReviewChoice(outlines, shouldReviewOutlines, signal);
        clearOutlineReviewTimer();
        currentSession = {
          ...currentSession,
          sceneOutlines: outlines,
          taskEngineMode: effectiveTaskEngineMode,
          previewPhase: 'generating-content',
        };
        persistSession(currentSession);

        // User has committed to course generation (either by confirming the
        // outline review or by letting the auto-continue timer fire). Now it's
        // safe to wipe the homepage draft cache; before this point, "back to
        // requirements" must restore the user's original input.
        try {
          localStorage.removeItem(COMPOSER_DRAFT_KEY);
        } catch {
          /* ignore */
        }
      }

      // Move to next step
      setStatusMessage('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }
      stage.taskEngineMode = currentSession.taskEngineMode === true;

      // Store languageDirective on the stage
      if (languageDirective) {
        stage.languageDirective = languageDirective;
      }

      // Adopt the LLM-inferred course title as the stage name when available,
      // replacing the raw-requirement placeholder set at stage creation time.
      if (courseTitle) {
        stage.name = courseTitle;
      }

      // ── Case research (case teaching only, after outlines) ──
      //
      // A case study has to be a real event, and a model asked to recall one
      // produces confident fiction. So the search runs here — after the outline
      // has fixed the knowledge points, before the case is written — and the
      // content step is handed what the search actually returned.
      //
      // This sits after the outline rather than alongside the `web-search` step
      // because the queries ARE the knowledge points: searching the raw
      // requirement would return material for the chapter's topic in general,
      // which is exactly the "illustrates the theme without teaching the points"
      // case the outline step exists to prevent.
      //
      // Every failure here degrades to "no research": the case is then written
      // from well-documented events and the learner is told the material was not
      // drawn from verified reporting. Research must never be the reason a
      // classroom fails to generate.
      const caseSearchStepIdx = activeSteps.findIndex((s) => s.id === 'case-search');
      if (caseSearchStepIdx >= 0) {
        setCurrentStepIndex(caseSearchStepIdx);
        setStatusMessage(t('generation.caseResearching'));
        setCaseResearchSources([]);

        try {
          const wsSettings = useSettingsStore.getState();
          const wsProviderId = wsSettings.webSearchProviderId;
          const wsConfig = wsSettings.webSearchProvidersConfig?.[wsProviderId];

          // Pages shown as they arrive rather than after the slowest query: the
          // step indicator is the user's only signal that six searches are
          // progressing rather than one hanging request.
          const outcome = await collectCaseResearch({
            knowledgePoints: outlines[0]?.keyPoints ?? [],
            search: createCaseWebSearchFn(
              {
                providerId: wsProviderId,
                apiKey: wsConfig?.apiKey,
                baseUrl: wsConfig?.baseUrl,
                baiduSubSources: wsSettings.baiduSubSources,
                claudeModelId: wsConfig?.modelId,
              },
              { signal, onSources: setCaseResearchSources },
            ),
          });

          caseContext = outcome.caseContext || undefined;
          caseSources = outcome.sources.length > 0 ? outcome.sources : undefined;
          setCaseResearchSources(outcome.sources);
          log.info(
            `Case research: ${outcome.answeredPoints}/${outcome.searchedPoints} knowledge point(s) returned material, ${outcome.sources.length} source(s)`,
          );
        } catch (err: unknown) {
          // `collectCaseResearch` already absorbs per-query failures, so
          // reaching here means the fan-out itself broke (most likely an abort).
          log.warn('[Generation] Case research failed, generating without it:', err);
          caseContext = undefined;
          caseSources = undefined;
        }
      }

      // ── Agent generation (after outlines — uses languageDirective + outlines) ──
      const settings = useSettingsStore.getState();
      let agents: Array<{
        id: string;
        name: string;
        role: string;
        persona?: string;
      }> = [];

      if (settings.agentMode === 'auto') {
        const agentStepIdx = activeSteps.findIndex((s) => s.id === 'agent-generation');
        if (agentStepIdx >= 0) setCurrentStepIndex(agentStepIdx);

        try {
          const allAvatars = [
            {
              path: '/avatars/teacher.png',
              desc: 'Male teacher with glasses, holding a book, green background',
            },
            {
              path: '/avatars/teacher-2.png',
              desc: 'Female teacher with long dark hair, blue traditional outfit, gentle expression',
            },
            {
              path: '/avatars/assist.png',
              desc: 'Young female assistant with glasses, pink background, friendly smile',
            },
            {
              path: '/avatars/assist-2.png',
              desc: 'Young female in orange top and purple overalls, cheerful and approachable',
            },
            {
              path: '/avatars/clown.png',
              desc: 'Energetic girl with glasses pointing up, green shirt, lively and fun',
            },
            {
              path: '/avatars/clown-2.png',
              desc: 'Playful girl with curly hair doing rock gesture, blue shirt, humorous vibe',
            },
            {
              path: '/avatars/curious.png',
              desc: 'Surprised boy with glasses, hand on cheek, curious expression',
            },
            {
              path: '/avatars/curious-2.png',
              desc: 'Boy with backpack holding a book and question mark bubble, inquisitive',
            },
            {
              path: '/avatars/note-taker.png',
              desc: 'Studious boy with glasses, blue shirt, calm and organized',
            },
            {
              path: '/avatars/note-taker-2.png',
              desc: 'Active boy with yellow backpack waving, blue outfit, enthusiastic learner',
            },
            {
              path: '/avatars/thinker.png',
              desc: 'Thoughtful girl with hand on chin, purple background, contemplative',
            },
            {
              path: '/avatars/thinker-2.png',
              desc: 'Girl reading a book intently, long dark hair, intellectual and focused',
            },
          ];

          const getAvailableVoicesForGeneration = () => {
            const providers = getEnabledProvidersWithVoices(
              settings.ttsProvidersConfig,
              voiceProfiles,
            );
            return providers.flatMap((p) =>
              p.voices.map((v) => {
                const cloneModelGroup =
                  p.providerId === 'qwen-tts' && isQwenCloneVoice(v.id)
                    ? p.modelGroups.find((group) =>
                        group.voices.some((groupVoice) => groupVoice.id === v.id),
                      )
                    : undefined;
                const modelId = cloneModelGroup
                  ? resolveTTSModelForVoice(p.providerId, v.id, cloneModelGroup.modelId)
                  : undefined;
                return {
                  providerId: p.providerId,
                  ...(modelId ? { modelId } : {}),
                  voiceId: v.id,
                  voiceName: v.name,
                  voiceLanguage: v.language,
                };
              }),
            );
          };

          // The user's global TTS voice is the narrator voice. Pass it along so
          // the server pins the teacher agent to it instead of letting the LLM
          // pick a different voice. Reuse the same resolution helpers as the
          // advertised list: the model follows the voice, and only clones carry
          // a model on the wire. An unusable global voice (disabled/unconfigured
          // provider) is NOT pinned — the LLM then picks a working advertised
          // voice and the narration fallback machinery stays alive.
          const getNarratorVoiceForGeneration = () =>
            resolveNarratorVoiceForGeneration(
              settings.ttsProviderId,
              settings.ttsVoice,
              settings.ttsProvidersConfig[settings.ttsProviderId],
            );

          const agentResp = await fetch('/api/generate/agent-profiles', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                stageInfo: { name: stage.name, description: stage.description },
                sceneOutlines: outlines.map((o) => ({
                  title: o.title,
                  description: o.description,
                })),
                languageDirective,
                availableAvatars: allAvatars.map((a) => a.path),
                avatarDescriptions: allAvatars.map((a) => ({ path: a.path, desc: a.desc })),
                availableVoices: getAvailableVoicesForGeneration(),
                narratorVoice: getNarratorVoiceForGeneration(),
              }),
            ),
            signal,
          });

          if (!agentResp.ok) throw new Error('Agent generation failed');
          const agentData = await agentResp.json();
          if (!agentData.success) throw new Error(agentData.error || 'Agent generation failed');

          // Embed the roster (including its voice binding) on the stage — it
          // persists with the stage document via saveToStorage below — and
          // mirror it into the in-memory registry. The agent-profile LLM has
          // already bound each agent's voice (from availableVoices); the
          // fallback for an invalid/unavailable voice is applied later at the
          // live TTS call.
          const generatedConfigs = agentData.agents as GeneratedAgentConfig[];
          stage.generatedAgentConfigs = generatedConfigs;
          const { applyGeneratedAgentsToRegistry } =
            await import('@/lib/orchestration/registry/store');
          const savedIds = applyGeneratedAgentsToRegistry(stage.id, generatedConfigs);
          settings.setSelectedAgentIds(savedIds);
          // Stage-derived, not a user choice — must not carry across classrooms.
          settings.setAgentSelectionIsUserSet(false);
          stage.agentIds = savedIds;

          // Show card-reveal modal, continue generation once all cards are revealed
          setGeneratedAgents(agentData.agents);
          setShowAgentReveal(true);
          await new Promise<void>((resolve) => {
            agentRevealResolveRef.current = resolve;
          });

          agents = savedIds
            .map((id) => useAgentRegistry.getState().getAgent(id))
            .filter(Boolean)
            .map((a) => ({
              id: a!.id,
              name: a!.name,
              role: a!.role,
              persona: a!.persona,
            }));
        } catch (err: unknown) {
          log.warn('[Generation] Agent generation failed, falling back to presets:', err);
          const registry = useAgentRegistry.getState();
          const fallbackIds = settings.selectedAgentIds.filter((id) => {
            const a = registry.getAgent(id);
            return a && !a.isGenerated;
          });
          agents = fallbackIds
            .map((id) => registry.getAgent(id))
            .filter(Boolean)
            .map((a) => ({
              id: a!.id,
              name: a!.name,
              role: a!.role,
              persona: a!.persona,
            }));
          stage.agentIds = fallbackIds;
        }
      } else {
        // Preset mode — use selected agents (include persona)
        // Filter out stale generated agent IDs that may linger in settings
        const registry = useAgentRegistry.getState();
        const presetAgentIds = settings.selectedAgentIds.filter((id) => {
          const a = registry.getAgent(id);
          return a && !a.isGenerated;
        });
        agents = presetAgentIds
          .map((id) => registry.getAgent(id))
          .filter(Boolean)
          .map((a) => ({
            id: a!.id,
            name: a!.name,
            role: a!.role,
            persona: a!.persona,
          }));
        stage.agentIds = presetAgentIds;
      }

      // Move to scene generation step
      setStatusMessage('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }

      // Store stage and outlines
      const store = useStageStore.getState();
      stage.videoManifest = buildVideoManifestFromOutlines(outlines);
      store.setStage(stage);
      store.setOutlines(outlines);

      // Advance to slide-content step
      const contentStepIdx = activeSteps.findIndex((s) => s.id === 'slide-content');
      if (contentStepIdx >= 0) setCurrentStepIndex(contentStepIdx);

      // Build stageInfo and userProfile for API call
      const stageInfo = {
        name: stage.name,
        description: stage.description,
        style: stage.style,
      };

      const userProfile =
        currentSession.requirements.userNickname || currentSession.requirements.userBio
          ? `Student: ${currentSession.requirements.userNickname || 'Unknown'}${currentSession.requirements.userBio ? ` — ${currentSession.requirements.userBio}` : ''}`
          : undefined;

      // Generate ONLY the first scene
      store.setGeneratingOutlines(outlines);

      const firstOutline = outlines[0];

      // Step 2: Generate content (currentStepIndex is already 2)
      const contentData = await fetchSceneContent(
        {
          outline: firstOutline,
          allOutlines: outlines,
          pdfImages: currentSession.pdfImages,
          imageMapping,
          stageInfo,
          stageId: stage.id,
          agents,
          languageDirective,
          requirements: currentSession.requirements,
          // Case-only; absent for every other scene type.
          ...(caseContext ? { caseContext } : {}),
          ...(caseSources ? { caseSources } : {}),
        },
        signal,
        FOREGROUND_SCENE_RETRY_OPTIONS,
      );

      if (!contentData.success || !contentData.content) {
        throw new Error(sceneGenerationErrorMessage(contentData));
      }

      // Generate actions (activate actions step indicator)
      const actionsStepIdx = activeSteps.findIndex((s) => s.id === 'actions');
      setCurrentStepIndex(actionsStepIdx >= 0 ? actionsStepIdx : currentStepIndex + 1);

      const data = await fetchSceneActions(
        {
          outline: contentData.effectiveOutline || firstOutline,
          allOutlines: outlines,
          content: contentData.content,
          stageId: stage.id,
          agents,
          previousSpeeches: [],
          userProfile,
          languageDirective,
        },
        signal,
        FOREGROUND_SCENE_RETRY_OPTIONS,
      );

      if (!data.success || !data.scene) {
        throw new Error(sceneGenerationErrorMessage(data));
      }
      const firstScene = data.scene;

      // Generate TTS for first scene (part of actions step — blocking)
      if (
        settings.ttsEnabled &&
        settings.ttsProviderId !== 'browser-native-tts' &&
        isTTSProviderEnabled(
          settings.ttsProviderId,
          settings.ttsProvidersConfig?.[settings.ttsProviderId],
        )
      ) {
        const ttsResult = await generateTTSForScene(
          firstScene,
          languageDirective,
          signal,
          FOREGROUND_SCENE_RETRY_OPTIONS,
        );
        if (!ttsResult.success) throw new Error(t('generation.speechFailed'));
      }

      // Add scene to store and navigate
      store.addScene(firstScene);
      store.setCurrentSceneId(firstScene.id);

      // Set remaining outlines as skeleton placeholders
      const remaining = outlines.filter((o) => o.order !== firstScene.order);
      store.setGeneratingOutlines(remaining);

      // Store generation params for classroom to continue generation
      sessionStorage.setItem(
        'generationParams',
        JSON.stringify({
          pdfImages: currentSession.pdfImages,
          agents,
          userProfile,
          languageDirective,
        }),
      );

      sessionStorage.removeItem('generationSession');
      const saved = await store.saveToStorage();
      // File the course into the folder the user generated from. This is
      // strictly after the save: the stage row is INSERTed inside
      // `saveToStorage`, and `setStageFolder` is an UPDATE that matches zero
      // rows — answering 404 FOLDER_NOT_FOUND — until that row exists. A save
      // that returns false was dropped (stale epoch) and persisted nothing, so
      // filing would 404 as well.
      if (saved && currentSession.targetFolderId) {
        try {
          await setStageFolder(stage.id, currentSession.targetFolderId);
        } catch (err) {
          // Filing is best-effort: the course is openable either way, it just
          // lands in the root view — exactly the behaviour before this feature.
          log.error('[GenerationPreview] Failed to file course into folder:', err);
          toast.error(t('classroom.moveFailed'));
        }
      }
      router.push(`/classroom/${stage.id}`);
    } catch (err) {
      setIsOutlineStreaming(false);
      // AbortError is expected when navigating away — don't show as error
      if (isAbortError(err)) {
        log.info('[GenerationPreview] Generation aborted');
        return;
      }
      sessionStorage.removeItem('generationSession');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const extractTopicFromRequirement = (requirement: string): string => {
    const trimmed = requirement.trim();
    if (trimmed.length <= 500) {
      return trimmed;
    }
    return trimmed.substring(0, 500).trim() + '...';
  };

  const goBackToHome = () => {
    abortControllerRef.current?.abort();
    clearOutlineReviewTimer();
    outlineReviewIntentRef.current = false;
    sessionStorage.removeItem('generationSession');
    router.push('/');
  };

  /**
   * "Back to home", from the two buttons that carry exactly that label (the
   * outline-review header and the generating header), plus the dead-end
   * session-not-found card. It is the same gesture the classroom's own back
   * arrow performs, so the composer is left as clean as that arrow leaves it —
   * see `resetHomeComposer`.
   *
   * The other `goBackToHome` callers are deliberately NOT routed through here,
   * because they are not that gesture despite landing on the same page:
   *
   * - `OutlinesEditor`'s back is labeled "back to requirements" and exists so
   *   the typed prompt survives the trip (see the commit point below, which
   *   wipes the draft cache only once the outline is confirmed).
   * - The error footer's "go back and retry" returns to the composer to resume
   *   the request that just failed.
   */
  const leaveToHome = () => {
    resetHomeComposer();
    goBackToHome();
  };

  // Triggered when the user clicks the streaming outline card mid-stream.
  // SSE keeps running; only the surface morph + intent flag change.
  const handleExpandStreamingOutline = () => {
    if (!session) return;
    clearOutlineReviewTimer();
    setStatusMessage('');
    outlineReviewIntentRef.current = true;
    persistSession({
      ...session,
      previewPhase: 'review',
    });
  };

  // Inverse of expand. Mid-stream: shrink back to the streaming preview card so
  // the user can keep watching while SSE fills in the rest. Post-stream: shrink
  // back to the small card too, then re-arm the 2.5s auto-continue timer — same
  // pacing as the no-review path so the user has a beat to see the card before
  // the page advances. Jumping straight to content gen feels too abrupt.
  const handleCollapseEditor = () => {
    if (!session) return;
    if (isOutlineStreaming) {
      // Intentionally drop the review-intent flag: collapsing mid-stream is the
      // user saying "actually, never mind". When SSE finishes, the no-early-open
      // path runs and the standard `reviewOutlineEnabled` / auto-continue rules
      // decide what happens next. There is no parked promise to settle yet —
      // the promise is created only after SSE completes (see line 583).
      outlineReviewIntentRef.current = false;
      persistSession({ ...session, previewPhase: 'preparing' });
      setStatusMessage('');
      return;
    }
    const collapsedOutlines = session.sceneOutlines ?? streamingOutlines;
    if (!collapsedOutlines || collapsedOutlines.length === 0) return;
    outlineReviewIntentRef.current = false;
    persistSession({
      ...session,
      sceneOutlines: collapsedOutlines,
      previewPhase: 'outline-ready',
    });
    setStatusMessage(t('generation.reviewOutlineAutoContinue'));

    // Re-arm the auto-continue timer. The SSE-completion flow is parked inside
    // `waitForOutlineReviewChoice` (because `shouldReview` was true when the
    // user opened the editor) — fire its resolve via a fresh timeout to match
    // the no-review path's pacing.
    clearOutlineReviewTimer();
    outlineReviewTimerRef.current = setTimeout(() => {
      outlineReviewTimerRef.current = null;
      const resolve = outlineReviewResolveRef.current;
      outlineReviewResolveRef.current = null;
      if (resolve) {
        resolve(collapsedOutlines);
        return;
      }
      // No parked promise (e.g. session was restored from a refresh into
      // 'review' state). Drive the transition ourselves.
      const confirmedSession: GenerationSessionState = {
        ...session,
        sceneOutlines: collapsedOutlines,
        previewPhase: 'generating-content',
      };
      persistSession(confirmedSession);
      hasStartedRef.current = true;
      void startGeneration(confirmedSession);
    }, OUTLINE_REVIEW_AUTO_CONTINUE_MS);
  };

  const handleOutlinesChange = (outlines: SceneOutline[]) => {
    if (!session) return;
    // Streaming SSE owns `streamingOutlines` while it's running; ignore editor
    // changes until the stream completes (the editor is read-only in that state
    // anyway, but guard defensively against any racy event).
    if (isOutlineStreaming) return;
    persistSession({
      ...session,
      sceneOutlines: outlines,
      previewPhase: 'review',
    });
  };

  const handleConfirmOutlines = () => {
    const finalOutlines = session?.sceneOutlines ?? streamingOutlines;
    if (!finalOutlines || finalOutlines.length === 0) return;
    setIsConfirmingOutlines(true);
    clearOutlineReviewTimer();
    outlineReviewIntentRef.current = false;

    if (outlineReviewResolveRef.current) {
      const resolve = outlineReviewResolveRef.current;
      outlineReviewResolveRef.current = null;
      resolve(finalOutlines);
      return;
    }

    // Fallback: no parked promise (session restored mid-review). The button's
    // loading state was set above to give the click immediate feedback, but the
    // editor is about to unmount anyway as we drive the next phase ourselves.
    // Reset the flag so the state doesn't linger if `startGeneration` later
    // re-renders the editor for any reason.
    setIsConfirmingOutlines(false);
    const confirmedSession: GenerationSessionState = {
      ...(session as GenerationSessionState),
      sceneOutlines: finalOutlines,
      previewPhase: 'generating-content',
    };
    persistSession(confirmedSession);
    hasStartedRef.current = true;
    void startGeneration(confirmedSession);
  };

  // Still loading session from sessionStorage
  if (!sessionLoaded) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <div className="size-8 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </div>
    );
  }

  // No session found
  if (!session) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full">
          <div className="text-center space-y-4">
            <AlertCircle className="size-12 text-muted-foreground mx-auto" />
            <h2 className="text-xl font-semibold">{t('generation.sessionNotFound')}</h2>
            <p className="text-sm text-muted-foreground">{t('generation.sessionNotFoundDesc')}</p>
            <Button onClick={leaveToHome} className="w-full">
              <ArrowLeft className="size-4 mr-2" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const activeStep =
    activeSteps.length > 0
      ? activeSteps[Math.min(currentStepIndex, activeSteps.length - 1)]
      : ALL_STEPS[0];
  const activeStepText = getGenerationStepText(activeStep, session);

  if (isReviewingOutlines) {
    const outlineStepIndex = Math.max(
      0,
      activeSteps.findIndex((step) => step.id === 'outline'),
    );
    // Editor source-of-truth: prefer the persisted final list; fall back to the
    // live streaming buffer so the editor can render mid-stream after expansion.
    const editorOutlines = session.sceneOutlines ?? streamingOutlines ?? [];

    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center p-4 relative overflow-hidden">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-4 left-4 z-20"
        >
          <Button variant="ghost" size="sm" onClick={leaveToHome} disabled={isConfirmingOutlines}>
            <ArrowLeft className="size-4 mr-2" />
            {t('generation.backToHome')}
          </Button>
        </motion.div>

        <div className="z-10 w-full max-w-3xl pt-16 pb-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <div className="flex justify-center gap-2">
              {activeSteps.map((step, idx) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500',
                    idx < outlineStepIndex
                      ? 'w-1.5 bg-blue-500/30'
                      : idx === outlineStepIndex
                        ? 'w-8 bg-blue-500'
                        : 'w-1.5 bg-muted/50',
                  )}
                />
              ))}
            </div>

            <div className="max-w-2xl space-y-2 text-center mx-auto">
              <h2 className="text-2xl font-bold tracking-tight">
                {t('generation.reviewOutlineTitle')}
              </h2>
              <p className="text-muted-foreground text-sm md:text-base">
                {isOutlineStreaming
                  ? t('generation.reviewOutlineStreamingDesc')
                  : t('generation.reviewOutlineDesc')}
              </p>
            </div>

            {error && (
              <div className="mx-auto max-w-2xl rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
                {error}
              </div>
            )}

            <OutlinesEditor
              outlines={editorOutlines}
              onChange={handleOutlinesChange}
              onConfirm={handleConfirmOutlines}
              onBack={goBackToHome}
              alwaysReview={reviewOutlineEnabled}
              onAlwaysReviewChange={setReviewOutlineEnabled}
              isLoading={isConfirmingOutlines}
              isStreaming={isOutlineStreaming}
              onCollapse={handleCollapseEditor}
            />
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden text-center">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* Back button */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute top-4 left-4 z-20"
      >
        <Button variant="ghost" size="sm" onClick={leaveToHome}>
          <ArrowLeft className="size-4 mr-2" />
          {t('generation.backToHome')}
        </Button>
      </motion.div>

      <div className="z-10 w-full max-w-lg space-y-8 flex flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full"
        >
          <Card className="relative overflow-hidden border-muted/40 shadow-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl min-h-[400px] flex flex-col items-center justify-center p-8 md:p-12">
            {/* Progress Dots */}
            <div className="absolute top-6 left-0 right-0 flex justify-center gap-2">
              {activeSteps.map((step, idx) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500',
                    idx < currentStepIndex
                      ? 'w-1.5 bg-blue-500/30'
                      : idx === currentStepIndex
                        ? 'w-8 bg-blue-500'
                        : 'w-1.5 bg-muted/50',
                  )}
                />
              ))}
            </div>

            {/* Central Content */}
            <div className="flex-1 flex flex-col items-center justify-center w-full space-y-8 mt-4">
              {/* Icon / Visualizer Container */}
              <div className="relative size-48 flex items-center justify-center">
                <AnimatePresence mode="popLayout">
                  {error ? (
                    <motion.div
                      key="error"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="size-32 rounded-full bg-red-500/10 flex items-center justify-center border-2 border-red-500/20"
                    >
                      <AlertCircle className="size-16 text-red-500" />
                    </motion.div>
                  ) : isComplete ? (
                    <motion.div
                      key="complete"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="size-32 rounded-full bg-green-500/10 flex items-center justify-center border-2 border-green-500/20"
                    >
                      <CheckCircle2 className="size-16 text-green-500" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={activeStep.id}
                      initial={{ scale: 0.8, opacity: 0, filter: 'blur(10px)' }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                      exit={{ scale: 1.2, opacity: 0, filter: 'blur(10px)' }}
                      transition={{ duration: 0.4 }}
                      className="absolute inset-0 flex items-center justify-center"
                    >
                      <StepVisualizer
                        stepId={activeStep.id}
                        outlines={session.sceneOutlines ?? streamingOutlines}
                        webSearchSources={webSearchSources}
                        caseResearchSources={caseResearchSources}
                        onExpandOutline={
                          activeStep.id === 'outline' ? handleExpandStreamingOutline : undefined
                        }
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Text Content */}
              <div className="space-y-3 max-w-sm mx-auto">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={error ? 'error' : isComplete ? 'done' : activeStep.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-2"
                  >
                    <h2 className="text-2xl font-bold tracking-tight">
                      {error
                        ? t('generation.generationFailed')
                        : isComplete
                          ? t('generation.generationComplete')
                          : t(activeStepText.title, activeStepText.titleValues)}
                    </h2>
                    <p className="text-muted-foreground text-base">
                      {error
                        ? error
                        : isComplete
                          ? t('generation.classroomReady')
                          : statusMessage || t(activeStepText.description)}
                    </p>
                  </motion.div>
                </AnimatePresence>

                {/* Truncation warning indicator */}
                <AnimatePresence>
                  {truncationWarnings.length > 0 && !error && !isComplete && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0 }}
                      transition={{
                        type: 'spring',
                        stiffness: 500,
                        damping: 30,
                      }}
                      className="flex justify-center"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <motion.button
                            type="button"
                            animate={{
                              boxShadow: [
                                '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                                '0 0 16px 4px rgba(251, 191, 36, 0.12), 0 0 4px 1px rgba(251, 191, 36, 0.08)',
                                '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                              ],
                            }}
                            transition={{
                              duration: 3,
                              repeat: Infinity,
                              ease: 'easeInOut',
                            }}
                            className="relative size-7 rounded-full flex items-center justify-center cursor-default
                                       bg-gradient-to-br from-amber-400/15 to-orange-400/10
                                       border border-amber-400/25 hover:border-amber-400/40
                                       hover:from-amber-400/20 hover:to-orange-400/15
                                       transition-colors duration-300
                                       focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
                          >
                            <AlertTriangle
                              className="size-3.5 text-amber-500 dark:text-amber-400"
                              strokeWidth={2.5}
                            />
                          </motion.button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          <div className="space-y-1 py-0.5">
                            {truncationWarnings.map((w, i) => (
                              <p key={i} className="text-xs leading-relaxed">
                                {w}
                              </p>
                            ))}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </Card>
        </motion.div>

        {/* Footer Action */}
        <div className="h-16 flex items-center justify-center w-full">
          <AnimatePresence>
            {error ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-xs"
              >
                <Button size="lg" variant="outline" className="w-full h-12" onClick={goBackToHome}>
                  {t('generation.goBackAndRetry')}
                </Button>
              </motion.div>
            ) : isOutlineReady ? null : !isComplete ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 text-sm text-muted-foreground/50 font-medium uppercase tracking-widest"
              >
                <Sparkles className="size-3 animate-pulse" />
                {t('generation.aiWorking')}
                {generatedAgents.length > 0 && !showAgentReveal && (
                  <button
                    onClick={() => setShowAgentReveal(true)}
                    className="ml-2 flex items-center gap-1.5 rounded-full border border-purple-300/30 bg-purple-500/10 px-3 py-1 text-xs font-medium normal-case tracking-normal text-purple-400 transition-colors hover:bg-purple-500/20 hover:text-purple-300"
                  >
                    <Bot className="size-3" />
                    {t('generation.viewAgents')}
                  </button>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Agent Reveal Modal */}
      <AgentRevealModal
        agents={generatedAgents}
        open={showAgentReveal}
        onClose={() => setShowAgentReveal(false)}
        onAllRevealed={() => {
          agentRevealResolveRef.current?.();
          agentRevealResolveRef.current = null;
        }}
      />
    </div>
  );
}

export default function GenerationPreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
          <div className="animate-pulse space-y-4 text-center">
            <div className="h-8 w-48 bg-muted rounded mx-auto" />
            <div className="h-4 w-64 bg-muted rounded mx-auto" />
          </div>
        </div>
      }
    >
      <GenerationPreviewContent />
    </Suspense>
  );
}
