/**
 * Generation Types - Two-Stage Content Generation System
 *
 * Stage 1: User requirements + documents → Scene Outlines (per-page)
 * Stage 2: Scene Outlines → Full Scenes (slide/quiz/interactive/pbl with actions)
 */

import type { ActionType } from './action';
import type { MediaGenerationRequest } from '@/lib/media/types';

// ==================== PDF Image Types ====================

/**
 * Image extracted from PDF with metadata
 */
export interface PdfImage {
  id: string; // e.g., "img_1", "img_2"
  src: string; // base64 data URL (empty when stored in IndexedDB)
  pageNumber: number; // Page number in PDF
  description?: string; // Optional description for AI context
  storageId?: string; // Reference to IndexedDB (session_xxx_img_1)
  /**
   * Pool asset id of the image bytes. Present on server-backed deployments
   * (RFC #1153 part 2 B): the extracted images are pool assets, so generation
   * is fed by id and no IndexedDB bytes are materialized. Browser-backed
   * images carry `storageId` instead — never both.
   */
  assetId?: string; // Allocated asset-pool id (server-backed transport)
  width?: number; // Image width (px or normalized)
  height?: number; // Image height (px or normalized)
  originalId?: string; // ID assigned by the extractor before bundle-level normalization
  sourceDocumentId?: string; // DocumentBundle source ID
  sourceDocumentName?: string; // Original source filename for citation back to material
  sourceDocumentOrder?: number; // Upload order in the bundle
  visionPriority?: number; // Higher values are attached first when vision budget is limited
}

/**
 * Image mapping for post-processing: image_id → base64 URL
 */
export type ImageMapping = Record<string, string>;

export interface SelectedCourseMaterial {
  id: string;
  /**
   * The uploaded file's bytes.
   *
   * Absent on a chapter restored from the synced directory on a device that
   * never held the bytes (or whose IndexedDB copy is gone): the row is shown
   * so the directory survives a device change, and the file has to be selected
   * again before a lesson can be generated from it. Everything else about the
   * entry — name, size, order — is authoritative either way, which is why
   * `courseMaterialFingerprint` reads those fields and not this one.
   */
  file?: File;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  /**
   * Position within this material's own folder (`folderId`), not within the
   * whole directory: the homepage keeps one list holding every folder's rows,
   * and the left-hand panel numbers the rows it shows from 1. So two rows in
   * two different folders may both be `order: 1`, which is what makes "the
   * third chapter of this folder" mean the same thing to the panel, to the
   * upload limits and to the generation step.
   *
   * Generation renumbers whatever subset it ingests anyway, so nothing
   * downstream of the homepage depends on these values being globally unique.
   */
  order: number;
  /**
   * The folder this material belongs to, or `undefined` for an unfiled one.
   *
   * Folders group *generated courses*, and this is the only thing that ties a
   * material to one: the material list stays a single record covering every
   * folder, and the active folder is applied as a filter over it. That is
   * deliberate — a material is not *moved* between folders, it is *filed*
   * under one, so no row ever needs rewriting when the view changes.
   */
  folderId?: string;
  /**
   * IndexedDB key of this file's bytes on the device that uploaded it
   * (`storePdfBlob`). Written when the file is attached, so the directory can
   * be rebuilt after a reload; it is the stable half of the synced entry.
   */
  storageKey?: string;
  /** Allocated asset-pool id once the file has been ingested (part 0). */
  assetId?: string;
  /**
   * SHA-256 of the file bytes, computed at upload time. This is the stable
   * half of the extraction-cache key: two uploads of the same bytes get
   * different allocated asset ids but the same digest (part 1).
   */
  contentDigest?: string;
}

export interface SessionDocumentSource {
  id: string;
  name: string;
  size: number;
  lastModified?: number;
  mimeType?: string;
  order: number;
  storageKey: string;
  /**
   * Allocated asset-pool id for this source. New sessions write it; legacy
   * sessions carry only `storageKey` and keep working (back-compat).
   */
  assetId?: string;
  /**
   * SHA-256 of the source bytes, computed at upload time. Together with the
   * extractor identity it keys the extraction derivation cache (part 1);
   * legacy sessions predating the digest carry only `storageKey`.
   */
  contentDigest?: string;
  providerId?: string;
}

