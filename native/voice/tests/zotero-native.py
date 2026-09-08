"""Generated PCM through the real helper, Zotero controller, and IPC; no microphone access."""
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path.cwd()
RDP=json.loads((ROOT/'.worktree-meta.json').read_text())['rdpPort']
def rdp(code):
    p=subprocess.run(['node','scripts/worktree/zotero-rdp-exec.mjs',str(RDP),'zotero_execute_js',json.dumps({'code':code})],capture_output=True,text=True,check=True)
    return json.loads(p.stdout.split('Result:\n',1)[1].strip())
real='--microphone' in sys.argv
app=str(ROOT/('native/voice/macos/build/Beaver Voice Input.app' if real else 'native/voice/macos/build/tests/Beaver Voice Input.app'))
result=rdp('''
await Zotero.Beaver.voiceNative.setDevelopmentHelper(APP_PATH);
const h=Zotero.Beaver.voiceHarness;
const timer=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
const wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));
const owner={closed:false,document:{hasFocus:()=>true},addEventListener:()=>{},removeEventListener:()=>{}};
if (Zotero.Beaver.voiceNative.permission === 'unknown') {
    const setup=await h.startNative(Zotero.getMainWindow());
    if (!setup.setup) throw new Error('Expected permission-only setup');
}
const reports=[];
for (let i=0;i<3;i++) {
    const started=await h.startNative(owner);
    await wait(i === 0 && LONG_CAPTURE ? 18000 : 1600);
    const active=h.nativeState();
    h.service.controller.finish(started.sessionId);
    await wait(1200);
    reports.push({active,done:h.nativeState()});
}
return JSON.stringify(reports);
'''.replace('APP_PATH',json.dumps(app)).replace('LONG_CAPTURE', 'true' if '--long' in sys.argv else 'false'))
for i,report in enumerate(result):
    assert report['active']['state']['phase']=='listening',report
    assert report['active']['state']['frameCount']>5,report
    if not real: assert report['active']['state']['level']>0.01,report
    assert report['done']['state']['phase']=='completed',report
    print('PASS microphone session' if real else 'PASS native fixture session',i+1,json.dumps(report['done'],separators=(',',':')))

report=rdp('''
const h=Zotero.Beaver.voiceHarness;
const timer=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
const wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));
const win=Zotero.getMainWindow().openDialog('about:blank','voice-fixture-owner','chrome,dialog=no,width=400,height=200');
await wait(500);
const owner={closed:false,document:{hasFocus:()=>true},addEventListener:win.addEventListener.bind(win),removeEventListener:win.removeEventListener.bind(win)};
await h.startNative(owner);
await wait(1200);
const before=h.service.controller.getSnapshot();
win.close();
await wait(1000);
return JSON.stringify({before,after:h.service.controller.getSnapshot()});
''')
assert report['before']['phase']=='listening',report
assert report['after']['phase']=='canceled',report
print('PASS real originating-window unload cancels native capture')
