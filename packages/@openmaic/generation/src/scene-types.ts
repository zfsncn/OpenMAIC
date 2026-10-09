import type {
  Action,
  CaseAnalysis,
  CaseContent,
  CaseQuestion,
  CaseSourceRef,
  InteractiveContent,
  PBLContent,
  PBLProject,
  PPTElement,
  QuizContent,
  QuizQuestion,
  Scene,
  SlideBackground,
  SlideContent,
  WidgetConfigBase,
  WidgetType,
} from '@openmaic/dsl';

/** AI-generated slide payload before it is assembled into a scene. */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
}

/** AI-generated quiz payload before it is assembled into a scene. */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

/**
 * AI-generated case payload before it is assembled into a scene.
 *
 * Carries no discriminator, exactly like the other generated payloads: the
 * scene-level `type` is attached when the payload is assembled into a `Scene`.
 * Nothing may branch on `content.type` here — the field does not exist on the
 * wire, and a check against it fails silently on every real response.
 *
 * `caseTitle` / `narrative` / `questions` are present on the first pass, which
 * produces the case itself. `analysis` is present only on the second pass, the
 * learner-triggered staged reveal; the two passes are distinguished by which
 * fields the caller reads, not by a mode field on this shape.
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

export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/** AI-generated interactive payload before it is assembled into a scene. */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfigBase;
}

/** AI-generated PBL payload. The persisted project contract is owned by the DSL. */
export interface GeneratedPBLContent {
  projectV2: PBLProject;
}

export type GeneratedSceneContent =
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent
  | GeneratedCaseContent;

export type CompleteSceneContent =
  | SlideContent
  | QuizContent
  | InteractiveContent
  | PBLContent
  | CaseContent;

/** Scene assembled by the package, including the originating outline identity. */
export type CompleteScene = Scene<Action, CompleteSceneContent> & { outlineId: string };

/** Widget configuration emitted by the model and normalized by the scene layer. */
export type WidgetConfig = WidgetConfigBase;
