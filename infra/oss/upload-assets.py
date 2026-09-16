#!/usr/bin/env python3
"""Publish tracked UI artwork through Calendar's existing OSS runtime credentials."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'apps/miniprogram/miniprogram/assets'

# Credentials are read only inside the existing server container, never returned.
REMOTE = r'''
import base64, hashlib, json, sys, time, urllib.request
import config, oss2
payload = json.load(sys.stdin)
prefix = payload['prefix']
assert prefix.startswith('bio-v3/assets/') and '..' not in prefix
bucket = oss2.Bucket(oss2.Auth(config.ALIYUN_ACCESS_KEY_ID, config.ALIYUN_ACCESS_KEY_SECRET),
                    'https://' + config.ALIYUN_OSS_ENDPOINT.removeprefix('https://').removeprefix('http://'),
                    config.ALIYUN_OSS_BUCKET_NAME)
endpoint = config.ALIYUN_OSS_ENDPOINT.removeprefix('https://').removeprefix('http://').rstrip('/')
base = 'https://' + config.ALIYUN_OSS_BUCKET_NAME + '.' + endpoint + '/' + prefix
items = []
for item in payload['files']:
    name = item['path']
    assert not name.startswith('/') and '..' not in name.split('/')
    data = base64.b64decode(item['data'], validate=True)
    assert hashlib.sha256(data).hexdigest() == item['sha256']
    key = prefix + name
    stage = 'upload'
    try:
        bucket.put_object(key, data, headers={
            'Content-Type': item['contentType'],
            'Cache-Control': 'public, max-age=31536000, immutable',
            'x-oss-object-acl': 'private',
            'x-oss-forbid-overwrite': 'true',
            'x-oss-meta-sha256': item['sha256'],
        })
    except oss2.exceptions.ServerError as error:
        if error.status != 409 or error.code != 'FileAlreadyExists':
            raise
    # Verify signed CDN bytes, not merely the authenticated upload response.
    stage = 'signed-cdn-read'
    timestamp = int(time.time()) + 1800
    path = '/' + key
    signature = hashlib.md5(f'{path}-{timestamp}-0-0-{config.ALIYUN_CDN_PRIVATE_KEY}'.encode()).hexdigest()
    url = f'https://{config.ALIYUN_CDN_DOMAIN}{path}?auth_key={timestamp}-0-0-{signature}'
    with urllib.request.urlopen(url, timeout=30) as response:
        assert response.headers.get_content_type() == item['contentType']
        assert hashlib.sha256(response.read()).hexdigest() == item['sha256']
    items.append({k: item[k] for k in ['path', 'sha256', 'bytes', 'contentType']})
print(json.dumps({'baseUrl': base.rstrip('/'), 'prefix': prefix, 'cdnDomain': config.ALIYUN_CDN_DOMAIN, 'files': items}, indent=2))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Upload and verify; default only previews the manifest')
    args = parser.parse_args()
    files = []
    tracked = subprocess.check_output(['git', 'ls-files', '-z', str(ASSETS.relative_to(ROOT))], cwd=ROOT).decode().split('\0')
    for relative in sorted(filter(None, tracked)):
        path = ROOT / relative
        if path.suffix not in {'.png', '.webp', '.json', '.svg'}:
            raise SystemExit('Unexpected runtime asset type: ' + relative)
        data = path.read_bytes()
        files.append({'path': path.relative_to(ASSETS).as_posix(), 'sha256': hashlib.sha256(data).hexdigest(),
                      'bytes': len(data), 'contentType': {'.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml'}[path.suffix],
                      'data': base64.b64encode(data).decode()})
    assert files, 'No tracked runtime assets'
    digest = hashlib.sha256(json.dumps([(item['path'], item['sha256']) for item in files], separators=(',', ':')).encode()).hexdigest()[:16]
    prefix = f'bio-v3/assets/{digest}/'
    if not args.apply:
        print(json.dumps({'prefix': prefix, 'files': [{k: v for k, v in item.items() if k != 'data'} for item in files]}, indent=2))
        return
    guarded = 'import json,sys\ntry:\n exec(' + repr(REMOTE) + ')\nexcept Exception as error:\n print(json.dumps({"errorType":type(error).__name__,"status":getattr(error,"status",None),"code":getattr(error,"code",None),"stage":globals().get("stage"),"message":getattr(error,"message",None)}))\n sys.exit(1)\n'
    command = 'docker exec -i calendar3_server python -c ' + shlex.quote(guarded)
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', 'qs@neozeppelin.com', command],
                            input=json.dumps({'prefix': prefix, 'files': files}), text=True, capture_output=True)
    if result.returncode:
        # Provider errors may contain signed request data; do not echo them.
        try:
            diagnostic = json.loads(result.stdout)
            print(json.dumps({key: diagnostic.get(key) for key in ['errorType', 'status', 'code', 'stage', 'message']}))
        except ValueError:
            pass
        raise SystemExit('OSS upload/verification failed; no client configuration updated. Check access or retry the same version.')
    manifest = json.loads(result.stdout)
    assert manifest['prefix'] == prefix and len(manifest['files']) == len(files)
    (ROOT / 'infra/oss/assets-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    catalog = {Path(item['path']).name: prefix + item['path'] for item in files if item['contentType'].startswith('image/')}
    assert len(catalog) == len(files) - 1, 'Runtime image names must be unique'
    (ROOT / 'apps/api/src/assets').mkdir(exist_ok=True)
    (ROOT / 'apps/api/src/assets/asset-catalog.ts').write_text(
        '// Generated by infra/oss/upload-assets.py after signed CDN verification.\n'
        + 'export const UI_ASSETS: Record<string, string> = ' + json.dumps(catalog, indent=2) + ';\n')
    print(f'Uploaded and verified {len(files)} files ({sum(item["bytes"] for item in files)} bytes).')
    print(manifest['baseUrl'])


if __name__ == '__main__':
    main()
