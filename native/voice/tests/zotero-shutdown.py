"""Destructive only to this worktree's isolated Zotero process; uses generated audio."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import sys

ROOT=Path.cwd()
META=json.loads((ROOT/'.worktree-meta.json').read_text())
assert Path(META['worktree']).resolve()==ROOT.resolve()
assert 'beaver-dev-' in Path(META['profile']).name
RDP=META['rdpPort']
def call(tool,args):
    p=subprocess.run(['node','scripts/worktree/zotero-rdp-exec.mjs',str(RDP),tool,json.dumps(args)],capture_output=True,text=True,check=True)
    return p.stdout

def rdp(code): return json.loads(call('zotero_execute_js',{'code':code}).split('Result:\n',1)[1].strip())

def start():
    app=str(ROOT/('native/voice/macos/build/Beaver Voice Input.app' if '--microphone' in sys.argv else 'native/voice/macos/build/tests/Beaver Voice Input.app'))
    result=rdp('''
await Zotero.Beaver.voiceNative.setDevelopmentHelper(APP_PATH);
const h=Zotero.Beaver.voiceHarness;
if (Zotero.Beaver.voiceNative.permission === 'unknown') await h.startNative(Zotero.getMainWindow());
const owner={closed:false,document:{hasFocus:()=>true},addEventListener:()=>{},removeEventListener:()=>{}};
await h.startNative(owner);
const timers=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
await new Promise(resolve=>timers.setTimeout(resolve,1100));
return JSON.stringify({state:h.service.controller.getSnapshot(),pid:Services.appinfo.processID,profile:Zotero.Profile.dir});
'''.replace('APP_PATH',json.dumps(app)))
    assert result['state']['phase']=='listening',result
    assert Path(result['profile']).resolve()==Path(META['profile']).resolve()
    session=result['state']['sessionId']
    matches=subprocess.run(['pgrep','-f','BeaverVoice.*'+session],capture_output=True,text=True,check=True)
    pids=[int(p) for p in matches.stdout.split()]
    assert len(pids)==1,pids
    return result['pid'],pids[0]

def exited(pid):
    try: os.kill(pid,0); return False
    except ProcessLookupError: return True

def verify_exit(pid,at):
    while not exited(pid) and time.monotonic()-at<5: time.sleep(.05)
    assert exited(pid),'Native helper survived revocation'
    return time.monotonic()-at

zotero,helper=start()
at=time.monotonic()
call('zotero_plugin_install',{'path':str(ROOT/'.scaffold/build/beaver.xpi')})
print(f'PASS plugin replacement terminates helper (observed after {verify_exit(helper,at):.3f}s)',flush=True)
# Wait for the replacement service before starting again.
time.sleep(1)
zotero,helper=start()
at=time.monotonic()
os.kill(zotero,signal.SIGKILL)
print(f'PASS abrupt isolated Zotero termination: helper exited in {verify_exit(helper,at):.3f}s',flush=True)
