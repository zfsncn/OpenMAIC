import type { WidgetType } from '@openmaic/dsl';

export type { WidgetType } from '@openmaic/dsl';

/** Image extracted from a source document with metadata used by outline prompts. */
export interface PdfImage {
  id: string;
  src: string;
  pageNumber: number;
  description?: string;
  storageId?: string;
  width?: number;
  height?: number;
  originalId?: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourceDocumentOrder?: number;
  visionPriority?: number;
}

export type ImageMapping = Record<string, string>;

/** Free-form requirements accepted by outline generation. */
export interface UserRequirements {
  requirement: string;
  userNickname?: string;
  userBio?: string;
  webSearch?: boolean;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
}

export interface WidgetOutline {
  concept?: string;
  keyVariables?: string[];
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action';
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  objects?: string[];
  interactions?: string[];
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom';
  task?: string;
  tools?: string[];
  steps?: string[];
  successCriteria?: string[];
  errorConsequences?: string[];
  challenge?: string;
  playerControls?: string[];
  nodeCount?: number;
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>;
  challengeType?: string;
}

export interface MediaGenerationRequest {
  type: 'image' | 'video';
  prompt: string;
  elementId: string;
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  style?: string;
}

/** A generation-ready description of one course scene. */
export interface SceneOutline {
  id: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl' | 'case';
  title: string;
  description: string;
  keyPoints: string[];
  teachingObjective?: string;
  estimatedDuration?: number;
  order: number;
  languageNote?: string;
  suggestedImageIds?: string[];
  mediaGenerations?: MediaGenerationRequest[];
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
     * it so the prompt can say this is a later attempt and demand a set that
     * does not repeat an earlier one.
     */
    attempt?: number;
  };
  /**
   * Case-teaching config. The chapter knowledge points themselves are NOT
   * duplicated here — they ride on the outline's first-class `keyPoints`,
   * which every outline already persists. Keeping one list means the narrative,
   * the discussion questions and the later analysis cannot drift apart by
   * reading two copies that were written at different times.
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
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    scenarioRoleplay?: boolean;
    scenarioBrief?: string;
  };
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}
