# privacy-filter-flake

Local [OpenAI Privacy Filter](https://github.com/openai/privacy-filter) service
for redacting secrets and PII before text leaves the machine.

The upstream repo ships a CLI only; this flake wraps the official `opf` package
(CPU torch) in a small HTTP service and pins both the `opf` revision and the
Hugging Face model revision in `version.json`.

## Packages

| Attribute | Contents |
|---|---|
| `packages.<system>.default` | HTTP service (`privacy-filter-server`) |
| `packages.<system>.privacy-filter` | alias of `default` |
| `packages.<system>.opf` | upstream CLI |

`overlays.default` provides `pkgs.privacy-filter` and `pkgs.opf`.

## API

```
POST /redact  {"texts": ["...", "..."]} -> {"redacted": ["...", "..."]}
GET  /health  -> {"ok": true, "ready": false}
```

`PRIVACY_FILTER_HOST` (default `127.0.0.1`) and `PRIVACY_FILTER_PORT`
(default `8787`) control the listener. The model checkpoint is downloaded to
`~/.opf/privacy_filter` on first use (about 2.8 GB); set `OPF_CHECKPOINT` to
override.

The service loads the model lazily in the background. `/health` reports
`ready: false` until loading finishes.

## Usage

```nix
{
  inputs.privacy-filter-flake.url = "github:atomic-235/privacy-filter-flake";
  inputs.privacy-filter-flake.inputs.nixpkgs.follows = "nixpkgs";
}
```

```nix
nixpkgs.overlays = [ inputs.privacy-filter-flake.overlays.default ];
# pkgs.privacy-filter
```

## Updates

`.github/workflows/release.yml` runs weekly (Monday 06:00 UTC): resolve the
newest `opf` commit and HF model revision, update `version.json`, build the
package and image, commit, and move the `v<opf>-<model>` / `latest` tags.
