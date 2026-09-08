"""Exercise a mounted Zotero composer and real gzip POST without microphone/provider access.

Run from a configured worktree with a logged-in, voice-enabled development XPI.
Focus and capture are explicitly stubbed; packaging, composer, encoding, and HTTP are real.
"""
import argparse
import gzip
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--surface', choices=['library', 'reader', 'window'], default='library')
args = parser.parse_args()
ROOT = Path.cwd()
RDP = json.loads((ROOT / '.worktree-meta.json').read_text())['rdpPort']
STATS = {'requests': 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(STATS).encode())

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        size = struct.unpack('>I', body[:4])[0]
        metadata = json.loads(body[4:4 + size])
        pcm = gzip.decompress(body[4 + size:])
        assert self.path == '/api/v1/voice/transcriptions'
        assert self.headers['Authorization'] == 'Bearer voice-local-wire-test'
        assert self.headers['Content-Type'] == 'application/vnd.beaver.voice.v1'
        assert self.headers.get('Content-Encoding') is None
        assert metadata['encoding'] == 'pcm16le-gzip'
        assert metadata['sample_rate'] == 16000 and metadata['channels'] == 1
        STATS['requests'] += 1
        data = json.dumps({'session_id': metadata['session_id'],
                           'transcript': 'Corrected local wire test.',
                           'duration_ms': (len(pcm) // 2 + 15) // 16,
                           'credit_cost': '0'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)


def rdp(code):
    result = subprocess.run(['node', 'scripts/worktree/zotero-rdp-exec.mjs', str(RDP),
                             'zotero_execute_js', json.dumps({'code': code})],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    text = result.stdout.split('Result:\n', 1)[1].strip()
    if text == 'null':
        return None
    value = json.loads(text)
    if value in ({"type": "null"}, {"type": "undefined"}):
        return None
    return json.loads(value) if isinstance(value, str) and value.startswith('{') else value


def run(code):
    rdp('Zotero.__voiceDictationTest = null; (async () => {\n' + code +
        '\n})().then(result => Zotero.__voiceDictationTest = result, '
        'error => Zotero.__voiceDictationTest = {error: String(error)}); return true;')
    for _ in range(30):
        time.sleep(1)
        result = rdp('return Zotero.__voiceDictationTest;')
        if result is not None:
            assert 'error' not in result, result
            return result
    raise RuntimeError('Zotero dictation test timed out')


server = HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    screenshot = str(Path(tempfile.gettempdir()) / f'beaver-voice-{args.surface}.png')
    if args.surface == 'window':
        prefix = """
const main=Zotero.getMainWindow();
if (!main.document.querySelector('button[aria-label="Open in separate window"]')) main.document.getElementById('zotero-beaver-tb-chat-toggle').click();
await new Promise(resolve=>ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs').setTimeout(resolve,300));
if (!Services.wm.getMostRecentWindow('beaver:window')) main.document.querySelector('button[aria-label="Open in separate window"]').click();
await new Promise(resolve=>ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs').setTimeout(resolve,500));
const VOICE_TEST_WINDOW=Services.wm.getMostRecentWindow('beaver:window');
const VOICE_TEST_ROOT='#beaver-pane-window';
"""
    else:
        pane = args.surface
        select = "VOICE_TEST_WINDOW.Zotero_Tabs.select('zotero-pane');" if pane == 'library' else "if (VOICE_TEST_WINDOW.Zotero_Tabs.selectedType === 'library') throw new Error('Open a reader tab before this test');"
        prefix = f"""
const VOICE_TEST_WINDOW=Zotero.getMainWindow();
{select}
const pane=VOICE_TEST_WINDOW.document.getElementById('beaver-pane-{pane}');
if (!pane || pane.style.display==='none') VOICE_TEST_WINDOW.document.getElementById('zotero-beaver-tb-chat-toggle').click();
const VOICE_TEST_ROOT='#beaver-react-root-{pane}';
"""
    code = (f'const VOICE_TEST_URL="http://127.0.0.1:{server.server_port}";\n'
            f'const VOICE_SCREENSHOT={json.dumps(screenshot)};\n' + prefix +
            (ROOT / 'native/voice/tests/composer-dictation.js').read_text())
    result = run(code)
    assert 'checks' in result, result
    for check in result['checks']:
        assert check['passed'], check
        print('PASS', check['label'])
    print('Screenshot:', screenshot)
    print('Physical microphone and real top-level focus were not tested.')
finally:
    server.shutdown()
    rdp('delete Zotero.__voiceDictationTest; return true;')
