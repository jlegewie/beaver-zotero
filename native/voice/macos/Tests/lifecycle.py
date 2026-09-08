"""LaunchServices lifecycle tests using the separately built, microphone-free test app."""
import base64
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import time

APP = Path(__file__).resolve().parents[1] / 'build/tests/Beaver Voice Input.app'

class Scenario:
    def __init__(self, mode, behavior='finish'):
        self.mode, self.behavior = mode, behavior
        self.token, self.session = secrets.token_hex(32), secrets.token_hex(16)
        self.events, self.controls = [], []
        self.pid = None
        self.started = time.monotonic()
        self.command = 'continue'
        self.failures = []
        scenario = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                scenario.failures.append('Unexpected redirected GET')
                self.send_error(400)
            def do_POST(self):
                try:
                    assert self.path == '/voice', 'Redirect forwarded an authenticated request'
                    length = int(self.headers['Content-Length'])
                    assert length <= 6144
                    assert self.headers['Authorization'] == 'Bearer ' + scenario.token
                    data = json.loads(self.rfile.read(length))
                    assert data['version'] == 1 and data['sessionId'] == scenario.session
                    elapsed = time.monotonic() - scenario.started
                    if data['type'] == 'control':
                        scenario.controls.append(elapsed)
                    else:
                        assert data['eventSequence'] == len(scenario.events)
                        scenario.events.append(data)
                        if data['type'] == 'hello': scenario.pid = data['pid']
                    if scenario.behavior == 'audio-stall' and data['type'] == 'frame': time.sleep(2.5)
                    if scenario.behavior == 'control-stall' and data['type'] == 'control': time.sleep(4)
                    command = scenario.command
                    if scenario.behavior == 'finish' and elapsed > 1.27: command = 'finish'
                    if scenario.behavior == 'cancel' and elapsed > 1.1: command = 'cancel'
                    if data['type'] in ['done', 'error']: command = 'exit'
                    if scenario.behavior == 'redirect':
                        self.send_response(307)
                        self.send_header('Location', f'http://127.0.0.1:{scenario.server.server_port}/redirect')
                        self.send_header('Content-Length', '0')
                        self.end_headers(); return
                    reply={'version':2 if scenario.behavior=='wrong-version' else 1,'sessionId':scenario.session,'command':command}
                    if scenario.behavior in ['oversized-response','unframed-response']: reply['padding']='x'*4096
                    body = json.dumps(reply).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    if scenario.behavior != 'unframed-response': self.send_header('Content-Length', str(len(body)))
                    self.send_header('Connection','close')
                    self.end_headers(); self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass
                except Exception as e: scenario.failures.append(str(e))
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
    def alive(self):
        if self.pid is None: return True
        try: os.kill(self.pid,0); return True
        except ProcessLookupError: return False
    def run(self):
        subprocess.run(['/usr/bin/open','-n','-g',str(APP),'--args','--port',str(self.server.server_port),
                        '--token',self.token,'--session',self.session,'--test-mode',self.mode]
                       + (['--permission-only'] if self.behavior=='permission' else []),check=True)
        deadline = time.monotonic()+(165 if self.behavior in ['duration', 'absolute'] else 34 if self.behavior=='startup' else 13)
        while self.alive() and time.monotonic()<deadline: time.sleep(.05)
        duration = time.monotonic()-self.started
        alive=self.alive()
        if alive and self.pid: os.kill(self.pid,9)
        self.server.shutdown(); self.server.server_close()
        assert not alive, f'{self.mode}/{self.behavior}: helper leaked'
        assert not self.failures, self.failures
        assert self.pid is not None, 'Never received hello'
        return duration

for mode, behavior, error in [
    ('fixture','redirect',None), ('fixture','wrong-version',None),
    ('fixture','oversized-response',None), ('fixture','unframed-response',None),
    ('startup-discontinuity','finish','discontinuity'), ('unrequested','finish','unavailable'),
    ('fixture','permission',None), ('denied','permission',None), ('fixture','finish',None), ('fixture','cancel',None), ('denied','finish','permission_denied'),
    ('no-device','finish','device_unavailable'), ('capture-stall','continue','capture_failed'),
    ('discontinuity','continue','discontinuity'), ('fixture','audio-stall',None),
    ('fixture','control-stall',None), ('main-stall','cancel',None), ('main-stall','finish',None), ('setup-stall','startup',None),
]:
    s=Scenario(mode,behavior); duration=s.run()
    if behavior=='permission':
        assert s.events[-1]['type']=='permission_done'
        assert not any(e['type'] in ['ready','frame'] for e in s.events)
    if behavior in ['redirect','wrong-version','oversized-response','unframed-response']:
        assert len(s.events)==1 and not s.controls, 'Invalid handshake response allowed setup to continue'
        assert duration < 3
    if mode in ['startup-discontinuity', 'unrequested']:
        assert not any(e['type']=='frame' for e in s.events), 'Capture started after invalid setup'
    if error: assert any(e.get('code')==error for e in s.events), (mode,s.events)
    if behavior == 'finish' and mode == 'fixture':
        frames=[e for e in s.events if e['type']=='frame']; done=s.events[-1]
        assert done['type']=='done'
        assert done['frameCount']==len(frames)
        assert done['sampleCount']==sum(e['sampleCount'] for e in frames)
        for i,frame in enumerate(frames):
            assert frame['sequence']==i
            assert len(base64.b64decode(frame['pcm'],validate=True))==frame['sampleCount']*2
            if i<len(frames)-1: assert frame['sampleCount']==1600
        assert any(base64.b64decode(e['pcm']).strip(b'\x00') for e in frames)
    if mode=='main-stall' and behavior=='finish':
        assert 10 < duration < 13, (duration, [(e['type'], e.get('code')) for e in s.events], len(s.controls))
    if behavior=='startup': assert 30 <= duration < 34
    if behavior == 'audio-stall':
        first=next(e for e in s.events if e['type']=='frame')
        assert len(s.controls)>=2, 'Audio stall blocked independent control'
    if behavior in ['audio-stall','control-stall','cancel']: assert duration < 5
    print(f'PASS {mode}/{behavior}: exited {duration:.3f}s; events={len(s.events)} controls={len(s.controls)}', flush=True)

if os.environ.get('VOICE_LONG_TEST') in ['1', 'absolute']:
    def bounded_long(mode, behavior, expected, lower, upper):
        s=Scenario(mode,behavior); duration=s.run()
        if expected: assert any(e.get('code')==expected for e in s.events), expected
        assert lower <= duration < upper, duration
        print(f'PASS {mode}/{behavior}: exited {duration:.3f}s', flush=True)
    # Run independently, both with generated/no audio and their real production deadlines.
    with __import__('concurrent.futures', fromlist=['ThreadPoolExecutor']).ThreadPoolExecutor() as pool:
        jobs=[pool.submit(bounded_long,'main-stall','absolute',None,155,160)]
        if os.environ.get('VOICE_LONG_TEST') == '1': jobs.append(pool.submit(bounded_long,'fixture','duration','duration_limit',120,125))
        for job in jobs: job.result()
