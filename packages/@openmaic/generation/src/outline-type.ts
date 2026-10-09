import type { SceneOutline, WidgetOutline } from './outline-types.js';

type SceneType = SceneOutline['type'];

const DEFAULT_QUIZ_CONFIG = {
  questionCount: 3,
  difficulty: 'medium' as const,
  questionTypes: ['single' as const],
};
/**
 * Discussion questions a case poses when the outline states no count. Small on
 * purpose: a case is read and argued over, and a long question list turns the
 * argument into a worksheet.
 */
export const DEFAULT_CASE_QUESTION_COUNT = 3;
const MAX_TARGET_SKILLS = 6;

/** Return a new outline valid by construction for the selected scene type. */
export function changeOutlineType(outline: SceneOutline, newType: SceneType): SceneOutline {
  if (newType === outline.type) {
    return outline;
  }

  const baseOutline: SceneOutline = {
    id: outline.id,
    type: newType,
    title: outline.title,
    description: outline.description,
    keyPoints: outline.keyPoints ?? [],
    order: outline.order,
    ...(outline.teachingObjective !== undefined && {
      teachingObjective: outline.teachingObjective,
    }),
    ...(outline.estimatedDuration !== undefined && {
      estimatedDuration: outline.estimatedDuration,
    }),
    ...(outline.languageNote !== undefined && { languageNote: outline.languageNote }),
    ...(outline.suggestedImageIds !== undefined && {
      suggestedImageIds: outline.suggestedImageIds,
    }),
    ...(outline.mediaGenerations !== undefined && { mediaGenerations: outline.mediaGenerations }),
  };

  switch (newType) {
    case 'quiz':
      return { ...baseOutline, quizConfig: outline.quizConfig ?? { ...DEFAULT_QUIZ_CONFIG } };

    case 'case':
      // The chapter knowledge points are already on `baseOutline.keyPoints`, so
      // switching to a case keeps them and only supplies the case-specific
      // knobs. A case converted from a slide therefore studies the same points
      // the slide taught.
      return {
        ...baseOutline,
        caseConfig: outline.caseConfig ?? { questionCount: DEFAULT_CASE_QUESTION_COUNT },
      };

    case 'interactive': {
      if (outline.widgetType && outline.widgetOutline) {
        return {
          ...baseOutline,
          widgetType: outline.widgetType,
          widgetOutline: outline.widgetOutline,
        };
      }
      const widgetOutline: WidgetOutline = { concept: outline.title || '' };
      return { ...baseOutline, widgetType: 'simulation', widgetOutline };
    }

    case 'pbl': {
      if (outline.pblConfig?.projectTopic) {
        return { ...baseOutline, pblConfig: outline.pblConfig };
      }
      const targetSkills = Array.from(new Set((outline.keyPoints ?? []).filter(Boolean))).slice(
        0,
        MAX_TARGET_SKILLS,
      );
      return {
        ...baseOutline,
        pblConfig: {
          projectTopic: outline.title || '',
          projectDescription: outline.description || '',
          targetSkills,
        },
      };
    }

    case 'slide':
    default:
      return baseOutline;
  }
}
