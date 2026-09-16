# Bio-v3 UI artwork on OSS

Calendar on `qs@neozeppelin.com` already uses the private Beijing OSS bucket
`calendar-images` and the authenticated CDN `image.neozeppelin.com`.
Bio-v3 owns the separate **`bio-v3/`** prefix. Do not write outside that prefix.

Runtime artwork is published to `bio-v3/assets/<content-hash>/`, retaining the
`animations/fox-clerk/` and `desk/` paths. The checked-in `assets-manifest.json`
records sizes and SHA-256 hashes. It includes scene artwork, folder artwork and the animation manifest.
Source artwork and QA exports under `tools/` are not runtime assets.

Objects remain private. The bucket blocks public ACLs; do not disable that policy.
The Web debugger requests `/api/v1/ui-assets/<filename>`. The API signs an Aliyun
CDN Type A URL valid for 30 minutes and returns a non-cacheable redirect; the CDN
serves the bytes. Only the generated image allowlist can be signed. No arbitrary
object paths, Calendar files, or user uploads are accepted.

Configure the API privately with `ASSET_CDN_DOMAIN` and `ASSET_CDN_PRIVATE_KEY`,
using Calendar's corresponding `ALIYUN_CDN_*` settings. The API needs no OSS upload
access key. Never commit secrets or signed URLs. Local development without either
setting redirects to bundled artwork; production requires both settings.

To publish updated artwork from the repository root:

```sh
python3 infra/oss/upload-assets.py          # Preview keys and hashes only
python3 infra/oss/upload-assets.py --apply  # Upload privately and verify signed CDN bytes
```

The upload command uses Calendar's existing `oss2` runtime in `calendar3_server`;
credentials stay inside that container. It neither changes Calendar code nor bucket
settings. Uploads forbid overwriting existing keys; retries verify the same bytes.
After successful verification it regenerates the manifest and API allowlist.
Commit these with artwork changes and deploy normally. Keep older prefixes for
application rollback. The mini program still uses its packaged artwork; publishing
the mini program is a separate step. User uploads now have a separate private
OSS implementation; see [materials](../../docs/materials.md).

Future private user materials belong under a separate `bio-v3/` subdirectory with
account authorization, not in the public UI-asset signing allowlist.
