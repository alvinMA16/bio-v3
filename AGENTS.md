# Deployment references

- **bio2 / biography-v2**: `ssh root@47.118.18.96`.
  Working Compose directory: `/root/alvin/biography-v2/deploy`.
  Running containers: `deploy-backend-1`, `deploy-db-1`.
  This is the known source of the working Aliyun SMS configuration. The local
  biography-v2 `.env` has placeholders; use the running deployment when needed.
- **bio-v3**: `ssh qs@neozeppelin.com`, application at `/srv/bio-v3`, website
  `https://app.storyofme.cn`, internal debugger at `/internal/`.
- **Calendar OSS reference**: same host, `/home/qs/Calendar3`, container
  `calendar3_server`. Private bucket `calendar-images` in Beijing; CDN
  `image.neozeppelin.com`. Bio-v3 objects belong only under `bio-v3/`.
  See `infra/oss/README.md`; never disable the bucket's public-access block.
- The user has supplied the bio2 host repeatedly. Consult this file and
  `infra/production/README.md` before asking for its location again.
- **Host storage**: the 100 GiB `/dev/nvme1n1` disk is initialized and mounted at `/data`. `/data/docker` and `/data/containerd` are bind-mounted to `/var/lib/docker` and `/var/lib/containerd`; both services require these mounts. This disk is in active use, not an empty spare. See `docs/storage-assessment-2026-09-17.md`.
- Keep credentials out of output and Git. Read the deployment README before
  changing production; do not overwrite bio2 while deploying bio-v3.

# Visual language

- Follow `docs/ui-controls.md` and reuse `apps/debug-console/src/product-controls.css` for product actions. Shared control changes must be reviewed across call states, receipts, folders, and previews; do not introduce a new per-page button style.

- Scene and background elements use handmade felt / stop-motion textures.
- Core CTA buttons use frosted glass with a subtle pale sage-green tint, soft optical highlights and translucent depth. Avoid opaque beige panels or conspicuous outline-button borders.
- Keep related CTA text and character art grouped and centered; distribute actions rather than crowding the top of the screen.

# UI change discipline

- Treat visual consistency as a requirement across every state of a flow, including waiting, paused, recovery, failure, disabled, and active states. Review related states together before shipping; never polish only the state named in the latest report.
- Separate status information from actions with clear spatial grouping. Every action must visibly read as a button; never mix unstyled text actions into status copy. Use a shared frosted-glass treatment with translucent sage tint, optical highlights, depth, and consistent geometry; distinguish primary and secondary actions within that same material family rather than mixing opaque fills, outlines, and bare text. Validate the actual rendered states at phone and desktop sizes before deployment.

- The public entry and `/internal/` must share the same product components, content, styling, and interactions. Device adaptation belongs to the outer viewport and phone frame; do not maintain separate product implementations for public/internal or desktop/mobile.

- User-facing copy should state only what helps the user understand the current state or choose an action. Keep internal processing, storage, transport, provider details, counts, and diagnostic causes in logs unless they change what the user should do. Recovery waiting uses “正在恢复对话”. Apply this principle to all product surfaces and error states.
- Present each piece of information only once. Omit headings, counts, status labels, and explanatory copy that add no actionable value; prefer the simplest control that communicates the state.
- Preserve established layout, spacing, positions, and component hierarchy during visual refinements. Color, texture, glass, and highlight requests do not authorize layout redesigns. Implement decorative effects in non-interactive layers outside layout flow.
- When the user requests a wireframe for approval, show it before implementing that component's revised design.

# Agent behavior changes

- Design prompt and Agent constraints as general principles and decision rules that apply across situations. Do not accumulate case-by-case instructions, keyword exceptions, or patches for individual examples. Examples belong in regression tests, not as substitutes for general rules.
- When proposing Agent changes, state which component changes, its current behavior, the proposed behavior, and how the general rule will be verified. If the user requests plan approval, wait for that approval before implementing those changes.
