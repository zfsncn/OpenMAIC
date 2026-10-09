/**
 * Stage / Scene / SceneContent — the universal lesson-skeleton contract.
 *
 * This module owns the *structural* part of a lesson: the top-level `Stage`
 * container and a per-page `Scene` whose `content` is a discriminated union of
 * the universal content kinds (`SlideContent`, `QuizContent`). Interactive and
 * PBL content contracts are exported alongside them and compose through
 * `Scene`'s generic content parameter. `Scene`'s
 * playback `actions` default to the contract's standard {@link Action} union
 * (defined in `./action.ts`); apps can still extend widget payloads and action
 * sets through `Scene`'s generic parameters.
 *
 * The split keeps `@openmaic/dsl` focused on the lesson skeleton while letting the
 * runtime engine, renderer, and importer share one source of truth for it.
 *
 * No runtime dependencies. Pure types + pure discriminant guards only.
 */
import type { Slide } from './slides.js';
import type { Action } from './action.js';

/** All scene kinds owned by the contract. */
export type SceneType = 'slide' | 'quiz' | 'interactive' | 'pbl' | 'case';

/** Frozen set of every valid {@link SceneType}, for cheap membership checks. */
export const SCENE_TYPES = [
  'slide',
  'quiz',
  'interactive',
  'pbl',
  'case',
] as const satisfies readonly SceneType[];

// Compile-time exhaustiveness: every SceneType must appear in SCENE_TYPES.
// `satisfies` above proves the converse (each entry is a valid SceneType); this
// fails the build if the union gains a member the tuple is missing.
type _SceneTypesExhaustive = [SceneType] extends [(typeof SCENE_TYPES)[number]] ? true : never;
const _sceneTypesExhaustive: _SceneTypesExhaustive = true;
void _sceneTypesExhaustive;

/** Narrow an unknown value to a valid {@link SceneType}. Pure, no runtime deps. */
export function isSceneType(value: unknown): value is SceneType {
  return typeof value === 'string' && (SCENE_TYPES as readonly string[]).includes(value);
}

/** Lifecycle / interaction mode a {@link Stage} can be operated in. */
export type StageMode = 'autonomous' | 'playback' | 'edit';

/**
 * What kind of lesson a {@link Stage} is.
 *
 * `'lesson'` is the ordinary teaching classroom — the slides and any other
 * scenes the outline produced — and is also what every classroom generated
 * before this field existed reads as, so its absence must keep meaning "an
 * ordinary lesson", never "unknown".
 *
 * `'unitQuiz'` is a quiz-only classroom: the same material, generated down the
 * quiz path, holding a single quiz scene and no teaching slides. It exists
 * because a quiz classroom and a teaching classroom are built from the *same*
 * material and therefore carry the same `sourceDigests` — nothing else on the
 * stage can tell the two apart when the home page has to decide which one an
 * upload refers to.
 *
 * `'caseTeaching'` is reserved. No generation path produces it yet; the home
 * page renders its affordance as a disabled placeholder.
 */
export type LessonKind = 'lesson' | 'unitQuiz' | 'caseTeaching';

/** Narrow an unknown value to a valid {@link LessonKind}. Pure, no runtime deps. */
export function isLessonKind(value: unknown): value is LessonKind {
  return value === 'lesson' || value === 'unitQuiz' || value === 'caseTeaching';
}

/**
 * A whiteboard slide. Structurally a {@link Slide} minus the fields that only
 * make sense on a primary canvas (`theme`, `turningMode`, `sectionTag`, `type`).
 */
export type Whiteboard = Omit<Slide, 'theme' | 'turningMode' | 'sectionTag' | 'type'>;

export interface VideoManifestEntry {
  type: 'video';
  prompt: string;
  aspectRatio?: string;
}

export type VideoManifest = Record<string, VideoManifestEntry>;

