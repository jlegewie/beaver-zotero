"""Exercise the actual utility runner against Zotero's chunked subprocess pipes."""
import json
from pathlib import Path
import subprocess

ROOT = Path.cwd()
META = json.loads((ROOT / '.worktree-meta.json').read_text())
assert Path(META['worktree']).resolve() == ROOT.resolve()
assert 'beaver-dev-' in Path(META['profile']).name
compiled = subprocess.run(['node', '-e', "const ts=require('typescript'); const fs=require('fs'); process.stdout.write(ts.transpileModule(fs.readFileSync('src/services/voice/voiceProcess.ts','utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)"], capture_output=True, text=True, check=True).stdout
code = "(async()=>{try{const exports={};" + compiled + """
if (Zotero.Profile.dir !== PROFILE) throw new Error('Wrong profile');
const run = exports.runVoiceProcess;
const result = await run('/usr/bin/awk', ['BEGIN {for(i=0;i<30000;i++){printf "abcdefghij"; printf "diagnostic" > "/dev/stderr"}}']);
if (result !== 'abcdefghij'.repeat(30000)) throw new Error('Truncated output');
let bounded = false;
try { await run('/usr/bin/awk', ['BEGIN {for(i=0;i<120000;i++)printf "abcdefghij"}']); }
catch(error) { bounded = error.message === 'Voice helper output exceeded limit'; }
if (!bounded) throw new Error('Output bound failed');
const start = Date.now();
let timedOut = false;
try { await run('/bin/sleep', ['30']); }
catch(error) { timedOut = error.message === 'Voice helper process failed'; }
if (!timedOut || Date.now()-start > 20000) throw new Error('Deadline failed');
return JSON.stringify({passed:true, bytes:result.length, elapsed:Date.now()-start});
}catch(error){return JSON.stringify({error:String(error)});}})()
""".replace('PROFILE', json.dumps(META['profile']))
result = subprocess.run(['node', 'scripts/worktree/zotero-rdp-exec.mjs', str(META['rdpPort']), 'zotero_execute_js', json.dumps({'code':code})], capture_output=True, text=True, check=True)
report = json.loads(result.stdout.split('Result:\n', 1)[1].strip())
assert report.get('passed'), report
print('PASS real chunked stdout/stderr, bounded output, utility deadline', json.dumps(report))
