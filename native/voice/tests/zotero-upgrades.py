"""Reinstall/upgrade/rollback generated XPIs in the isolated worktree. Optional real microphone."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path.cwd()
META = json.loads((ROOT / '.worktree-meta.json').read_text())
assert Path(META['worktree']).resolve() == ROOT.resolve()
assert 'beaver-dev-' in Path(META['profile']).name
XPI = ROOT / '.scaffold/build/beaver.xpi'

def run(*args, env=None):
    p = subprocess.run(args, capture_output=True, text=True, check=True, env=env)
    return p.stdout

def call(tool, args):
    return run('node', 'scripts/worktree/zotero-rdp-exec.mjs', str(META['rdpPort']), tool, json.dumps(args))

def rdp(code):
    code = '(async()=>{try{' + code + '}catch(error){return JSON.stringify({testError:String(error)});}})()'
    report = json.loads(call('zotero_execute_js', {'code': code}).split('Result:\n', 1)[1].strip())
    assert 'testError' not in report, report
    return report

def install(path):
    call('zotero_plugin_install', {'path': str(path)})
    time.sleep(1)

def initialize():
    return rdp('''
const n=Zotero.Beaver.voiceNative;
if(n.available || n.socket) throw new Error('Replacement must be lazy');
Zotero.Prefs.set('extensions.zotero.beaver.voice.nativeEnabled',true,true);
await n.ensurePackagedHelper();
return JSON.stringify({path:n.helperPath, permission:n.permission});
''')

def start_microphone():
    report = rdp('''
const h=Zotero.Beaver.voiceHarness;
const owner={closed:false,document:{hasFocus:()=>true},addEventListener:()=>{},removeEventListener:()=>{}};
if(Zotero.Beaver.voiceNative.permission==='unknown') {
 const setup=await h.startNative(Zotero.getMainWindow());
 if(setup.permission!=='granted') throw new Error('Grant permission before microphone upgrade testing');
}
const start=await h.startNative(owner);
const timer=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
await new Promise(r=>timer.setTimeout(r,1200));
return JSON.stringify(h.service.controller.getSnapshot());
''')
    assert report['phase'] == 'listening' and report['frameCount'] > 0, report
    pids = run('pgrep', '-f', 'BeaverVoice.*' + report['sessionId']).split()
    assert len(pids) == 1, pids
    return int(pids[0])

def check_exit(pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try: os.kill(pid, 0)
        except ProcessLookupError: return
        time.sleep(.05)
    raise AssertionError('Old helper survived plugin replacement')

with tempfile.TemporaryDirectory(prefix='voice-upgrade-') as tmp:
    tmp = Path(tmp)
    app = tmp / 'Beaver Voice Input.app'
    run('/usr/bin/ditto', str(ROOT / 'native/voice/macos/build/Beaver Voice Input.app'), str(app))
    run('/usr/libexec/PlistBuddy', '-c', 'Set CFBundleShortVersionString 0.1.1', str(app / 'Contents/Info.plist'))
    run('/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', '--entitlements',
        str(ROOT / 'native/voice/macos/entitlements.plist'), str(app))
    package = tmp / 'package'
    run('node', 'native/voice/macos/package.mjs', '--development',
        env=dict(os.environ, VOICE_APP=str(app), VOICE_PACKAGE_DIR=str(package)))
    upgraded = tmp / 'upgrade.xpi'
    with zipfile.ZipFile(XPI) as source, zipfile.ZipFile(upgraded, 'w', zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            data = source.read(entry.filename)
            if entry.filename in ['content/voice/manifest.json', 'content/voice/macos.zip']:
                data = (package / Path(entry.filename).name).read_bytes()
            target.writestr(entry, data)
    try:
        install(XPI)
        first = initialize()
        install(XPI)
        again = initialize()
        assert first['path'] == again['path'] and again['permission'] == 'unknown'
        helper = start_microphone() if '--microphone' in sys.argv else None
        install(upgraded)
        if helper: check_exit(helper)
        newer = initialize()
        assert newer['path'] != first['path'] and newer['permission'] == 'unknown'
        assert Path(first['path']).exists() and Path(newer['path']).exists()
        print('PASS identical reinstall, immutable upgraded version, permission reset, retained rollback version', flush=True)
        if helper: print('PASS XPI replacement revokes active packaged microphone helper', flush=True)
    finally:
        install(XPI)
    rolled_back = initialize()
    assert rolled_back['path'] == first['path']
    print('PASS rollback to original packaged XPI without manual helper placement', flush=True)
