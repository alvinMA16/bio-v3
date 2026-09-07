"""Freeze a completed private run and publish only aggregate metadata to Git."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

from run import ROOT, REPO, save

ARCHIVES = REPO / '.bench-private' / 'archives' / 'voice'
RECORDS = ROOT / 'records'
ARTIFACTS = ('calls.json', 'blind-review.json', 'mapping.json', 'codex-review.json',
             'summary.json', 'per-call.csv', 'report.md', 'findings.md')


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    for relative, expected in manifest['files'].items():
        file = directory / relative
        if not file.resolve().is_relative_to(directory.resolve()) or checksum(file) != expected:
            raise ValueError('Archive verification failed: ' + relative)
    return len(manifest['files'])


def archive(source, run_id):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', run_id):
        raise ValueError('Use a simple run ID without path separators')
    for name in ARTIFACTS:
        if not (source / name).is_file():
            raise ValueError('Missing completed-run artifact: ' + name)
    state = json.loads((source / 'calls.json').read_text())
    summary = json.loads((source / 'summary.json').read_text())
    review = json.loads((source / 'codex-review.json').read_text())
    blind = json.loads((source / 'blind-review.json').read_text())
    if state['fingerprint'] != blind['run_fingerprint'] or review['fingerprint'] != blind['fingerprint']:
        raise ValueError('Run/review mismatch')
    destination = ARCHIVES / run_id
    record_file = RECORDS / (run_id + '.json')
    if destination.exists() or record_file.exists():
        raise FileExistsError('Run ID already archived; choose a new ID')
    destination.mkdir(parents=True, mode=0o700)
    for name in ARTIFACTS:
        shutil.copyfile(source / name, destination / name)
    # Freeze the exact cases/prompts used by the calls, not a subsequently edited dataset.
    (destination / 'cases.jsonl').write_text(''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in state['spec']['cases']))
    (destination / 'candidate-system.txt').write_text(state['spec']['system_prompt'])
    save(destination / 'prices.json', state['spec']['prices'])
    code_dir = destination / 'code'
    code_dir.mkdir(mode=0o700)
    for file in ROOT.iterdir():
        if file.is_file() and file.suffix in ('.py', '.md', '.json', '.jsonl', '.txt', '.sql'):
            shutil.copyfile(file, code_dir / file.name)
    files = {str(f.relative_to(destination)): checksum(f) for f in destination.rglob('*') if f.is_file()}
    manifest = {'archive_version': 1, 'run_id': run_id, 'run_fingerprint': state['fingerprint'],
                'review_fingerprint': review['fingerprint'], 'files': files,
                'code_note': 'Code snapshot is archive-time code. Generation-time runner SHA is retained in calls.json; the two may differ after reporting fixes.'}
    save(destination / 'manifest.json', manifest)
    for file in destination.rglob('*'):
        if file.is_file(): file.chmod(0o600)
    verify(destination)
    cases = state['spec']['cases']
    # Allowlist only aggregates: never export spec/cases/reviews/text or scored_cases.
    record = {'run_id': run_id, 'benchmark_version': 'voice-v0.2',
              'private_archive': str(destination.relative_to(REPO)),
              'manifest_sha256': checksum(destination / 'manifest.json'),
              'run_fingerprint': state['fingerprint'],
              'cases': len(cases), 'sessions': len({c['session_group'] for c in cases}),
              'users': len({c['user_group'] for c in cases}), 'repeats': state['spec']['repeats'],
              'models': {k: v['model'] for k, v in state['spec']['models'].items()},
              'review_method': review['review_method'],
              'quality': summary['quality'], 'measurement': summary['measurement'],
              'limitations': ['20-turn convenience sample; 3 accounts', 'single Codex blind review',
                              'short context windows', 'actual mixed peak/off-peak prices; compare normalized rates too'],
              'storage': 'Code and aggregate metadata are in Git. Full transcripts and outputs are local-only, not a remote backup.'}
    RECORDS.mkdir(exist_ok=True)
    save(record_file, record)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('create', 'verify'))
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--id')
    args = parser.parse_args()
    if args.command == 'verify': print('Verified files:', verify(args.run))
    else:
        if not args.id: parser.error('--id is required for create')
        print('Archived:', archive(args.run, args.id))


if __name__ == '__main__': main()
