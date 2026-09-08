"""Verify packaged installation in the isolated worktree; no microphone is opened."""
import json
from pathlib import Path
import subprocess

ROOT = Path.cwd()
META = json.loads((ROOT / '.worktree-meta.json').read_text())
assert Path(META['worktree']).resolve() == ROOT.resolve()
assert 'beaver-dev-' in Path(META['profile']).name

def rdp(code):
    code = '(async()=>{try{' + code + '}catch(error){return JSON.stringify({testError:String(error)});}})()'
    result = subprocess.run(['node', 'scripts/worktree/zotero-rdp-exec.mjs', str(META['rdpPort']),
        'zotero_execute_js', json.dumps({'code': code})], capture_output=True, text=True, check=True)
    report = json.loads(result.stdout.split('Result:\n', 1)[1].strip())
    assert 'testError' not in report, report
    return report

report = rdp('''
const n = Zotero.Beaver.voiceNative;
if (!n || n.available || n.socket) throw new Error('Reload the plugin before this test');
Zotero.Prefs.set('extensions.zotero.beaver.voice.nativeEnabled', false, true);
let disabled = false;
try { await n.ensurePackagedHelper(); } catch { disabled = true; }
if (!disabled || n.socket) throw new Error('Feature gate failed');
Zotero.Prefs.set('extensions.zotero.beaver.voice.nativeEnabled', true, true);
await Promise.all([n.ensurePackagedHelper(), n.ensurePackagedHelper()]);
const path = n.helperPath;
const root = PathUtils.parent(path);
const executable = PathUtils.join(path, 'Contents', 'MacOS', 'BeaverVoice');
const expected = await IOUtils.computeHexDigest(executable, 'sha256');
await n.installer.ensure();
const samePath = n.helperPath === path;
await IOUtils.write(executable, new Uint8Array([0,1,2]));
await n.installer.ensure();
const corruptRepaired = expected === await IOUtils.computeHexDigest(executable, 'sha256');
const old = PathUtils.join(PathUtils.parent(root), 'd'.repeat(64));
const recent = PathUtils.join(PathUtils.parent(root), 'e'.repeat(64));
await IOUtils.makeDirectory(old, {ignoreExisting: true});
await IOUtils.writeUTF8(PathUtils.join(old, 'last-used'), String(Date.now() - 8 * 86400000));
await IOUtils.makeDirectory(recent, {ignoreExisting: true});
await IOUtils.writeUTF8(PathUtils.join(recent, 'last-used'), String(Date.now()));
await n.installer.ensure();
const oldRemoved = !await IOUtils.exists(old), recentKept = await IOUtils.exists(recent);
await IOUtils.remove(recent, {recursive: true});
return JSON.stringify({path, samePath, corruptRepaired, oldRemoved, recentKept,
    restored: expected === await IOUtils.computeHexDigest(executable, 'sha256'),
    permission: n.permission, busy: n.capture.busy, profile: Zotero.Profile.dir});
''')
assert Path(report['profile']).resolve() == Path(META['profile']).resolve(), report
assert all(report[k] for k in ['samePath', 'corruptRepaired', 'oldRemoved', 'recentKept', 'restored']), report
assert report['permission'] == 'unknown' and not report['busy'], report
assert str(Path(META['profile']) / 'beaver/voice') in report['path'], report
print('PASS lazy packaged install, concurrent activation, cached verification, automatic corruption recovery, safe cleanup; no permission request or capture')
print(json.dumps(report))
