#!/usr/bin/env python3
import json
import os
import secrets
import subprocess
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LIVE_ROOT = Path(os.environ.get('POLICY_SUPERVISOR_LIVE_ROOT', str(Path.home() / '.openclaw' / 'workspace')))
SIM_SCRIPT = REPO_ROOT / 'scripts' / 'policy-supervisor-simulate.mjs'
LIVE_LOG = LIVE_ROOT / 'logs' / 'policy-supervisor.jsonl'
BIND = os.environ.get('POLICY_SUPERVISOR_WEB_BIND', '127.0.0.1')
PORT = int(os.environ.get('POLICY_SUPERVISOR_WEB_PORT', '18891'))
MAX_REQUEST_BYTES = int(os.environ.get('POLICY_SUPERVISOR_MAX_REQUEST_BYTES', '65536'))
WEB_TOKEN = os.environ.get('POLICY_SUPERVISOR_WEB_TOKEN', '')
ALLOWED_STATIC = {
    '/',
    '/web/policy-supervisor/index.html',
    '/web/policy-supervisor/simulate.html',
}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO_ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    def _require_auth(self):
        if not WEB_TOKEN:
            return True
        header = self.headers.get('Authorization', '')
        expected = f'Bearer {WEB_TOKEN}'
        if secrets.compare_digest(header, expected):
            return True
        self.send_response(401)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': 'unauthorized'}).encode('utf-8'))
        return False

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/logs/policy-supervisor.jsonl':
            if not self._require_auth():
                return
            if not LIVE_LOG.exists():
                self.send_response(404)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'policy-supervisor log not found')
                return
            data = LIVE_LOG.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.end_headers()
            self.wfile.write(data)
            return
        if path == '/':
            self.send_response(302)
            self.send_header('Location', '/web/policy-supervisor/index.html')
            self.end_headers()
            return
        if path not in ALLOWED_STATIC:
            self.send_error(404, 'Not Found')
            return
        return super().do_GET()

    def do_POST(self):
        if self.path != '/api/policy-supervisor/simulate':
            self.send_error(404, 'Not Found')
            return
        if not self._require_auth():
            return
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_response(413)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'payload too large'}).encode('utf-8'))
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except Exception as exc:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': f'invalid json: {exc}'}).encode('utf-8'))
            return

        env = dict(os.environ)
        env.setdefault('OPENCLAW_CONFIG', str(Path.home() / '.openclaw' / 'openclaw.json'))
        try:
            proc = subprocess.run(
                ['node', str(SIM_SCRIPT)],
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                cwd=str(REPO_ROOT),
                timeout=30,
                env=env,
            )
        except subprocess.TimeoutExpired:
            self.send_response(504)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'simulation timed out'}).encode('utf-8'))
            return

        if proc.returncode != 0:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': proc.stderr.strip() or 'simulation failed'}).encode('utf-8'))
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(proc.stdout.encode('utf-8'))

if __name__ == '__main__':
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.serve_forever()
