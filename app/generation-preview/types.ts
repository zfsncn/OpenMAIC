import {
  ScanLine,
  Search,
  Bot,
  FileText,
  LayoutPanelLeft,
  Clapperboard,
  Newspaper,
} from 'lucide-react';
import { useSettingsStore } from '@/lib/store/settings';
import type { ExtractionProgress } from '@/lib/document/types';
import type {
  SceneOutline,
  UserRequirements,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
} from '@/lib/types/generation';

// Session state stored in sessionStorage
export interface GenerationSessionState {
  sessionId: string;
  requirements: UserRequirements;
  pdfText: string;
  documentSources?: SessionDocumentSource[];
  pdfImages?: PdfImage[];
  imageStorageIds?: string[];
  imageMapping?: ImageMapping;
  sceneOutlines?: SceneOutline[] | null;
  currentStep: 'generating' | 'complete';
  previewPhase?: 'preparing' | 'outline-ready' | 'review' | 'generating-content';
  // PDF deferred parsing fields
  pdfStorageKey?: string;
  pdfFileName?: string;
  documentMimeType?: string;
  pdfProviderId?: string;
  pdfProviderConfig?: {
    apiKey?: string;
    baseUrl?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
  };
  // Web search context
  researchContext?: string;
  researchSources?: Array<{ title: string; url: string }>;
  // Language directive inferred from outline generation
  languageDirective?: string;
  // Concise course title inferred from outline generation (used as the stage name)
  courseTitle?: string;
  // Server-effective vocational mode from the outline generation done event.
  taskEngineMode?: boolean;
  /**
   * Run the material extraction and stop — no outline, no course, no write.
   *
   * Set when the materials already belong to a classroom (matched by
   * `Stage.sourceDigests`) whose archived derivation is missing or unusable:
   * the user is re-uploading to fill in the derivation, not asking for a
   * second classroom from the same file. The preview page runs Step 0 — which
   * is what archives the derivation server-side — and then opens
   * {@link targetStageId} instead of generating.
   */
  extractOnly?: boolean;
  /**
   * The classroom an {@link extractOnly} session must open once extraction
   * finishes. Ignored when `extractOnly` is absent.
   */
  targetStageId?: string;
  /**
   * Folder to file the generated classroom into, captured at click time from
   * the folder view the user generated from.
   *
   * Absent means "do not file": the course lands in the root view, which is
   * also what every generation did before this field existed. Only a folder
   * view that is actually on screen yields a value — returning to the root,
   * exiting search, or deleting the folder all clear it — so an in-root
   * generation with a fresh prompt never carries one.
   *
   * The preview page applies it with a `setStageFolder` call *after* the stage
   * row exists (i.e. after `saveToStorage`); filing is best-effort and never
   * blocks opening the classroom.
   */
  targetFolderId?: string;
}

export type GenerationStep = {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  type: 'analysis' | 'writing' | 'visual';
};

const MEDIA_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'mp3', 'wav', 'aac', 'm4a']);

/** True when the uploaded material is audio/video (extraction is transcription). */
function isMediaMaterial(session: GenerationSessionState | null): boolean {
  const mimeType = session?.documentMimeType;
  if (mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) return true;
  const extension = session?.pdfFileName?.split('.').pop()?.trim().toLowerCase();
  return !!extension && MEDIA_EXTENSIONS.has(extension);
}

export function getGenerationStepText(
  step: GenerationStep,
  session: GenerationSessionState | null,
) {
  if (step.id === 'pdf-analysis') {
    // Audio/video use a dedicated string ("Analyzing audio/video") — the
    // generic document copy ("Analyzing documents") would misdescribe them.
    if (isMediaMaterial(session)) {
      return {
        title: 'generation.analyzingMediaMaterial',
        titleValues: undefined,
        description: 'generation.analyzingCourseMaterialDesc',
      };
    }
    return {
      title: 'generation.analyzingCourseMaterial',
      titleValues: undefined,
      description: 'generation.analyzingCourseMaterialDesc',
    };
  }
  return {
    title: step.title,
    titleValues: undefined,
    description: step.description,
  };
}

/**
 * The status line for an in-flight material extraction: a real page counter
 * when the extractor reports one, the service's own percentage when that is all
 * it quantifies, and a "waiting" line when it reports neither.
 *
 * The waiting case is not a missing value. A remote extractor queues the
 * document before it starts on it, and while it is queued there is genuinely
 * nothing to count — rendering a fabricated `0/0` there would read as a stall
 * rather than as progress.
 *
 * The order matters: a page counter is strictly more informative than a
 * percentage, so it wins whenever both are present, and a percentage is never
 * turned into a page count (that would be an invented number moving in steps
 * the service never took).
 */
