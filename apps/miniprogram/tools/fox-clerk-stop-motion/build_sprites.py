"""Build the fox stop-motion assets as three locked, full-canvas layers."""

from pathlib import Path
import json
import math

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "source"
OUTPUT = HERE.parent.parent / "miniprogram" / "assets" / "animations" / "fox-clerk"
FRAME_WIDTH = 320
FPS_BY_ACTION = {"blink": 8, "talk": 6, "wave": 5}
MASK_SCALE = 4


def normalized_image(name: str, size: tuple[int, int]) -> Image.Image:
    return Image.open(SOURCE / name).convert("RGBA").resize(size, Image.Resampling.LANCZOS)


def rounded_mask(size: tuple[int, int], box: tuple[int, int, int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(box, radius=radius, fill=255)
    return mask


def actor_mask(size: tuple[int, int], pose: str) -> Image.Image:
    """A stable full-canvas silhouette for the fox plus the board's outer shell."""
    width, height = size
    sx, sy = width / 853, height / 1844
    hi_size = (width * MASK_SCALE, height * MASK_SCALE)
    mask = Image.new("L", hi_size)
    draw = ImageDraw.Draw(mask)

    def points(values: list[tuple[int, int]]) -> list[tuple[int, int]]:
        return [(round(x * sx * MASK_SCALE), round(y * sy * MASK_SCALE)) for x, y in values]

    # The complete fox silhouette. Deliberately shared by all face-only poses so
    # those animations cannot introduce edge jitter.
    fox = [
        (276, 494), (272, 406), (294, 392), (322, 402), (357, 452),
        (397, 443), (449, 450), (497, 398), (526, 392), (552, 409),
        (559, 492), (581, 522), (592, 574), (589, 625), (567, 678),
        (544, 704), (570, 726), (626, 716), (657, 736), (665, 779),
        (651, 823), (620, 844), (563, 849), (535, 842), (520, 868),
        (468, 875), (433, 845), (376, 845), (345, 877), (293, 871),
        (260, 848), (251, 801), (258, 752), (282, 720), (307, 704),
        (276, 682), (254, 650), (245, 606), (251, 548),
    ]
    draw.polygon(points(fox), fill=255)

    if pose.startswith("wave"):
        # Each complete generated frame has its own full-character silhouette.
        raised_arms = {
            "wave-rise": [
                (332, 714), (305, 718), (278, 733), (258, 742), (271, 719),
                (275, 690), (258, 671), (235, 671), (220, 686), (202, 678),
                (185, 697), (183, 730), (198, 756), (219, 768), (227, 797),
                (250, 818), (282, 819), (311, 796), (330, 760),
            ],
            "wave-left": [
            (331, 710), (298, 693), (260, 696), (230, 690), (241, 665),
            (238, 625), (220, 609), (202, 620), (185, 598), (159, 590),
            (142, 612), (140, 651), (162, 686), (185, 700), (198, 738),
            (218, 772), (252, 787), (286, 772), (309, 745),
            ],
            "wave-right": [
            (331, 716), (305, 704), (278, 704), (262, 697), (269, 674),
            (257, 642), (236, 631), (214, 638), (192, 628), (177, 644),
            (176, 678), (189, 706), (207, 720), (211, 756), (229, 788),
            (260, 805), (292, 792), (315, 761),
            ],
            "wave-lower": [
                (331, 716), (310, 723), (288, 743), (280, 735), (292, 714),
                (282, 696), (257, 702), (244, 716), (224, 711), (207, 726),
                (205, 756), (220, 781), (240, 791), (249, 814), (276, 829),
                (306, 818), (328, 787),
            ],
        }
        hand_boxes = {
            "wave-rise": [(179, 665), (282, 795)],
            "wave-left": [(136, 585), (245, 710)],
            "wave-right": [(172, 624), (273, 735)],
            "wave-lower": [(200, 695), (300, 815)],
        }
        draw.polygon(points(raised_arms[pose]), fill=255)
        hand_box = hand_boxes[pose]
        draw.ellipse((*points(hand_box)[0], *points(hand_box)[1]), fill=255)

    # Outer board layer. The fixed inner panel is punched out below.
    draw.rectangle((0, round(842 * sy * MASK_SCALE), hi_size[0], hi_size[1]), fill=255)
    panel_box = (
        round(22 * sx * MASK_SCALE), round(878 * sy * MASK_SCALE),
        round(831 * sx * MASK_SCALE), round(1837 * sy * MASK_SCALE),
    )
    draw.rounded_rectangle(panel_box, radius=round(42 * sx * MASK_SCALE), fill=0)

    mask = mask.resize(size, Image.Resampling.LANCZOS)
    return mask.filter(ImageFilter.GaussianBlur(0.45))


def actor_frame(image: Image.Image, pose: str) -> Image.Image:
    result = image.copy()
    result.putalpha(actor_mask(image.size, pose))
    return result


def keep_only_wave_motion(image: Image.Image, reference: Image.Image, pose: str) -> Image.Image:
    """Lock the face, body, and board while retaining the generated moving arm."""
    size = image.size
    sx, sy = size[0] / 853, size[1] / 1844

    # The raised appendage lives outside the neutral silhouette. The shoulder
    # patch also replaces the original resting paw so it cannot appear twice.
    raised_appendage = ImageChops.subtract(actor_mask(size, pose), actor_mask(size, "neutral"))
    shoulder_patch = Image.new("L", size)
    ImageDraw.Draw(shoulder_patch).rounded_rectangle(
        (round(235 * sx), round(695 * sy), round(390 * sx), round(880 * sy)),
        radius=round(46 * sx),
        fill=255,
    )
    motion_mask = ImageChops.lighter(raised_appendage, shoulder_patch)
    motion_mask = motion_mask.filter(ImageFilter.GaussianBlur(round(5 * sx)))
    return Image.composite(image, reference, motion_mask)


def keep_only_mouth(image: Image.Image, reference: Image.Image) -> Image.Image:
    """Use one fixed fox plate and retain only the mouth articulation."""
    mask = Image.new("L", image.size)
    ImageDraw.Draw(mask).ellipse((332, 615, 516, 744), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(7))
    return Image.composite(image, reference, mask)


def match_full_frame_lighting(image: Image.Image, reference: Image.Image) -> Image.Image:
    """Apply one global color transform; never splice or replace a local region."""
    sample_mask = Image.new("L", image.size)
    ImageDraw.Draw(sample_mask).ellipse((250, 440, 590, 720), fill=255)
    source_rgb = image.convert("RGB")
    reference_rgb = reference.convert("RGB")
    source_stats = ImageStat.Stat(source_rgb, sample_mask)
    reference_stats = ImageStat.Stat(reference_rgb, sample_mask)

    luts: list[list[int]] = []
    for channel in range(3):
        scale = reference_stats.stddev[channel] / max(source_stats.stddev[channel], 1)
        scale = min(1.05, max(0.95, scale))
        source_mean = source_stats.mean[channel]
        reference_mean = reference_stats.mean[channel]
        luts.append([
            max(0, min(255, round((value - source_mean) * scale + reference_mean)))
            for value in range(256)
        ])

    corrected = source_rgb.point(luts[0] + luts[1] + luts[2]).convert("RGBA")
    corrected.putalpha(image.getchannel("A"))
    return corrected


def write_sheet(frames: list[Image.Image], action: str, columns: int = 4) -> dict:
    target_height = round(frames[0].height * FRAME_WIDTH / frames[0].width)
    frames = [frame.resize((FRAME_WIDTH, target_height), Image.Resampling.LANCZOS) for frame in frames]
    frame_width, frame_height = frames[0].size
    rows = math.ceil(len(frames) / columns)
    sheet = Image.new("RGBA", (frame_width * columns, frame_height * rows))
    for index, frame in enumerate(frames):
        sheet.alpha_composite(frame, ((index % columns) * frame_width, (index // columns) * frame_height))
    sheet.save(OUTPUT / f"{action}.webp", "WEBP", lossless=True, method=6)
    fps = FPS_BY_ACTION[action]
    return {
        "id": action,
        "name": {"blink": "眨眼", "talk": "说话", "wave": "挥手问候"}[action],
        "description": {
            "blink": "狐狸层切换睁眼、半闭和闭眼姿态；环境与白框保持静止",
            "talk": "整张狐狸与板子完全固定，只切换嘴部口型，消除脸部纹理闪动",
            "wave": "固定狐狸身体与板子，仅让四指纯橙色毛毡手臂完成抬手、慢速摆动和收手",
        }[action],
        "src": f"/animations/fox-clerk/{action}.webp",
        "frameCount": len(frames),
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "columns": columns,
        "rows": rows,
        "fps": fps,
        "durationMs": round(len(frames) / fps * 1000),
    }


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    neutral = Image.open(SOURCE / "neutral.png").convert("RGBA")
    size = neutral.size
    poses = {
        "neutral": neutral,
        "blink-half": normalized_image("blink-half.png", size),
        "blink-closed": normalized_image("blink-closed.png", size),
        "talk-quiet": keep_only_mouth(normalized_image("talk-quiet.png", size), neutral),
        "talk-a": keep_only_mouth(normalized_image("talk-a.png", size), neutral),
        "wave-rise": keep_only_wave_motion(
            match_full_frame_lighting(normalized_image("wave-rise.png", size), neutral), neutral, "wave-rise",
        ),
        "wave-left": keep_only_wave_motion(
            match_full_frame_lighting(normalized_image("wave-left.png", size), neutral), neutral, "wave-left",
        ),
        "wave-right": keep_only_wave_motion(
            match_full_frame_lighting(normalized_image("wave-right.png", size), neutral), neutral, "wave-right",
        ),
        "wave-lower": keep_only_wave_motion(
            match_full_frame_lighting(normalized_image("wave-lower.png", size), neutral), neutral, "wave-lower",
        ),
    }
    actor = {name: actor_frame(image, name) for name, image in poses.items()}

    output_size = (FRAME_WIDTH, round(size[1] * FRAME_WIDTH / size[0]))
    environment = normalized_image("environment-plate.png", size).convert("RGB").resize(output_size, Image.Resampling.LANCZOS)
    environment.save(OUTPUT / "environment.webp", "WEBP", quality=92, method=6)

    panel_mask = rounded_mask(size, (22, 878, 831, 1837), 42)
    panel = neutral.copy()
    panel.putalpha(panel_mask)
    panel.resize(output_size, Image.Resampling.LANCZOS).save(OUTPUT / "inner-panel.webp", "WEBP", lossless=True, method=6)

    blink_frames = [
        actor["neutral"], actor["neutral"], actor["blink-half"], actor["blink-closed"],
        actor["blink-closed"], actor["blink-half"], actor["neutral"], actor["neutral"], actor["neutral"],
    ]
    talk_frames = [
        actor["neutral"], actor["neutral"], actor["talk-quiet"], actor["talk-quiet"],
        actor["talk-a"], actor["talk-a"], actor["talk-quiet"], actor["neutral"],
        actor["talk-a"], actor["talk-quiet"], actor["neutral"], actor["neutral"], actor["neutral"],
    ]
    wave_frames = [
        actor["wave-rise"],
        actor["wave-left"], actor["wave-left"], actor["wave-left"],
        actor["wave-right"], actor["wave-right"], actor["wave-right"],
        actor["wave-left"], actor["wave-left"], actor["wave-left"],
        actor["wave-right"], actor["wave-right"], actor["wave-right"],
        actor["wave-lower"],
        actor["neutral"],
    ]

    animations = [
        write_sheet(blink_frames, "blink"),
        write_sheet(talk_frames, "talk"),
        write_sheet(wave_frames, "wave"),
    ]
    manifest = {
        "version": 6,
        "character": "fox-clerk",
        "style": "needle-felt stop-motion",
        "frameMode": "three-layer",
        "sourceSize": {"width": neutral.width, "height": neutral.height},
        "layers": {
            "environment": {"name": "背景环境", "src": "/animations/fox-clerk/environment.webp"},
            "actorBoard": {"name": "狐狸 + 外板", "kind": "animated-sprite"},
            "innerPanel": {"name": "内层白框", "src": "/animations/fox-clerk/inner-panel.webp"},
        },
        "backgroundPolicy": "背景环境、固定狐狸身体 + 外板、运动手臂、内层白框使用锁定画布叠放；白框永远保持固定坐标",
        "playbackPolicy": "首次进入播放一次挥手问候，随后保持静止，并以较长随机间隔偶发眨眼",
        "animations": animations,
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
