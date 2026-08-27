"""Build the fox stop-motion assets as three locked, full-canvas layers."""

from pathlib import Path
import json
import math

from PIL import Image, ImageDraw, ImageFilter, ImageStat


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
        raised_arm = [
            (326, 714), (294, 684), (255, 678), (218, 686), (184, 704),
            (176, 744), (184, 783), (214, 817), (263, 839), (306, 826),
            (332, 790), (337, 750),
        ] if pose == "wave-left" else [
            (319, 719), (300, 695), (283, 685), (267, 688), (248, 704),
            (229, 716), (220, 741), (225, 774), (240, 807), (264, 824),
            (294, 819), (318, 794), (330, 759),
        ]
        draw.polygon(points(raised_arm), fill=255)
        hand_box = [(176, 678), (307, 790)] if pose == "wave-left" else [(219, 682), (307, 775)]
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
            "wave": "完整全画幅姿态统一曝光后慢速摆动；四指纯橙色毛毡手保持不变",
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
        "wave-left": match_full_frame_lighting(normalized_image("wave-left.png", size), neutral),
        "wave-right": match_full_frame_lighting(normalized_image("wave-right.png", size), neutral),
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
        actor["wave-left"], actor["wave-left"], actor["wave-left"],
        actor["wave-right"], actor["wave-right"], actor["wave-right"],
        actor["wave-left"], actor["wave-left"], actor["wave-left"],
        actor["wave-right"], actor["wave-right"], actor["wave-right"],
    ]

    animations = [
        write_sheet(blink_frames, "blink"),
        write_sheet(talk_frames, "talk"),
        write_sheet(wave_frames, "wave"),
    ]
    manifest = {
        "version": 3,
        "character": "fox-clerk",
        "style": "needle-felt stop-motion",
        "frameMode": "three-layer",
        "sourceSize": {"width": neutral.width, "height": neutral.height},
        "layers": {
            "environment": {"name": "背景环境", "src": "/animations/fox-clerk/environment.webp"},
            "actorBoard": {"name": "狐狸 + 外板", "kind": "animated-sprite"},
            "innerPanel": {"name": "内层白框", "src": "/animations/fox-clerk/inner-panel.webp"},
        },
        "backgroundPolicy": "背景环境、狐狸 + 外板、内层白框使用同尺寸画布独立叠放；白框永远保持固定坐标",
        "animations": animations,
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
