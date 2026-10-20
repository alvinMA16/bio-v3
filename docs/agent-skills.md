# Product Agent skills

Interactive sessions discover product-owned skills with Pi's `loadSkills` parser
from `apps/api/skills/`. Each skill has a named directory and `SKILL.md` with
standard `name` and `description` YAML frontmatter. Add a directory to extend the
catalog; no per-skill registration or keyword router is needed.

`src/agent/skills.ts` advertises only names and descriptions in the system prompt.
The model calls `load_skill(name)` to read the complete instructions. Tool results
enter normal session history; if compaction leaves only a summary, the model is
instructed to reload before relying on the skill. Skill selection remains a model
decision, not a deterministic guarantee.

Default home/project/session discovery remains disabled (`noSkills: true`).
Product discovery uses explicit paths with `includeDefaults: false`. This is
intentional: Pi's default skill prompt requires the general `read` tool, which the
product does not expose. The custom catalog and loader provide the corresponding
discovery and reading capabilities without granting filesystem access. Invalid
metadata, duplicate names and resolved paths outside the product root fail session
creation. Content is snapshotted for each session.

Skills are shipped with application source in the production image, outside
account data. The root is resolved relative to the module and works from both
`src/agent` and `dist/agent`; distribution must retain `apps/api/skills` beside
`dist`. Background memory processing does not load writing skills.

The writing catalog separates `travel-writing` (游记写作: journey observations,
scenes, encounters and personal travel experience) from `memoir-writing`
(回忆录写作: life episodes, relationships and the distinction between lived and
retrospective perspectives). Both descriptions advertise their purpose and
boundaries before loading. Select by the intended article's focus, not by place
names or references to the past; a trip may be background to a relationship memoir.
Ordinary conversation, summaries and local copy edits do not require either skill.
User intent and shared factual boundaries remain in the core prompt.

## Validation

Run the API build and `node --test apps/api/test/skills.test.mjs` from the repository
root. Tests cover automatic discovery, deferred content, name-only access,
resource boundaries, cancellation and packaged skill availability.

For model evaluation, use a separate test session with synthetic or authorized
source material. Compare a travel narrative request, a relationship recollection,
a summary request and a local wording correction. Observe skill selection and
tool ordering, then inspect the output for retained distinctive details, sensible
emphasis, the narrator's voice and absence of invented facts or emotions. Include
a request for a plan only: it may load instructions but must not edit a document.
Also check reloading after compaction. Automated loader tests alone do not prove
writing quality or reliable model selection.
