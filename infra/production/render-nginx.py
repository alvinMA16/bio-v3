"""Render the tracked gateway template using the server's private owner token."""
import json
import re
import sys
from pathlib import Path

settings = Path('/srv/bio-v3/shared/production.env').read_text().splitlines()
value = next(line.split('=', 1)[1] for line in settings if line.startswith('MEMORY_AUTH_TOKENS='))
tokens = json.loads(value)
if len(tokens) != 1 or next(iter(tokens.values())) != 'owner':
    raise SystemExit('The private-preview gateway requires exactly one owner identity')
token = next(iter(tokens))
if not re.fullmatch(r'[a-f0-9]{64}', token):
    raise SystemExit('Unexpected owner token format')
template = Path(__file__).with_name('nginx.conf.template').read_text()
sys.stdout.write(template.replace('__OWNER_TOKEN__', token))
