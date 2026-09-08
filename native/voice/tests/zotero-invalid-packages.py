"""Install deliberately invalid test XPIs; verify rejection before opening native resources."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import zipfile

ROOT = Path.cwd()
META = json.loads((ROOT / '.worktree-meta.json').read_text())
assert Path(META['worktree']).resolve() == ROOT.resolve()
assert 'beaver-dev-' in Path(META['profile']).name
XPI = ROOT / '.scaffold/build/beaver.xpi'

def call(tool, args):
    return subprocess.run(['node', 'scripts/worktree/zotero-rdp-exec.mjs', str(META['rdpPort']),
        tool, json.dumps(args)], capture_output=True, text=True, check=True).stdout

def install(path):
    call('zotero_plugin_install', {'path': str(path)})
    time.sleep(1)

with tempfile.TemporaryDirectory(prefix='voice-invalid-xpi-') as tmp:
    try:
        for name, patch in [
            ('invalid-version', {'version': '1.0'}),
            ('incompatible-protocol', {'protocolVersion': 2}),
            ('incompatible-helper', {'helperVersion': 999}),
            ('invalid-archive', {'archiveSha256': 'f' * 64}),
            ('untrusted-signer', {'signing': 'unsigned'}),
        ]:
            target = Path(tmp) / (name + '.xpi')
            with zipfile.ZipFile(XPI) as source, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as dest:
                for entry in source.infolist():
                    data = source.read(entry.filename)
                    if entry.filename == 'content/voice/manifest.json':
                        m = json.loads(data); m.update(patch); data = json.dumps(m).encode()
                    dest.writestr(entry, data)
            install(target)
            report = json.loads(call('zotero_execute_js', {'code': '''
const n=Zotero.Beaver.voiceNative;
Zotero.Prefs.set('extensions.zotero.beaver.voice.nativeEnabled', true, true);
let rejected=false;
try { await n.ensurePackagedHelper(); } catch { rejected=true; }
return JSON.stringify({rejected, available:n.available, socket:!!n.socket});
'''}).split('Result:\n', 1)[1].strip())
            assert report == {'rejected': True, 'available': False, 'socket': False}, report
            print('PASS invalid XPI rejected before native listener:', name, flush=True)
    finally:
        install(XPI)
