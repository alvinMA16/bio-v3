# Document narration experiment — 2026-10-21

`narrate_document` reads an owned, version-pinned document directly into the voice
runtime. The model supplies `scope: all | visible | block | resume`, an optional
`documentId`, optional `expectedVersion`, and `blockId` for block scope. The tool
returns compact completion metadata only after playback acknowledgements finish.
The runtime does not emit manuscript text as model-generated speech events.

The Agent still has one follow-up model call after the tool completes. It no
longer has a model call at each internal reading page. Voice runtime context
contains document metadata, block IDs and the reported visible text rather than
an automatic full manuscript copy. `read_document` remains available for edits
and discussion. Previously saved history is not rewritten or purged.

## Measured comparison

One controlled run, Gemini `gemini-3.8-flash`, temperature 0, LOW thinking, the
same synthetic Chinese story (1,395 UTF-16 characters, three legacy reading
pages). Actual provider usage, not a character-to-token estimate:

| Metric | Old tool loop | New narration tool | Reduction |
| --- | ---: | ---: | ---: |
| Model requests | 4 | 2 | 50% |
| Cumulative input tokens | 34,358 | 11,142 | 67.6% |
| Output tokens, including reported thinking | 1,127 | 54 | 95.2% |
| Input + output tokens | 35,485 | 11,196 | 68.4% |
| Model-generated text characters | 1,444 | 39 | — |
| Original characters handed directly to playback | 0 | 1,395 | — |

Raw aggregate usage is in `result-2026-10-21.json`. No private manuscript or model
response text is saved in that result. This is one sample, not a fleet average
or a monetary cost prediction. Both arms reported zero cached tokens. Production
history, cache hits, visible text, memory and additional model decisions affect
absolute usage and savings. The new arm includes both the independent tool and
compact runtime context; it is not an isolated measurement of either change.

Tool execution, workspace files and simulated playback run locally. Only model
requests are relayed through the existing container to retain credentials on the
server. The relay does not invoke the production Agent, read production user data,
or change its configuration. The fixture has no conversation history, memory,
search or explicit cache. Playback is immediately acknowledged, so measured
request durations are **not** real voice startup or pause measurements.

## Reproduce

Build the API first. Pin the old source revision, rather than using a future HEAD
that already contains the new tool:

```sh
pnpm --filter @bio/api build
NARRATION_BASELINE=c167faa1f9cc5a12ef66ef13eb1d3d1c149f757b node bench/narration/compare.mjs --live --output=/tmp/narration-comparison.json
```

Live mode uses only the synthetic fixture in the script. It requires the configured
SSH access and Gemini service, and incurs model usage. Omit `--live` for local
content-path validation. Optional `--trace=/absolute/path/to/trace.jsonl` is
**offline only**: extract a document from a trace and check direct character
coverage without sending it to the model service. Offline mode does not measure
tokens; zero model calls there must not be reported as a token benchmark.

## Playback and recovery semantics

- Original text is split deterministically at natural boundaries, at most 180
  Unicode characters per chunk, without splitting surrogate pairs. Offsets stay
  in the original document's UTF-16 coordinates.
- TTS requests remain serial, but they are not gated on previous playback ending.
  The existing 20-second/8-second high/low watermarks bound audio ahead of playback.
  This removes per-page model waits; it cannot eliminate provider/network stalls
  or guarantee seamless prosody across separate TTS requests.
- A checkpoint advances only when the client acknowledges a complete audio chunk.
  On interruption, the unfinished chunk can repeat on resume (at most 180 Unicode
  characters), rather than risk skipping unheard text. Checkpoints persist in the
  account/conversation workspace snapshot. Cross-conversation resume is not provided.
- Version changes reject resume; ordinary new playback pins its fetched version.
  No silent switch to a new version occurs midway through the audio.
- Manual scrolling remains independent. Only explicit `all` restores follow mode;
  page updates driven by playback completion do not force it back on.
- A runtime without playback acknowledgement support rejects narration before
  sending audio. TTS partial failure is not retried, cancellation stops queued
  chunks, and late playback receipts do not advance cancelled checkpoints.
- Human playback time is excluded from the Agent generation timeout. The existing
  TTS timeout and playback-stall timeout still apply.

Local validation: full `pnpm typecheck` and `pnpm test`; targeted tests additionally
cover real SDK tool selection/result handling with a local mock model, original
text fidelity, viewport range merging, persistence/resume, stale versions,
preparation ahead of playback, partial TTS failure and cancellation. Database-only
tests skip when their test databases are absent; this is not the deployment gate.
No production deployment or real-device audio continuity measurement was performed.
