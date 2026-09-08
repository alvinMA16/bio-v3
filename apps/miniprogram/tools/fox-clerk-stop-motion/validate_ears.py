"""Check ear coverage in every packed frame and render all-action previews."""
import json
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent.parent / 'miniprogram/assets/animations/fox-clerk'
QA = HERE / 'qa'
QA.mkdir(exist_ok=True)
manifest = json.loads((ASSETS / 'manifest.json').read_text())
environment = Image.open(ASSETS / 'environment.webp').convert('RGBA')
panel = Image.open(ASSETS / 'inner-panel.webp').convert('RGBA')
contact = Image.new('RGB', (4 * 320, len(manifest['animations']) * 250), '#ded8ce')
checked = 0
for row, clip in enumerate(manifest['animations']):
    sheet = Image.open(ASSETS / (clip['id'] + '.webp')).convert('RGBA')
    w, h = clip['frameWidth'], clip['frameHeight']
    assert sheet.size == (w * clip['columns'], h * clip['rows'])
    frames = []
    for index in range(clip['columns'] * clip['rows']):
        x, y = index % clip['columns'] * w, index // clip['columns'] * h
        actor = sheet.crop((x, y, x + w, y + h))
        if index >= clip['frameCount']:
            assert actor.getbbox() is None
            continue
        alpha = actor.getchannel('A')
        # Interior felt landmarks at both ear tips and the right outer rim.
        # In the old mask the right tip/rim were transparent or partly cut.
        for sx, sy in [(300, 407), (546, 402), (560, 427), (564, 470)]:
            px, py = round(sx * w / 853), round(sy * h / 1844)
            assert alpha.getpixel((px, py)) >= 250, (clip['id'], index, sx, sy)
        frame = environment.copy()
        frame.alpha_composite(actor)
        frame.alpha_composite(panel)
        frames.append(frame.convert('RGB'))
        checked += 1
    for column, index in enumerate([0, min(3, len(frames)-1), min(4, len(frames)-1), min(8, len(frames)-1)]):
        contact.paste(frames[index].crop((0, 120, 320, 370)), (column * 320, row * 250))
    frames[0].save(QA / (clip['id'] + '.gif'), save_all=True, append_images=frames[1:], duration=round(1000/clip['fps']), loop=0)
contact.save(QA / 'all-actions-contact.jpg')
(QA / 'ear-validation.json').write_text(json.dumps({'version': manifest['version'], 'actions': len(manifest['animations']), 'framesChecked': checked, 'earCoverage': 'passed'}, indent=2) + '\n')
print(f'Validated ear coverage, geometry and unused cells across {checked} frames.')
