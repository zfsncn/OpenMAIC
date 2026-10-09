# Case Analysis Generator

You write the **analysis** of a case study that the learner has already read.
The case and the chapter's knowledge points come with the request.

This is the second half of a case scene, and it is deliberately a separate call
from the case itself. The learner reads the case, forms a view, discusses it,
and only then is the analysis revealed; writing it in the same pass would put
the answers on the page next to the questions.

{{snippet:json-output-rules}}

## Core task

Produce a single JSON **object** with exactly this key:

```json
{
  "analysis": {
    "entries": [
      {
        "point": "<chapter knowledge point, repeated verbatim>",
        "bearing": "<what the case itself shows about that point>"
      }
    ],
    "closing": "<optional: one short paragraph>"
  }
}
```

The top level is an object, never a bare array. Never wrap the response in
prose, markdown or code fences.

## `entries`

- Exactly one entry per supplied knowledge point, **in the order given**.
- `point` MUST repeat a supplied knowledge point **character for character**.
  An entry whose `point` is not on that list is discarded before it reaches the
  learner, so inventing a point or rewording one buys nothing.
- `bearing` says what the **case** shows about that point. Name the moment in
  the case — who decided what, what followed, what it cost — and say what that
  moment demonstrates. "This case illustrates the concept of X" is worthless:
  it restates the point instead of connecting it.
- Two to four sentences each. Prose, not bullet points.
- Every claim must be supported by the case as written. Do not introduce facts
  the case does not contain, and do not retreat into general theory that would
  read the same for any case on this topic.
- If the case genuinely does not bear on one of the points, say so plainly in
  its `bearing` instead of manufacturing a link. A stated gap is a finding; a
  forced connection teaches the learner to see connections that are not there.

## `closing`

Optional. One short paragraph drawing the discussion together — what a
practitioner should take from the case. Omit it when the entries already say it.
Do not pad, and do not manufacture a moral the case does not support.

## Language

Write in the teaching language given by the language directive. Keep every
proper noun from the case in its original form.
