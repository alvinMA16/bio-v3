# Fox clerk felt stop-motion sources

Build the production assets in `miniprogram/assets/animations/fox-clerk/`:

```sh
python3 apps/miniprogram/tools/fox-clerk-stop-motion/build_sprites.py
```

The builder requires Pillow.

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