/**
 * Provider-neutral vocal identity for an agent, described as a 3-layer recipe.
 * Consumed by any TTS integration: as an inline voice prompt where supported,
 * or as the seed for a registered/cloned voice. Part of the contract so an
 * agent's voice travels with the document (export/import, device switches)
 * instead of living in device-local storage.
 */
export interface VoiceDesign {
  /** gender / age / role */
  identity: string;
  /** pitch / vocal quality */
  texture: string;
  /** emotion / pace */
  delivery: string;
}

/**
 * A concrete TTS voice binding for an agent. `providerId` is an open string at
 * the contract level — the set of available TTS providers is app-defined, and
 * readers must treat an unknown provider as "no bound voice". Deliberately
 * minimal: fields are added here only once a producer actually emits them.
 */
export interface AgentVoiceConfig {
  providerId: string;
  /** Model the voice was selected or enrolled for, when model-bound. */
  modelId?: string;
  voiceId: string;
}

/**
 * Generated agent configuration. Embedded in the persisted stage document
 * (`stage.generatedAgentConfigs`) so clients can hydrate the agent registry
 * without relying on IndexedDB pre-population. Present for generated-roster
 * classrooms; preset classrooms carry `agentIds` instead.
 *
 * The voice fields are optional and additive: documents written before they
 * existed simply lack them, and readers treat an absent voice as "no bound
 * voice" (the TTS path falls back at call time). Adding them did not change
 * the meaning of any existing field, so within this codebase — whose
 * structural validators tolerate unknown fields — the addition is
 * non-breaking and does not bump `DSL_VERSION` (see `version.ts`).
 *
 * It is NOT transparent to schema-validating consumers, however: the
 * generated `stage.schema.json` sets `additionalProperties: false` on every
 * definition, so a cross-language consumer validating against a pinned copy
 * of an older published schema artifact rejects any document that carries
 * these fields. Under strict schema validation, additive fields ARE a
 * breaking change — such consumers must upgrade their schema artifact in
 * lockstep with the documents they accept. (A `DSL_VERSION` bump would not
 * help them: an old schema rejects the new documents either way.)
 */
export interface GeneratedAgentConfig {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  /** Bound TTS voice, when the generation pipeline selected one. */
  voiceConfig?: AgentVoiceConfig;
  /** 3-layer vocal descriptor for automatic voice synthesis/registration. */
  voiceDesign?: VoiceDesign;
}

/**
 * Multi-agent discussion configuration for a single scene.
 */
export interface MultiAgentConfig {
  /** Enable multi-agent for this scene. */
  enabled: boolean;
  /** Which agents to include (from the registry). */
  agentIds: string[];
  /** Optional custom director instructions. */
  directorPrompt?: string;
}

/**
 * Stage - Represents the entire classroom/course.
 */
export interface Stage {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  // Stage metadata
  languageDirective?: string;
  style?: string;
  // Whiteboard data
  whiteboard?: Whiteboard[];
  // Generated video requests keyed by the mediaRef used by PPTVideoElement.
  // Runtime media state lives in the media task store / persisted media files.
  videoManifest?: VideoManifest;
  // Agent IDs selected when this classroom was created
  agentIds?: string[];
  /**
   * Server-generated agent configurations. See {@link GeneratedAgentConfig}.
   */
  generatedAgentConfigs?: GeneratedAgentConfig[];
  /**
   * True when this classroom was generated with Interactive Mode enabled
   * (the INTERACTIVE_OUTLINES prompt branch).
   * Absent on legacy classrooms, imports, and regular-mode generations.
   */
  interactiveMode?: boolean;
  /**
   * True when this classroom was generated with the vocational Task Engine
   * path enabled. This is distinct from `interactiveMode`: task-engine
   * classrooms are interactive, but not every interactive classroom is
   * vocational.
   */
  taskEngineMode?: boolean;
  /**
   * Digests of the course materials this classroom was generated from, in
   * bundle order. A digest is the SHA-256 of the source bytes computed at
   * upload time, so it survives re-uploading the same file and names the same
   * derivation in the extraction archive.
   *
   * This is the only record of the link between a classroom and its materials:
   * the archive is keyed by `(bytes, extractor)` and knows nothing about
   * classrooms, and the chapter directory knows nothing about what has already
   * been generated. Writing it here is what lets the home page recognise that
   * a material which already produced a classroom must not produce a second
   * one, and what lets a classroom report where its content came from.
   *
   * Absent on classrooms generated before this field existed (and on imported
   * ones) — absence means "unknown", never "generated from nothing".
   */
  sourceDigests?: string[];
  /**
   * What kind of lesson this classroom is — an ordinary teaching classroom
   * (`'lesson'`) or a quiz-only classroom generated down the quiz path
   * (`'unitQuiz'`). See {@link LessonKind}.
   *
   * Absent on every classroom generated before this field existed, and read as
   * `'lesson'` there, so a legacy classroom keeps behaving exactly as it did.
   * This is load-bearing rather than decorative: a quiz classroom is built from
   * the same material as the teaching classroom for that material and therefore
   * carries the same `sourceDigests`, so without this field the home page could
   * not tell which of the two a re-upload should reopen.
   */
  lessonKind?: LessonKind;
}

