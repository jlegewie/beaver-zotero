"""Run after a plugin reload: lazy listener, same-path setup, and missing helper recovery."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path.cwd()
RDP = json.loads((ROOT / '.worktree-meta.json').read_text())['rdpPort']
APP = ROOT / 'native/voice/macos/build/tests/Beaver Voice Input.app'

def rdp(code):
    result = subprocess.run(['node', 'scripts/worktree/zotero-rdp-exec.mjs', str(RDP),
        'zotero_execute_js', json.dumps({'code': code})], capture_output=True, text=True, check=True)
    return json.loads(result.stdout.split('Result:\n', 1)[1].strip())

initial = rdp('return JSON.stringify({socket:!!Zotero.Beaver.voiceNative.socket, voice:!!Zotero.Beaver.voice});')
assert initial == {'socket': False, 'voice': True}, 'Reload the plugin before this test'
print('PASS startup has a voice service and no native socket', flush=True)

report = rdp('''
const native=Zotero.Beaver.voiceNative, h=Zotero.Beaver.voiceHarness;
await native.setDevelopmentHelper(APP_PATH);
const first=await h.startNative(Zotero.getMainWindow());
await native.setDevelopmentHelper(APP_PATH);
const reset=native.permission;
const second=await h.startNative(Zotero.getMainWindow());
return JSON.stringify({first, reset, second, phase:h.service.controller.getSnapshot().phase});
'''.replace('APP_PATH', json.dumps(str(APP))))
assert report['first']['setup'] and report['first']['permission'] == 'granted', report
assert report['reset'] == 'unknown', report
assert report['second']['setup'] and report['second']['permission'] == 'granted', report
assert report['phase'] == 'idle', report
print('PASS same-path registration requires permission-only setup again', flush=True)

with tempfile.TemporaryDirectory(prefix='beaver-voice-setup-') as directory:
    app = Path(directory) / 'Beaver Voice Input.app'
    shutil.copytree(APP, app)
    try:
        rdp('await Zotero.Beaver.voiceNative.setDevelopmentHelper(' + json.dumps(str(app)) + '); return JSON.stringify(true);')
        app.rename(Path(directory) / 'Moved Helper.app')
        failure = rdp('return JSON.stringify(await Zotero.Beaver.voiceHarness.startNative(Zotero.getMainWindow()));')
        assert failure['error']['code'] == 'unavailable' and failure['help'], failure
        print('PASS helper moved after registration returns actionable setup error', flush=True)
    finally:
        rdp('await Zotero.Beaver.voiceNative.setDevelopmentHelper(' + json.dumps(str(APP)) + '); return JSON.stringify(true);')
