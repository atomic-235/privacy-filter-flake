#!/usr/bin/env python3
"""HTTP redaction service for OpenAI Privacy Filter.

POST /redact  {"texts": ["...", "..."]} -> {"redacted": ["...", "..."]}
GET  /health  -> {"ok": true, "ready": false}

OPF is a long-context classifier, so the batch is joined into one document and
redacted in a single forward pass. Spans are mapped back to each input string.
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("PRIVACY_FILTER_HOST", "127.0.0.1")
PORT = int(os.environ.get("PRIVACY_FILTER_PORT", "8787"))
MAX_BODY = 16 * 1024 * 1024
MAX_TEXTS = 2000
MAX_DOCUMENT_CHARS = 200_000
SEPARATOR = "\n\n"

_model = None
_lock = threading.Lock()
_ready = False


def get_model():
    global _model
    if _model is None:
        from opf._api import OPF

        _model = OPF(device="cpu", output_mode="typed", decode_mode="viterbi")
    return _model


def apply_spans(text, spans):
    """Replace non-overlapping (start, end, placeholder) spans in text."""
    pieces = []
    cursor = 0
    for start, end, placeholder in sorted(spans):
        start = max(start, cursor)
        end = min(end, len(text))
        if end <= start:
            continue
        pieces.append(text[cursor:start])
        pieces.append(placeholder)
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces)


def redact_document(texts):
    document = SEPARATOR.join(texts)
    result = get_model().redact(document)
    spans = [(s.start, s.end, s.placeholder) for s in result.detected_spans]

    redacted = []
    offset = 0
    for text in texts:
        end = offset + len(text)
        local = [
            (max(start, offset) - offset, min(stop, end) - offset, placeholder)
            for start, stop, placeholder in spans
            if min(stop, end) > max(start, offset)
        ]
        redacted.append(apply_spans(text, local))
        offset = end + len(SEPARATOR)
    return redacted


def redact(texts):
    with _lock:
        out = []
        chunk = []
        size = 0
        for text in texts:
            if chunk and size + len(text) > MAX_DOCUMENT_CHARS:
                out.extend(redact_document(chunk))
                chunk, size = [], 0
            chunk.append(text)
            size += len(text) + len(SEPARATOR)
        if chunk:
            out.extend(redact_document(chunk))
        return out


def warmup():
    global _ready
    try:
        redact(["warmup"])
        _ready = True
        print("privacy-filter: model ready", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"privacy-filter: model load failed: {exc}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "privacy-filter/1"

    def log_message(self, fmt, *args):  # noqa: A003
        print("privacy-filter: " + fmt % args, file=sys.stderr, flush=True)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self.send_json(200, {"ok": True, "ready": _ready})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/redact":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("invalid body size")
            payload = json.loads(self.rfile.read(length))
            texts = payload["texts"]
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                raise ValueError("texts must be a list of strings")
            if len(texts) > MAX_TEXTS:
                raise ValueError("too many texts")
        except Exception as exc:  # noqa: BLE001
            self.send_json(400, {"error": str(exc)})
            return
        try:
            self.send_json(200, {"redacted": redact(texts)})
        except Exception as exc:  # noqa: BLE001
            print(f"privacy-filter: redaction failed: {exc}", file=sys.stderr, flush=True)
            self.send_json(500, {"error": str(exc)})


def main():
    threading.Thread(target=warmup, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"privacy-filter: listening on {HOST}:{PORT}", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