/**
 * Slide content - PPTist Canvas data.
 *
 * `schemaVersion` tags the on-disk shape of this content so future schema
 * changes can ship behind a migration step (see the app's `migrateSlideContent`).
 * Optional for backward compatibility — legacy / pre-versioning data lacks the
 * field and the app normalizes it.
 */
export interface SlideContent {
  type: 'slide';
  schemaVersion?: number;
  // PPTist slide data structure
  canvas: Slide;
}

export interface QuizOption {
  label: string; // Display text
  value: string; // Selection key: "A", "B", "C", "D"
}

export interface QuizQuestion {
  id: string;
  type: 'single' | 'multiple' | 'short_answer';
  question: string;
  options?: QuizOption[];
  answer?: string[]; // Correct answer values: ["A"], ["A","C"], or undefined for text
  analysis?: string; // Explanation shown after grading
  commentPrompt?: string; // Grading guidance for text questions
  hasAnswer?: boolean; // Whether auto-grading is possible
  points?: number; // Points per question (default 1)
}

/**
 * Quiz content - React component props/data.
 */
export interface QuizContent {
  type: 'quiz';
  questions: QuizQuestion[];
}

/**
 * A public source a case narrative is grounded in. Case teaching reads real
 * events, so every claim that can be attributed is attributable: the renderer
 * shows these next to the narrative so a learner can check the case rather
 * than take it on faith. A case built without a search backend carries an
 * empty list — which is itself information, not a silent omission.
 */
export interface CaseSourceRef {
  title: string;
  url: string;
}

/**
 * One chapter knowledge point and what the case shows about it.
 *
 * Structured rather than prose on purpose. "The analysis must tie back to the
 * chapter's key points" is the requirement this whole scene type exists for,
 * and a prompt can only ask for it — a list keyed by the point makes it a
 * property of the data. A rendering that shows the points as headings cannot
 * silently drop one, and a coverage check is a length comparison.
 */
export interface CaseAnalysisEntry {
  /** The knowledge point, named as the chapter names it. */
  point: string;
  /** How this case bears on that point, in the model's own words. */
  bearing: string;
}

/**
 * The staged-reveal analysis of a case, written only when the learner asks.
 *
 * `entries` is the knowledge-point-by-knowledge-point reading of the case.
 * `closing` is the part that does not belong to any single point — the
 * misconception the case traps, the question it leaves open — and is optional
 * because forcing one would manufacture a moral where there may be none.
 */
export interface CaseAnalysis {
  entries: CaseAnalysisEntry[];
  closing?: string;
}

/**
 * A discussion question posed before the analysis is revealed. `point` names
 * the knowledge point the question exercises, so the questions, the narrative
 * and the analysis all hang off the same list of points.
 */
export interface CaseQuestion {
  id: string;
  question: string;
  point?: string;
}

