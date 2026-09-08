"""Opt-in real microphone smoke test for the packaged app; never saves or uploads audio."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path.cwd()
META = json.loads((ROOT / '.worktree-meta.json').read_text())
assert Path(META['worktree']).resolve() == ROOT.resolve()
assert 'beaver-dev-' in Path(META['profile']).name

def rdp(code):
    p = subprocess.run(['node', 'scripts/worktree/zotero-rdp-exec.mjs', str(META['rdpPort']),
        'zotero_execute_js', json.dumps({'code': code})], capture_output=True, text=True, check=True)
    if 'Result:\n' not in p.stdout:
        raise AssertionError(p.stdout)
    return json.loads(p.stdout.split('Result:\n', 1)[1].strip())

setup = rdp('''
const n=Zotero.Beaver.voiceNative;
Zotero.Prefs.set('extensions.zotero.beaver.voice.nativeEnabled',true,true);
await n.ensurePackagedHelper();
if(!n.packaged) throw new Error('Reload plugin to clear development helper registration');
if(n.permission==='unknown') await Zotero.Beaver.voiceHarness.startNative(Zotero.getMainWindow());
return JSON.stringify({permission:n.permission});
''')
assert setup['permission'] == 'granted', 'Grant permission in the isolated instance before capture'
code = '''(async () => {
const n=Zotero.Beaver.voiceNative, h=Zotero.Beaver.voiceHarness;
const original=n.capture.host.launch;
if(FORCE_INTEL) n.capture.host.launch=async(port,token,sessionId,permissionOnly)=>{
 const {Subprocess}=ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
 const child=await Subprocess.call({command:'/usr/bin/open',arguments:['-n','-g','--arch','x86_64',n.helperPath,'--args','--port',String(port),'--token',token,'--session',sessionId,...(permissionOnly?['--permission-only']:[])]});
 if((await child.wait()).exitCode!==0)throw new Error('Intel launch failed');
};
const owner={closed:false,document:{hasFocus:()=>true},addEventListener:()=>{},removeEventListener:()=>{}};
const t=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
const wait=ms=>new Promise(r=>t.setTimeout(r,ms));
try {
 const started=await h.startNative(owner);await wait(2200);
 const active=h.nativeState();h.service.controller.finish(started.sessionId);await wait(1200);
 return JSON.stringify({active,done:h.nativeState()});
} finally {
 n.capture.host.launch=original;
 h.service.controller.cancel(h.service.controller.getSnapshot().sessionId);
}
})()'''.replace('FORCE_INTEL', 'true' if '--intel' in sys.argv else 'false')
report = rdp(code)
assert report['active']['state']['phase'] == 'listening' and report['active']['state']['frameCount'] > 0, report
final = report['done']['state']
assert final['phase'] == 'completed' or final['phase'] == 'error' and final['error']['code'] == 'no_speech', report
assert report['done']['retainedBytes'] == 0, report
print('PASS packaged microphone PCM and clean stop', 'Intel/Rosetta' if '--intel' in sys.argv else 'native', json.dumps(report['done']['metrics']))
