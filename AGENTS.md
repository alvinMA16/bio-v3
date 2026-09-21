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

- Scene and background elements use handmade felt / stop-motion textures.
- Core CTA buttons use frosted glass with a subtle pale sage-green tint, soft optical highlights and translucent depth. Avoid opaque beige panels or conspicuous outline-button borders.
- Keep related CTA text and character art grouped and centered; distribute actions rather than crowding the top of the screen.

# UI change discipline

- Present each piece of information only once. Omit headings, counts, status labels, and explanatory copy that add no actionable value; prefer the simplest control that communicates the state.
- Preserve established layout, spacing, positions, and component hierarchy during visual refinements. Color, texture, glass, and highlight requests do not authorize layout redesigns. Implement decorative effects in non-interactive layers outside layout flow.
- When the user requests a wireframe for approval, show it before implementing that component's revised design.

# Agent behavior changes

- Design prompt and Agent constraints as general principles and decision rules that apply across situations. Do not accumulate case-by-case instructions, keyword exceptions, or patches for individual examples. Examples belong in regression tests, not as substitutes for general rules.
- When proposing Agent changes, state which component changes, its current behavior, the proposed behavior, and how the general rule will be verified. If the user requests plan approval, wait for that approval before implementing those changes.
