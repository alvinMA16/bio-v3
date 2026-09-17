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
- Keep credentials out of output and Git. Read the deployment README before
  changing production; do not overwrite bio2 while deploying bio-v3.

# Visual language

- Scene and background elements use handmade felt / stop-motion textures.
- Core CTA buttons use frosted glass with a subtle pale sage-green tint, soft optical highlights and translucent depth. Avoid opaque beige panels or conspicuous outline-button borders.
- Keep related CTA text and character art grouped and centered; distribute actions rather than crowding the top of the screen.
