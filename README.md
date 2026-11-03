# privacy-filter-flake

Local [OpenAI Privacy Filter](https://github.com/openai/privacy-filter) service
for redacting secrets and PII before text leaves the machine.

Runs the **ONNX q4** build of the model on CPU with `onnxruntime`
(~1 GB RSS, no PyTorch). The upstream repo ships a PyTorch CLI only; this flake
wraps the ONNX export in a small HTTP service.

## Packages

| Attribute | Contents |
|---|---|
| `packages.<system>.default` | HTTP service (`privacy-filter-server`) |
| `packages.<system>.privacy-filter` | alias of `default` |

`overlays.default` provides `pkgs.privacy-filter`.

## API

```
POST /redact  {"texts": ["...", "..."]} -> {"redacted": ["...", "..."]}
GET  /health  -> {"ok": true, "ready": false}
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `PRIVACY_FILTER_HOST` | `127.0.0.1` | bind address |
| `PRIVACY_FILTER_PORT` | `8787` | bind port |
| `PRIVACY_FILTER_CACHE` | `~/.cache/privacy-filter` | model/tokenizer cache |
| `PRIVACY_FILTER_THREADS` | `min(8, cpus)` | ORT intra-op threads |
| `PRIVACY_FILTER_MAX_TOKENS` | `2048` | window size for long inputs |

The model files (`model_q4.onnx`, `model_q4.onnx_data`, `tokenizer.json`,
`config.json`) are downloaded from Hugging Face on first start (about 900 MB)
and cached. `/health` reports `ready: false` until loading finishes.

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
newest Hugging Face model revision, update `version.json`, build, commit, and
move the `v<model>` / `latest` tags.
