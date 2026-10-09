Generate a unit quiz for the chapter below.

---

## Requirement

{{requirement}}

---

{{userProfile}}

## Chapter Material

### Chapter Content

{{pdfContent}}

### Available Images

{{availableImages}}

---

## Constraints (MANDATORY)

1. `outlines` contains **exactly one** scene, and its `type` is `"quiz"`.
2. That scene's `quizConfig.questionMix` is 5 single-choice questions, 5
   multiple-choice questions and 1 discussion question — exactly as specified in
   the system prompt, not a free choice.
3. Every question must be answerable from the chapter content above. Do not
   invent facts the chapter does not state.
4. `keyPoints` must name knowledge points that actually occur in the chapter —
   they are what the questions are built from.
5. Author everything in the teaching language inferred in the system prompt's
   Language Inference step.
