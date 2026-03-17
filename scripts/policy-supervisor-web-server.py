#!/usr/bin/env python3
import json
import os
import subprocess
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LIVE_ROOT = Path(os.environ.get('POLICY_SUPERVISOR_LIVE_ROOT', str(Path.home() / '.openclaw' / 'workspace')))
SIM_SCRIPT = REPO_ROOT / 'scripts' / 'policy-supervisor-simulate.mjs'
LIVE_LOG = LIVE_ROOT / 'logs' / 'policy-supervisor.jsonl'

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO_ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/logs/policy-supervisor.jsonl':
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
        return super().do_GET()

    def do_POST(self):
        if self.path != '/api/policy-supervisor/simulate':
            self.send_error(404, 'Not Found')
            return

        length = int(self.headers.get('Content-Length', '0'))
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
        proc = subprocess.run(
            ['node', str(SIM_SCRIPT)],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            cwd=str(REPO_ROOT),
            timeout=60,
            env=env,
        )

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
    server = ThreadingHTTPServer(('0.0.0.0', 18891), Handler)
    server.serve_forever()
