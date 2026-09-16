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
- `notebook-write-down.png` and `notebook-write-down-stroke.png`: bowed head,
  eyes on the page, adjacent pencil strokes; the tip stays behind the book.
- `notebook-blink.png`: closed-eye source for a brief blink while holding the book.
- `notebook-nod.png`: head lowered in a friendly nod, holding the same notebook.

Writing uses the complete actor/board region from each source keyframe. Do not
paste a moving hand or foreground notebook into the writing frames: mismatched
hand textures and positions caused visible jitter. Runtime writing keeps the
head down through a complete bout, pauses to read, then raises the head and
blinks before another bout. Processing uses longer strokes and reading pauses.
The bowed head uses a separate silhouette to avoid retaining background pixels
around the lowered ears. The notebook
occludes the tip in the source itself; the visible page edges are not writing
surfaces. The experimental `*-v2.png` and `notebook-write-occluded.png` sources
and `notebook-write-active.png` are not used. The approved nod and speech assembly remains unchanged.
The sheets retain neutral bookends for compatibility, but the shared runtime
controller excludes them, including during notebook speech. Select actions in the
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
4. Built-in imagegen edit of `notebook-write-active.png`: preserve the exact
   portrait composition, lighting, character, notebook, hands and pencil; bow
   the head forward about 15 degrees, lower the muzzle, keep eyes gently open
   and visibly looking down at the page/pencil tip. No redesign or text.
5. Built-in imagegen edit of `notebook-write-down.png`: keep the bowed head,
   gaze and scene fixed; tilt the rigid pencil and writing paw slightly left,
   about 12 source pixels at its upper end. Keep the tip hidden inside the book.
6. Built-in imagegen edit of `notebook-hold.png`: change only both eyes to
   thin relaxed closed eyelids for a brief blink. Preserve head, mouth, props,
   lighting and canvas. The builder retains only this generated eye region.

The 13-frame note sheet uses frame 1 for holding, 2/9 for lowering/raising,
3–8 for bowed writing/reading, 10 for holding and 11 for blinking; 0/12 are
legacy bookends excluded by runtime. Waiting uses frame 11 for 130 ms every
8–14 seconds. Speech never plays this blink frame.

Run `python3 apps/miniprogram/tools/fox-clerk-stop-motion/preview_notebook.py`
after building to validate the sheets and regenerate `qa/note.gif`,
`qa/nod.gif`, `qa/notebookTalk.gif`, and `qa/notebook-contact.jpg`.
Production assets remain in the shared animation
directory so both the mini program and debug console consume the same sheets.