// ==================== Stage 1 Input ====================

export interface UploadedDocument {
  id: string;
  name: string; // Original filename
  type: 'pdf' | 'docx' | 'pptx' | 'txt' | 'md' | 'image' | 'other';
  size: number; // Bytes
  uploadedAt: Date;
  contentSummary?: string; // Placeholder for parsing
  extractedTopics?: string[]; // Placeholder for parsing
  pageCount?: number;
  storageRef?: string;
}

/**
 * Simplified user requirements for course generation
 * All details (topic, duration, style, etc.) should be included in the requirement text
 */
export interface UserRequirements {
  requirement: string; // Single free-form text for all user input
  userNickname?: string; // Student nickname for personalization
  userBio?: string; // Student background for personalization
  webSearch?: boolean; // Enable web search for richer context
  interactiveMode?: boolean; // Enable Interactive Mode for interactive-first generation
  taskEngineMode?: boolean; // Enable vocational task-engine generation path
  /**
   * Which kind of lesson to generate. Absent means an ordinary teaching
   * classroom — the pre-existing path, unchanged. `'unitQuiz'` makes the
   * outline step emit a single quiz scene, `'caseTeaching'` a single case
   * scene; neither carries teaching slides, and each stamps the resulting
   * stage with the same value.
   *
   * It rides on the requirements because that is the one object the preview
   * page forwards to the outline stream verbatim (see the scene-outlines fetch
   * in `app/generation-preview/page.tsx`), and the server is what has to act on
   * it.
   */
  lessonKind?: LessonKind;
}

// ==================== Stage 1 Output: Scene Outlines (Simplified) ====================

/**
 * Widget outline configuration for interactive scenes
 * Unified for both normal and ultra modes
 */
export interface WidgetOutline {
  // Common field
  concept?: string;

  // Type-specific fields
  keyVariables?: string[]; // simulation
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system'; // diagram
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp'; // code
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action'; // game
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom'; // visualization3d
  objects?: string[]; // visualization3d
  interactions?: string[]; // visualization3d
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom'; // procedural-skill
  task?: string; // procedural-skill - task to perform
  tools?: string[]; // procedural-skill - tools or materials involved
  steps?: string[]; // procedural-skill - ordered procedure steps
  successCriteria?: string[]; // procedural-skill - checks for completion
  errorConsequences?: string[]; // procedural-skill - consequences for unsafe or incorrect actions
  challenge?: string; // game - description of what player does
  playerControls?: string[]; // game - what player controls
  nodeCount?: number; // diagram - approximate node count
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>; // diagram - prescribed nodes and optional hierarchy
  challengeType?: string; // code - type of coding challenge
}

/**
 * Simplified scene outline
 * Gives AI more freedom, only requiring intent description and key points
 */
