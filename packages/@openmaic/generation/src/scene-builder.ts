import { nanoid } from 'nanoid';
import type { Action, Slide, SlideTheme } from '@openmaic/dsl';
import type { SceneOutline } from './outline-types.js';
import type {
  CompleteScene,
  GeneratedCaseContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  GeneratedQuizContent,
  GeneratedSlideContent,
} from './scene-types.js';

export interface BuildCompleteSceneOptions {
  /**
   * Stable identity supplied by retrying/upserting consumers. Reusing it turns
   * a replay into the same logical scene instead of appending a duplicate.
   * The default remains a random `nanoid()` for drop-in compatibility.
   */
  sceneId?: string;
}

/** Build a complete, store-independent scene from generated primitives. */
export function buildCompleteScene(
  outline: SceneOutline,
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent
    | GeneratedCaseContent,
  actions: Action[],
  stageId: string,
  options: BuildCompleteSceneOptions = {},
): CompleteScene | null {
  const sceneId = options.sceneId ?? nanoid();
  const timestamps = { createdAt: Date.now(), updatedAt: Date.now() };

  if (outline.type === 'slide' && 'elements' in content) {
    const defaultTheme: SlideTheme = {
      backgroundColor: '#ffffff',
      themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
      fontColor: '#333333',
      fontName: 'Microsoft YaHei',
      outline: { color: '#d14424', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
    };
    const canvas: Slide = {
      id: nanoid(),
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: defaultTheme,
      elements: content.elements,
      background: content.background,
    };
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'slide',
      title: outline.title,
      order: outline.order,
      content: { type: 'slide', canvas },
      actions,
      ...timestamps,
    };
  }

  if (outline.type === 'quiz' && 'questions' in content) {
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'quiz',
      title: outline.title,
      order: outline.order,
      content: { type: 'quiz', questions: content.questions },
      actions,
      ...timestamps,
    };
  }

  if (outline.type === 'interactive' && 'html' in content) {
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'interactive',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'interactive',
        url: '',
        html: content.html,
        widgetType: content.widgetType,
        widgetConfig: content.widgetConfig,
      },
      actions,
      ...timestamps,
    };
  }

  if (outline.type === 'pbl' && 'projectV2' in content) {
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'pbl',
      title: outline.title,
      order: outline.order,
      content: { type: 'pbl', projectV2: content.projectV2 },
      actions,
      ...timestamps,
    };
  }

  // The case payload is keyed off the outline's own type rather than a
  // `'x' in content` probe, because every one of its fields is optional on the
  // wire — the analysis pass returns only `analysis`, and a half-parsed first
  // pass is possible. So it is validated field-by-field instead: without a
  // title and a narrative there is no case, and an empty one must never be
  // assembled into a scene that renders as a blank page.
  if (outline.type === 'case') {
    const caseContent = content as GeneratedCaseContent;
    if (!caseContent.caseTitle || !caseContent.narrative) return null;
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'case',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'case',
        caseTitle: caseContent.caseTitle,
        ...(caseContent.summary ? { summary: caseContent.summary } : {}),
        knowledgePoints: caseContent.knowledgePoints ?? [],
        narrative: caseContent.narrative,
        discussionQuestions: caseContent.discussionQuestions ?? [],
        ...(caseContent.sources && caseContent.sources.length > 0
          ? { sources: caseContent.sources }
          : {}),
        ...(caseContent.analysis ? { analysis: caseContent.analysis } : {}),
      },
      actions,
      ...timestamps,
    };
  }

  return null;
}
