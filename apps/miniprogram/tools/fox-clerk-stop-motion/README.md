# Fox clerk felt stop-motion sources

Build the production assets in `miniprogram/assets/animations/fox-clerk/`:

```sh
python3 apps/miniprogram/tools/fox-clerk-stop-motion/build_sprites.py
```

The builder requires Pillow.

The shared actor mask follows the rounded felt ear outlines, with room for the
small differences between blink keyframes. Keep the right ear tip and outer
rim inside the mask; a coarse straight polygon previously clipped them in
every action. After rebuilding, run `python3
apps/miniprogram/tools/fox-clerk-stop-motion/validate_ears.py` to check all
frames and generate `qa/all-actions-contact.jpg`, per-action GIFs, and
`qa/ear-validation.json`.

The animation uses three locked, full-canvas layers:

1. static environment;
2. transparent fox and outer board sprite;
3. static inner white panel above the animated layer.

All source frames use the same `853×1844` portrait canvas. The build script
extracts the fox/outer-board silhouette, keeps the inner panel fixed, and packs
lossless WebP sprite sheets.

Key poses:

- `neutral.png`: shared neutral pose and fixed panel source.
- `blink-half.png` and `blink-closed.png`: blink keyframes.
- `talk-quiet.png` and `talk-a.png`: mouth sources; only the mouth region is
  retained so the face lighting and felt texture stay fixed.
- `wave-left.png` and `wave-right.png`: complete full-frame wave poses with one
  consistent four-finger orange felt hand and no contrasting palm pad.
- `environment-plate.png`: static scene with the fox and foreground board
  removed.

The two wave frames receive one global full-frame exposure/color transform to
match the neutral lighting. No local arm translation or pasted hand is used.

Notebook actions (`note` and `nod`, 13 frames at 5 fps) share generated
full-canvas keyframes:

- `notebook-hold.png`: open sage notebook and wooden pencil, eyes forward.
- `notebook-write-full.png`: complete adjacent writing pose, with the pencil
  tip already hidden behind the upright notebook in the source image.
- `notebook-nod.png`: head lowered in a friendly nod, holding the same notebook.

Writing uses the complete actor/board region from each source keyframe. Do not
paste a moving hand or foreground notebook into the writing frames: mismatched
hand textures and positions caused visible jitter. The two whole poses dwell
for 0.6–0.8 seconds instead of alternating every 0.2 seconds. Only the shared
outer silhouette is extracted for the existing scene layers. The notebook
occludes the tip in the source itself; the visible page edges are not writing
surfaces. The experimental `*-v2.png` and `notebook-write-occluded.png` sources
are not used. The approved nod and speech assembly remains unchanged.
Both one-shot actions end in the existing neutral frame. Select them in the
debug console's animation lab, or call `playCharacterAction('note')` /
`playCharacterAction('nod')` on the character page.

`notebookTalk` adds 13 frames at 6 fps using the same approved holding pose and
the existing `talk-quiet` / `talk-a` mouth sources. Only the mouth moves; the
notebook, hands and pencil remain fixed throughout speech. Call
`playCharacterAction('notebookTalk')` or select 拿本子说话 in the animation lab.

Generation used the built-in imagegen tool, sequentially, grounded first in
`neutral.png` and then `notebook-hold.png`. Prompt specifications:

1. Preserve the full portrait, fox identity, needle-felt texture, lighting,
   shelves and blank foreground panel. Add a small open cream notebook with
   sage cover in the left paw (viewer right), and a wooden pencil in the right
   paw touching the page. Keep the face looking forward; no text or collage.
2. Generate one complete adjacent writing keyframe from `notebook-hold.png`.
   Lock the full 853×1844 canvas, camera, texture, face and upright notebook;
   move the writing paw and rigid pencil together about six pixels to viewer
   right. Hide the entire sharpened tip behind the foreground book and hand.
   Never draw on visible page edges, spine, cover or outside the book. Preserve
   full-image alignment: use the whole actor, not a pasted hand patch.
3. Preserve the hold keyframe; gently bow the head with lowered chin/muzzle
   and eyelids for a friendly nod. Keep notebook, pencil, paws and torso fixed.

Run `python3 apps/miniprogram/tools/fox-clerk-stop-motion/preview_notebook.py`
after building to validate the sheets and regenerate `qa/note.gif`,
`qa/nod.gif`, `qa/notebookTalk.gif`, and `qa/notebook-contact.jpg`.
Production assets remain in the shared animation
directory so both the mini program and debug console consume the same sheets.
