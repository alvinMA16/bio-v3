"""Validate packed notebook clips and render review contact sheets / GIFs."""
import json
from pathlib import Path
from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent.parent / 'miniprogram/assets/animations/fox-clerk'
QA = HERE / 'qa'
QA.mkdir(exist_ok=True)
manifest = json.loads((ASSETS / 'manifest.json').read_text())
environment = Image.open(ASSETS / 'environment.webp').convert('RGBA')
panel = Image.open(ASSETS / 'inner-panel.webp').convert('RGBA')
contact = Image.new('RGB', (4 * 320, 3 * 250), '#ded8ce')
for row, action in enumerate(['nod', 'note', 'notebookTalk']):
    clip = next(a for a in manifest['animations'] if a['id'] == action)
    sheet = Image.open(ASSETS / f'{action}.webp').convert('RGBA')
    width, height = clip['frameWidth'], clip['frameHeight']
    assert sheet.size == (width * clip['columns'], height * clip['rows'])
    frames = []
    actors = []
    for index in range(clip['columns'] * clip['rows']):
        x, y = index % clip['columns'] * width, index // clip['columns'] * height
        actor = sheet.crop((x, y, x + width, y + height))
        if index >= clip['frameCount']:
            assert actor.getbbox() is None
            continue
        assert actor.getbbox()
        actors.append(actor)
        frame = environment.copy()
        frame.alpha_composite(actor)
        frame.alpha_composite(panel)
        frames.append(frame.convert('RGB'))
    if action == 'notebookTalk':
        # During speech the hands, pencil and book must be pixel-identical.
        for actor in actors[2:-1]:
            assert ImageChops.difference(actors[1].crop((0, 278, 320, 692)), actor.crop((0, 278, 320, 692))).getbbox() is None
    frames[0].save(QA / f'{action}.gif', save_all=True, append_images=frames[1:], duration=round(1000 / clip['fps']), loop=0)
    for column, index in enumerate([1, 3, 4, 8]):
        contact.paste(frames[index].crop((0, 120, 320, 370)), (column * 320, row * 250))
contact.save(QA / 'notebook-contact.jpg')
print('Validated dimensions, occupied/unused cells, fixed speech props; generated 3 GIFs and contact sheet.')
