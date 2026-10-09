import type { PBLPlannerV2Input, SceneOutline } from '@openmaic/generation';

export function slideOutline(): SceneOutline {
  return {
    id: 'slide-1',
    type: 'slide',
    title: 'Dependency Injection',
    description: 'Explain dependency injection with one concrete example.',
    keyPoints: ['Caller owns dependencies', 'Pure generation seam'],
    order: 1,
  };
}

export function quizOutline(): SceneOutline {
  return {
    id: 'quiz-1',
    type: 'quiz',
    title: 'Dependency Injection Check',
    description: 'Check the core idea.',
    keyPoints: ['Injected collaborators'],
    order: 2,
    quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] },
  };
}

export function widgetOutline(): SceneOutline {
  return {
    id: 'widget-1',
    type: 'interactive',
    title: 'Energy Widget',
    description: 'Explore how energy changes with a slider.',
    keyPoints: ['Move the slider', 'Observe the result'],
    order: 3,
    widgetType: 'simulation',
    widgetOutline: { concept: 'Energy transfer', keyVariables: ['energy'] },
  };
}

export function caseOutline(): SceneOutline {
  return {
    id: 'case-1',
    type: 'case',
    title: 'Externality: the dyeing-wastewater case',
    description: 'Study a documented pollution incident through the externality lens.',
    keyPoints: ['Environmental externality', 'Pigouvian tax', 'Regulatory failure'],
    order: 5,
    caseConfig: { questionCount: 3 },
  };
}

/**
 * A deliberately messy-but-recoverable model response: padding around the text
 * fields, a blank knowledge point, a question with no stem, a question with no
 * id, and four source shapes of which only two are openable.
 */
export function validCaseResponse(): string {
  return JSON.stringify({
    caseTitle: '  Dyeing wastewater discharged into a tributary  ',
    summary: 'A textile mill released untreated dyeing wastewater after dark.',
    knowledgePoints: [
      'Environmental externality',
      '   ',
      '  Pigouvian tax  ',
      'Regulatory failure',
    ],
    narrative:
      'The mill opened its discharge valve after dark, and the tributary ran violet by morning.',
    discussionQuestions: [
      {
        id: 'q_externality',
        question: 'Who ends up paying for the damage, and who priced it in?',
        point: 'Environmental externality',
      },
      { question: 'Why did the tax fail to bite?', point: 'Pigouvian tax' },
      { id: 'q_blank', question: '   ', point: 'Regulatory failure' },
    ],
    sources: [
      { title: ' Official investigation report ', url: ' https://example.gov.cn/report ' },
      { title: 'Title with no URL at all' },
      { title: 'Relative URL', url: 'example.com/not-absolute' },
      { url: 'http://news.example.com/story' },
    ],
  });
}

export function pblOutline(): SceneOutline {
  return {
    id: 'pbl-1',
    type: 'pbl',
    title: 'CSV Data Analyzer',
    description: 'Build a small CSV analysis project.',
    keyPoints: ['CSV', 'DataFrame', 'Summary'],
    teachingObjective: 'Practice an end-to-end data analysis workflow.',
    order: 4,
    pblConfig: {
      projectTopic: 'CSV Data Analyzer',
      projectDescription: 'Build a small CSV analysis project.',
      targetSkills: ['CSV parsing', 'DataFrame analysis', 'Summary writing'],
      issueCount: 2,
    },
  };
}

export function pblPlannerInput(): PBLPlannerV2Input {
  const outline = pblOutline();
  return {
    outline,
    courseContext: { allOutlines: [outline], languageDirective: 'Reply in English.' },
    targetLanguage: 'en-US',
  };
}

export function validPBLResponse(): string {
  return JSON.stringify({
    projectInfo: {
      title: 'CSV Data Analyzer project',
      description: 'Build a tool that reads CSV data and reports findings.',
      learningObjective: 'Practice DataFrame analysis end to end.',
      gains: ['Understand tabular CSV data', 'Inspect a DataFrame', 'Write a concise finding'],
      proficiency: 'beginner',
    },
    instructorRole: {
      name: 'CSV Analysis Coach',
      description: 'I will guide you through each step.',
      systemPrompt: 'You are a warm CSV analysis coach.',
    },
    milestones: [
      {
        title: 'Load the CSV data',
        description: 'Create a small sample and load it.',
        briefing: 'Start with a small CSV sample.',
        completionCriteria: 'A DataFrame has been loaded.',
        debrief: 'The data is ready.',
        microtasks: [
          {
            title: 'Prepare and load a CSV',
            description: 'Create a few rows, load them, and inspect the columns.',
            hints: ['Keep the sample small.'],
          },
        ],
      },
      {
        title: 'Summarize and report',
        description: 'Compute a summary and write findings.',
        briefing: 'Turn the data into an insight.',
        completionCriteria: 'A concise finding is written.',
        debrief: 'The analysis is complete.',
        microtasks: [
          {
            title: 'Write one finding',
            description: 'Choose a useful summary and explain what it means.',
            hints: ['Tie the finding to the rows.'],
          },
        ],
      },
    ],
  });
}
