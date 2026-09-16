"""Render the tracked gateway template using the server's private owner token."""
import json
import re
import sys
from pathlib import Path

settings = Path('/srv/bio-v3/shared/production.env').read_text().splitlines()
template = Path(__file__).with_name('nginx.conf.template').read_text()
if 'AUTH_ENABLED=true' in settings:
    sys.stdout.write(template.replace('__PREVIEW_AUTH__', 'auth_basic off;').replace('__AUTHORIZATION__', '$http_authorization'))
    raise SystemExit(0)
value = next(line.split('=', 1)[1] for line in settings if line.startswith('MEMORY_AUTH_TOKENS='))
tokens = json.loads(value)
if len(tokens) != 1 or next(iter(tokens.values())) != 'owner':
    raise SystemExit('The private-preview gateway requires exactly one owner identity')
token = next(iter(tokens))
if not re.fullmatch(r'[a-f0-9]{64}', token):
    raise SystemExit('Unexpected owner token format')
sys.stdout.write(template.replace('__PREVIEW_AUTH__', 'auth_basic "Bio private preview";\n    auth_basic_user_file /etc/nginx/bio-v3.htpasswd;').replace('__AUTHORIZATION__', '"Bearer ' + token + '"'))
