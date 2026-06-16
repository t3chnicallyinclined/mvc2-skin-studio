#!/usr/bin/env python3
"""Skin Studio dev server: serves web/ AND accepts POST /bake so the editor can bake a
skin into your GDI with one click (the ROM stays on disk — no upload). The bake edits
track03.bin IN PLACE after making a one-time pristine track03.bin.bak next to it (the
fallback for browsers without the File System Access API).

Run:  python tools/skin_server.py [port]   (default 8000)
Then: http://localhost:8000/skin-studio.html  → edit → "Bake to ROM"
"""
import os, sys, json, mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Serve ES modules with a JavaScript MIME type. SimpleHTTPRequestHandler derives content
# types from the OS, and on Windows the registry frequently maps .js / .mjs to text/plain
# (or nothing → application/octet-stream). Browsers then REFUSE to execute them as
# `type="module"` (strict MIME checking) and the whole editor fails to load. Force the
# correct types both via the global mimetypes db and the handler's own extensions_map.
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, "..", "web"))
sys.path.insert(0, HERE)
import bake_skin


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".wasm": "application/wasm",
    }

    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)

    def do_OPTIONS(self):
        # CORS preflight (the JSON POST is a non-simple request if the page is served
        # cross-origin). end_headers() adds Access-Control-Allow-Origin.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path.split("?")[0] != "/bake":
            self.send_error(404); return
        try:
            n = int(self.headers.get("Content-Length", 0))
            skin = json.loads(self.rfile.read(n))
            path, info = bake_skin.bake(skin)
            out = {"ok": True, "path": path, "info": info}
            print("[bake]", skin.get("char"), "->", path, "|", info)
        except Exception as e:
            import traceback; traceback.print_exc()
            out = {"ok": False, "error": str(e)}
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print("Skin Studio:  http://localhost:%d/skin-studio.html   (one-click Bake enabled)" % port)
    ThreadingHTTPServer(("", port), Handler).serve_forever()