export interface SceneOutline {
  id: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl' | 'case';
  title: string;
  description: string; // 1-2 sentences describing the purpose
  keyPoints: string[]; // 3-5 core key points
  teachingObjective?: string;
  estimatedDuration?: number; // seconds
  order: number;
  languageNote?: string; // LLM-inferred language note for this scene
  // Suggested image IDs (from PDF-extracted images)
  suggestedImageIds?: string[]; // e.g., ["img_1", "img_3"]
  // AI-generated media requests (when PDF images are insufficient)
  mediaGenerations?: MediaGenerationRequest[]; // e.g., [{ type: 'image', prompt: '...', elementId: 'gen_img_1' }]
  // Quiz-specific config
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'text')[];
    /**
     * Explicit per-type quotas, used by the quiz-classroom path. `questionCount`
     * still states the total and stays what the ordinary path reads; a count
     * plus a type *set* cannot express "5 single, 5 multiple, 1 discussion",
     * which is exactly what the unit-quiz flow requires.
     */
    questionMix?: Array<{ type: 'single' | 'multiple' | 'text'; count: number }>;
    /**
     * How many options every choice question must offer. Absent leaves the
     * count to the model — the ordinary path, which has always varied between
     * four and five. The unit-quiz path sets it so the prompt and the
     * server-side contract agree on a fixed set of distractors.
     */
    optionCount?: number;
    /**
     * 1-based regeneration counter for the "shuffle a fresh set" action on a
     * quiz classroom. Absent on the first generation; each regeneration bumps
     * it so the prompt can demand a set that does not repeat an earlier one.
     */
    attempt?: number;
  };
  /**
   * Case-teaching config. The chapter knowledge points are NOT duplicated here:
   * they ride on the outline's first-class `keyPoints`, which every outline
   * already persists. One list means the narrative, the discussion questions
   * and the later analysis cannot drift apart by reading two copies written at
   * different times.
   */
  caseConfig?: {
    /** How many discussion questions the case should pose. */
    questionCount?: number;
    /**
     * 1-based counter for "show a different case". Absent on the first one;
     * each regeneration bumps it so the prompt can demand an event that is not
     * the one the learner just read.
     */
    attempt?: number;
  };
  /**
   * @deprecated Use widgetType + widgetOutline instead
   * Legacy interactive config - kept for backward compatibility only
   */
  interactiveConfig?: {
    conceptName: string;
    conceptOverview: string;
    designIdea: string;
    subject?: string;
  };
  // PBL-specific config
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    /** Opt into role-play scenario planning on top of the standard PBL v2 structure. */
    scenarioRoleplay?: boolean;
    /** Optional scenario brief used only when scenarioRoleplay is true. */
    scenarioBrief?: string;
  };
  // Widget fields (required for type === 'interactive' in unified mode)
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}

// ==================== Stage 3 Output: Generated Content ====================

import type { LessonKind, PPTElement, SlideBackground } from '@openmaic/dsl';
import type { QuizQuestion } from './stage';

/**
 * AI-generated slide content
 */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
}

/**
 * AI-generated quiz content
 */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

// ==================== Case Generation Types ====================

import type { CaseAnalysis, CaseQuestion, CaseSourceRef } from '@openmaic/dsl';

/**
 * AI-generated case content, before it is assembled into a scene.
 *
 * Carries no `type` discriminator — the field is attached when the payload is
 * assembled into a `Scene`, so nothing here may branch on `content.type`.
 * `analysis` is absent on the first pass (the case) and present on the second
 * (the staged reveal); the passes are told apart by which fields are read.
 */
export interface GeneratedCaseContent {
  caseTitle?: string;
  summary?: string;
  knowledgePoints?: string[];
  narrative?: string;
  /**
   * Named in full, never `questions`: a generated payload has no discriminant,
   * so consumers identify it by which keys are present. Sharing a key with
   * `GeneratedQuizContent` would make that check match either kind.
   */
  discussionQuestions?: CaseQuestion[];
  sources?: CaseSourceRef[];
  analysis?: CaseAnalysis;
}

// ==================== PBL Generation Types ====================

import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

/**
 * AI-generated PBL content.
 *
 * PBL generation produces only the v2 project payload.
 */
export interface GeneratedPBLContent {
  projectV2: PBLProjectV2;
}

// ==================== Interactive Generation Types ====================

import type { WidgetConfig, WidgetType } from './widgets';

/**
 * Scientific model output from scientific modeling stage
 */
export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/**
 * AI-generated interactive content
 */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
}

// ==================== Legacy Types (for compatibility) ====================

export interface SuggestedSlideElement {
  type: 'text' | 'image' | 'shape' | 'chart' | 'latex' | 'line';
  purpose: 'title' | 'subtitle' | 'content' | 'example' | 'diagram' | 'formula' | 'highlight';
  contentHint: string;
  position?: 'top' | 'center' | 'bottom' | 'left' | 'right';
  chartType?: 'bar' | 'line' | 'pie' | 'radar';
  textOutline?: string[];
}

export interface SuggestedQuizQuestion {
  type: 'single' | 'multiple' | 'short_answer';
  questionOutline: string;
  suggestedOptions?: string[];
  targetConceptId?: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface SuggestedAction {
  type: ActionType;
  description: string;
  timing?: 'start' | 'middle' | 'end' | 'after-content';
}