/**
 * One saved case for this chapter — everything a case carries except its
 * discriminant.
 *
 * Deliberately the same fields as {@link CaseContent} minus `type` (and minus
 * the variant list itself), because the fields *above* `caseVariants` on
 * {@link CaseContent} are a mirror of exactly one of these: the one currently
 * on screen. Readers that predate variants (`CaseView` reads `content.narrative`
 * and friends directly) keep working untouched, and a document written before
 * this field existed degrades to a single variant rather than needing a
 * migration.
 *
 * `analysis` belongs to the variant, not to the scene: it explains *this*
 * event against *these* points, so a second case must not inherit the first
 * one's explanation.
 */
export interface CaseVariant {
  caseTitle: string;
  summary?: string;
  knowledgePoints: string[];
  narrative: string;
  discussionQuestions: CaseQuestion[];
  sources?: CaseSourceRef[];
  analysis?: CaseAnalysis;
  /**
   * Whether that analysis is collapsed in the reading view.
   *
   * A per-case fact rather than a scene-wide one, for the same reason
   * `analysis` is: the learner hides the explanation of *this* event, so
   * rotating to the next case shows that case's own state instead of
   * inheriting the one just left. Absent means shown — which is what a
   * freshly generated case reports, and what every document written before
   * this field existed reports.
   */
  analysisHidden?: boolean;
}

/**
 * Case content - a real-world case studied against a chapter's knowledge
 * points.
 *
 * Shaped as a staged reveal rather than a document. The narrative and the
 * questions are generated together and shown first; `analysis` is generated
 * only when the learner asks for it, and is absent until then. That ordering is
 * the pedagogy — a learner who reads the analysis before committing to an
 * answer has been told the answer, not taught the case — so the type keeps the
 * analysis optional rather than making the renderer hide a field it always has.
 */
export interface CaseContent {
  type: 'case';
  /** Case headline: the event, named the way a reader would search for it. */
  caseTitle: string;
  /** Optional one-line framing shown above the narrative. */
  summary?: string;
  /**
   * The chapter knowledge points this case was chosen to teach, by name. The
   * binding — how the case bears on each — is the analysis, not this list.
   */
  knowledgePoints: string[];
  /** The case narrative. Plain text; blank lines separate paragraphs. */
  narrative: string;
  /**
   * Discussion questions, answered before the analysis is shown.
   *
   * Named in full rather than `questions` so it does not collide with
   * {@link QuizContent}'s field of that name. Generated payloads carry no
   * discriminant, so consumers identify them structurally (`'x' in content`);
   * two payload kinds sharing a key would make that check ambiguous and
   * silently narrow to the wrong shape.
   */
  discussionQuestions: CaseQuestion[];
  /**
   * Public sources the narrative is grounded in. Empty when the case came from
   * model knowledge alone (the no-search-backend path).
   */
  sources?: CaseSourceRef[];
  /** The analysis, written only when the learner asks for it. */
  analysis?: CaseAnalysis;
  /**
   * Mirror of the active variant's `analysisHidden` — see
   * {@link CaseContent.caseVariants}. Belongs beside `analysis` rather than on
   * the scene: hiding one case's explanation must not hide another's.
   *
   * Hiding is a display state, not a deletion: the analysis stays in the
   * document, so revealing it again is a flag flip and never a second
   * generation.
   */
  analysisHidden?: boolean;
  /**
   * Every case saved for this chapter, capped at three, in the order they were
   * generated. The fields above mirror `caseVariants[activeVariantIndex]`.
   *
   * Optional, and absent is meaningful: a document written before variants
   * existed holds one case, expressed by the fields above. Readers must treat
   * absence as `[the case above]`, never as "no cases" — see `readVariants` in
   * `lib/classroom/case-variants.ts`, the one place that difference is
   * resolved.
   *
   * A mirror rather than the single source of truth, on purpose: `CaseView`
   * reads the top-level fields, so making the list authoritative would mean
   * changing every reader and migrating every stored document for no visible
   * gain. The cost is two places that can disagree, which is why every write
   * goes through the helpers in `lib/classroom/case-variants.ts`.
   */
  caseVariants?: CaseVariant[];
  /**
   * Which entry of {@link CaseContent.caseVariants} the fields above mirror.
   * Absent on a single-variant document, and read as `0` there.
   */
  activeVariantIndex?: number;
}