export function getExtractionProgressText(
  name: string,
  progress: ExtractionProgress,
): { key: string; values: Record<string, string | number> } {
  const { completedPages, totalPages, percent } = progress;
  if (typeof completedPages === 'number' && typeof totalPages === 'number' && totalPages > 0) {
    return {
      key: 'generation.courseMaterialExtractProgress',
      values: { name, done: completedPages, total: totalPages },
    };
  }
  if (typeof percent === 'number' && Number.isFinite(percent) && percent > 0 && percent <= 100) {
    return {
      key: 'generation.courseMaterialExtractProgressPercent',
      values: { name, percent: Math.round(percent) },
    };
  }
  return { key: 'generation.courseMaterialExtractWaiting', values: { name } };
}

/**
 * The message key for a failed extraction, chosen by the failure kind the
 * server classified rather than by its message: the message is unlocalized
 * server prose meant for the log, so an absent or unrecognised kind falls back
 * to the generic parsing-failed copy.
 */
export function getExtractionFailureKey(kind?: string): string {
  switch (kind) {
    case 'timeout':
      return 'generation.courseMaterialExtractFailedTimeout';
    case 'service-unavailable':
      return 'generation.courseMaterialExtractFailedUnavailable';
    case 'quota':
      return 'generation.courseMaterialExtractFailedQuota';
    case 'auth':
      return 'generation.courseMaterialExtractFailedAuth';
    default:
      return 'generation.courseMaterialParseFailed';
  }
}

export const ALL_STEPS: GenerationStep[] = [
  {
    id: 'pdf-analysis',
    title: 'generation.analyzingCourseMaterial',
    description: 'generation.analyzingCourseMaterialDesc',
    icon: ScanLine,
    type: 'analysis',
  },
  {
    id: 'web-search',
    title: 'generation.webSearching',
    description: 'generation.webSearchingDesc',
    icon: Search,
    type: 'analysis',
  },
  {
    id: 'outline',
    title: 'generation.generatingOutlines',
    description: 'generation.generatingOutlinesDesc',
    icon: FileText,
    type: 'writing',
  },
  {
    // Case teaching only, and deliberately AFTER `outline` rather than merged
    // into `web-search`: the research is driven by the chapter's knowledge
    // points, and those do not exist until the outline step has produced them.
    // The two searches answer different questions — `web-search` grounds the
    // outline from the raw requirement, this one grounds the case from the
    // points the outline chose.
    id: 'case-search',
    title: 'generation.caseResearching',
    description: 'generation.caseResearchingDesc',
    icon: Newspaper,
    type: 'analysis',
  },
  {
    id: 'agent-generation',
    title: 'generation.agentGeneration',
    description: 'generation.agentGenerationDesc',
    icon: Bot,
    type: 'writing',
  },
  {
    id: 'slide-content',
    title: 'generation.generatingSlideContent',
    description: 'generation.generatingSlideContentDesc',
    icon: LayoutPanelLeft,
    type: 'visual',
  },
  {
    id: 'actions',
    title: 'generation.generatingActions',
    description: 'generation.generatingActionsDesc',
    icon: Clapperboard,
    type: 'visual',
  },
];

export const getActiveSteps = (session: GenerationSessionState | null) => {
  return ALL_STEPS.filter((step) => {
    if (step.id === 'pdf-analysis') {
      return Boolean(
        session?.pdfStorageKey ||
        ((session?.documentSources?.length ?? 0) > 0 && !session?.pdfText),
      );
    }
    if (step.id === 'web-search') return !!session?.requirements?.webSearch;
    // Case research is gated on the search toggle as well as the lesson kind:
    // it calls the same `/api/web-search` route, so a deployment with no
    // provider configured (or a user who turned search off) would only produce
    // an error per knowledge point. Off, the case falls back to the
    // no-research path and says so — the same outcome, without the noise.
    if (step.id === 'case-search') {
      return (
        session?.requirements?.lessonKind === 'caseTeaching' && !!session?.requirements?.webSearch
      );
    }
    if (step.id === 'agent-generation') return useSettingsStore.getState().agentMode === 'auto';
    return true;
  });
};
