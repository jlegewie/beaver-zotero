import json, socket, subprocess, re, time
from pathlib import Path
ROOT=Path.cwd()
RDP=json.loads((ROOT/'.worktree-meta.json').read_text())['rdpPort']
def rdp(code):
    p=subprocess.run(['node','scripts/worktree/zotero-rdp-exec.mjs',str(RDP),'zotero_execute_js',json.dumps({'code':code})],capture_output=True,text=True,check=True)
    result=p.stdout.split('Result:\n',1)[1].strip()
    return json.loads(result)
app=str(ROOT/'native/voice/macos/build/tests/Beaver Voice Input.app')
rdp('await Zotero.Beaver.voiceNative.setDevelopmentHelper('+json.dumps(app)+'); return JSON.stringify({ok:true});')
info=rdp('return JSON.stringify({port: Zotero.Beaver.voiceNative.capture.port});')
port=info['port']
# Synthetic lease: exercise the real socket and adapter without launching or recording.
rdp('const s=Zotero.Beaver.voiceNative.capture; Zotero.__voiceSavedLaunch=s.host.launch; s.host.launch=async()=>{}; Zotero.__voiceEvents=[]; Zotero.__voiceCapture=s.createCapture({version:1,sessionId:"ipc-test"}, e=>Zotero.__voiceEvents.push(e.type)); Zotero.__voiceCapture.start(); return JSON.stringify({ok:true});')
def req(body, extra='', raw=None):
    payload=json.dumps(body,separators=(',',':')).encode()
    if raw is None: raw=(f'POST /voice HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n'+extra+'\r\n').encode()+payload
    with socket.create_connection(('127.0.0.1',port),timeout=3) as s:
        for i in range(0,len(raw),27): s.sendall(raw[i:i+27])
        response=b''
        while True:
            d=s.recv(4096)
            if not d: break
            response+=d
    return response
try:
    # Authorization copied directly into this local test process, never printed.
    token=rdp('return JSON.stringify({token:Zotero.Beaver.voiceNative.capture.active.token});')['token']
    envelope={'version':1,'sessionId':'ipc-test'}
    assert b' 403 ' in req({**envelope,'type':'hello','helperVersion':1,'eventSequence':0})
    assert b' 400 ' in req({},'Origin: https://example.com\r\n')
    assert b' 400 ' in req({},raw=f'POST /voice HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 9999\r\n\r\n'.encode())
    auth=f'Authorization: Bearer {token}\r\n'
    def event(kind,seq,**fields):
        response=req({**envelope,'type':kind,'eventSequence':seq,**fields},auth)
        assert b' 200 ' in response,response[:100]
        return response
    event('hello',0,helperVersion=1)
    event('permission',1,status='granted')
    event('ready',2,format={'encoding':'pcm_s16le','sampleRate':16000,'channels':1})
    import base64
    event('frame',3,sequence=0,sampleCount=1600,pcm=base64.b64encode(bytes(3200)).decode())
    rdp('Zotero.__voiceCapture.finish(); return JSON.stringify({ok:true});')
    event('frame',4,sequence=1,sampleCount=37,pcm=base64.b64encode(bytes(74)).decode())
    event('done',5,frameCount=2,sampleCount=1637)
    assert rdp('return JSON.stringify(Zotero.__voiceEvents);')==['ready','frame','frame']
    print('PASS real Zotero socket: fragmented requests, denied token/origin/oversize, handshake, PCM, tail, done')
finally:
    rdp('Zotero.__voiceCapture.dispose(); Zotero.Beaver.voiceNative.capture.host.launch=Zotero.__voiceSavedLaunch; delete Zotero.__voiceCapture; delete Zotero.__voiceSavedLaunch; delete Zotero.__voiceEvents; return JSON.stringify({ok:true});')