/**
 * The universal scene-content subset used by {@link Scene}'s compatibility
 * default. Interactive, PBL and case content are also contract-owned and are
 * composed into concrete scene unions through the generic content parameter.
 */
export type SceneContent = SlideContent | QuizContent;

/**
 * The content-kind-independent fields of a {@link Scene}. Everything except the
 * `type` discriminant and the `content` payload, which {@link Scene} binds
 * together per kind.
 */
export interface SceneCore<TAction = Action> {
  id: string;
  stageId: string; // ID of the parent stage (for data integrity checks)
  title: string;
  order: number; // Display order

  // Actions to execute during playback (app-injected)
  actions?: TAction[];

  // Whiteboards to explain deeply
  whiteboards?: Slide[];

  // Multi-agent discussion configuration
  multiAgent?: MultiAgentConfig;

  // Metadata
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Scene - Represents a single page/scene in the course.
 *
 * The scene-level `type` discriminant is **bound to its `content`**: a
 * slide-typed scene must carry `SlideContent`, a quiz-typed scene `QuizContent`,
 * and so on. This is a real invariant — consumers branch on `scene.type` and
 * then read `scene.content` as the matching shape — so the contract enforces it
 * at the type level rather than leaving the two free to disagree.
 *
 * Implemented as a distributive conditional over `TContent`: the binding holds
 * per member of the content union, so the default `Scene<Action, SlideContent |
 * QuizContent>` is `({ type: 'slide'; content: SlideContent } | { type: 'quiz';
 * content: QuizContent }) & SceneCore`; consumers compose the exported
 * interactive and PBL types into `TContent`, and every member ties its own
 * `type` to its shape.
 *
 * ```ts
 * // app side — widen content; widen actions only if the app adds its own
 * type AppScene = Scene<Action, AppSceneContent>;
 * ```
 *
 * Skeleton-only consumers that reject actions entirely can still opt out with
 * `Scene<never, …>`.
 *
 * @template TAction  - The playback action type (defaults to the standard {@link Action} union).
 * @template TContent - The scene-content union; any object union tagged with a
 *                      `type: {@link SceneType}` discriminant (defaults to the
 *                      slide/quiz compatibility subset). Each member binds its
 *                      own `type`.
 */
export type Scene<
  TAction = Action,
  TContent extends { type: SceneType } = SlideContent | QuizContent,
> = TContent extends unknown
  ? SceneCore<TAction> & { type: TContent['type']; content: TContent }
  : never;

// ---------------------------------------------------------------------------
// Pure discriminant guards
// ---------------------------------------------------------------------------

/**
 * Narrow a candidate to {@link SlideContent}. Accepts any value tagged with a
 * `type: SceneType` discriminant, including a consumer-specialized interactive
 * content union.
 * Pure, no runtime deps.
 */
export function isSlideContent<T extends { type: SceneType }>(
  content: T,
): content is T & SlideContent {
  return content.type === 'slide';
}

/**
 * Narrow a candidate to {@link QuizContent}. Accepts any value tagged with a
 * `type: SceneType` discriminant, including a consumer-specialized interactive
 * content union.
 * Pure, no runtime deps.
 */
export function isQuizContent<T extends { type: SceneType }>(
  content: T,
): content is T & QuizContent {
  return content.type === 'quiz';
}

/**
 * Narrow a candidate to {@link CaseContent}. Accepts any value tagged with a
 * `type: SceneType` discriminant, including a consumer-specialized content
 * union.
 * Pure, no runtime deps.
 */
export function isCaseContent<T extends { type: SceneType }>(
  content: T,
): content is T & CaseContent {
  return content.type === 'case';
}
