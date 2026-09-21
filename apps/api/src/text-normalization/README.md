# Text normalization

Use this module at model-output boundaries. Syntax recognition is shared; callers choose a destination policy. It does not invoke a model and does not modify prompts or raw traces.

- `createSpeechTextStream()` accepts incremental deltas and a final snapshot. Captions, API response text, and TTS receive the same normalized text. Emitted prefixes never change. Link labels are spoken without destinations.
- `normalizeDocumentBlock()` processes a complete, validated edit block. It retains the block ID, kind, line breaks, and list ordinals, removes presentation markers, preserves link destinations as plain text, and leaves `code` blocks untouched.
- `normalizeDocumentTitle()` applies the document policy to a title.

The parser handles common emphasis, headings, list/quote prefixes, inline code, links/images, fenced code, and pipe tables. It is not a full Markdown renderer or an HTML/security sanitizer. Document code fences outside a code block and unterminated link destinations are rejected for correction instead of silently losing structure or content. Literal markup examples belong in `code` blocks.

`AgentService` connects the speech policy before emitting speech events. `editDocument` connects the document policy after validating raw block shape and escaped-newline rules, before persistence, history creation, and highlight calculation. Only submitted edits are normalized; untouched blocks, historical restores, imports, and source attachments retain their original content. Validation and normalization failures leave the edit batch unsaved.
