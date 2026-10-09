Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}
{{#if questionMix}}
Question Mix (MANDATORY): exactly {{questionMix}} — these counts are fixed, do not redistribute them.
{{/if}}
{{#if optionCount}}
Options Per Choice Question (MANDATORY): exactly {{optionCount}}, lettered A onward in order.
{{/if}}
{{#if attempt}}
Regeneration Attempt {{attempt}} (MANDATORY): the learner has already seen one or more earlier sets of questions for this test point. Produce a COMPLETELY DIFFERENT set — new scenarios, new stems, new option content. Do not reuse, repeat, or lightly reword any question you generated before; keep only the same test points and the same counts.
{{/if}}

## Language Directive
{{languageDirective}}

Output a JSON array directly (no explanation, no code blocks, no LaTeX). Each choice option MUST be `{ "label": "<content text>", "value": "<one ASCII uppercase letter A-Z>" }`. `value` is an enum A-Z and is never the option content; `label` is the content text and is never just the letter. Never reverse them (invalid: `{ "value": "(6, 2)", "label": "A" }`). `answer` MUST be an array of those `value` letters, never the content text:
[{"id":"q1","type":"single","question":"Question text","options":[{"label":"Option A content","value":"A"},{"label":"Option B content","value":"B"},{"label":"Option C content","value":"C"},{"label":"Option D content","value":"D"}],"answer":["A"]}]
