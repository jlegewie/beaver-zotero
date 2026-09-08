"""Local distribution checks with real codesign, ditto, universal binaries and the XPI packer."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[4]
CONTRACT = json.loads((ROOT / 'native/voice/macos/contract.json').read_text())
APP = ROOT / 'native/voice/macos/build/Beaver Voice Input.app'
def run(*args, env=None, success=True):
    result = subprocess.run(args, text=True, capture_output=True, env=env)
    if success and result.returncode:
        raise AssertionError(result.stderr + result.stdout)
    if not success:
        assert result.returncode != 0, args
    return result.stdout.strip()

with tempfile.TemporaryDirectory(prefix='voice-package-') as tmp:
    tmp = Path(tmp)
    app = tmp / APP.name
    run('/usr/bin/ditto', str(APP), str(app))
    resources = app / 'Contents/Resources'
    resources.mkdir(exist_ok=True)
    (resources / 'payload').write_bytes(b'preserve contents\x00\xff')
    (resources / 'payload').chmod(0o640)
    (resources / 'link').symlink_to('payload')
    run('/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', '--entitlements',
        str(ROOT / 'native/voice/macos/entitlements.plist'), str(app))
    output = tmp / 'package'
    env = dict(os.environ, VOICE_APP=str(app), VOICE_PACKAGE_DIR=str(output))
    run('node', str(ROOT / 'native/voice/macos/package.mjs'), '--development', env=env)
    run('node', str(ROOT / 'native/voice/macos/package.mjs'), env=env, success=False)
    m = json.loads((output / 'manifest.json').read_text())
    assert hashlib.sha256((output / 'macos.zip').read_bytes()).hexdigest() == m['archiveSha256']
    assert sorted(run('/usr/bin/lipo', '-archs', str(app / 'Contents/MacOS/BeaverVoice')).split()) == ['arm64', 'x86_64']
    # Assemble a minimal XPI with the actual packer, then extract its opaque inner archive.
    repo = tmp / 'repo'
    (repo / 'scripts').mkdir(parents=True)
    (repo / 'native/voice/macos').mkdir(parents=True)
    shutil.copy(ROOT / 'scripts/pack-xpi.mjs', repo / 'scripts')
    shutil.copy(ROOT / 'native/voice/macos/check-package.mjs', repo / 'native/voice/macos')
    shutil.copy(ROOT / 'native/voice/macos/contract.json', repo / 'native/voice/macos')
    (repo / 'package.json').write_text('{"name":"beaver"}')
    assets = repo / '.scaffold/build/addon/content/voice'
    shutil.copytree(output, assets)
    run('node', str(repo / 'scripts/pack-xpi.mjs'), env=dict(os.environ, NODE_ENV='production'), success=False)
    run('node', str(repo / 'scripts/pack-xpi.mjs'), env=dict(os.environ, NODE_ENV='development'))
    for patch in [{'version': '1.0'}, {'version': None}, {'executableSha256': ''}, {'plistSha256': 'bad'}]:
        (assets / 'manifest.json').write_text(json.dumps(dict(m, **patch)))
        run('node', str(repo / 'scripts/pack-xpi.mjs'), env=dict(os.environ, NODE_ENV='development'), success=False)
    (assets / 'manifest.json').write_text(json.dumps(m))
    with zipfile.ZipFile(repo / '.scaffold/build/beaver.xpi') as xpi:
        archive = tmp / 'roundtrip.zip'
        archive.write_bytes(xpi.read('content/voice/macos.zip'))
    assert archive.read_bytes() == (output / 'macos.zip').read_bytes()
    unpacked = tmp / 'installed'
    run('/usr/bin/ditto', '-x', '-k', str(archive), str(unpacked))
    installed = unpacked / APP.name
    run('/usr/bin/codesign', '--verify', '--strict', '--all-architectures', str(installed))
    assert (installed / 'Contents/Resources/link').is_symlink()
    assert (installed / 'Contents/Resources/payload').stat().st_mode & 0o777 == 0o640
    assert (installed / 'Contents/MacOS/BeaverVoice').stat().st_mode & 0o111
    assert json.loads(run(str(installed / 'Contents/MacOS/BeaverVoice'), '--voice-info')) == {
        'protocolVersion': CONTRACT['protocolVersion'], 'helperVersion': CONTRACT['helperVersion'], 'testing': False}
    (installed / 'Contents/Resources/payload').write_text('tampered')
    run('/usr/bin/codesign', '--verify', '--strict', str(installed), success=False)
    (assets / 'macos.zip').write_bytes(b'tampered')
    run('node', str(repo / 'scripts/pack-xpi.mjs'), env=dict(os.environ, NODE_ENV='development'), success=False)
    print('PASS universal archive, XPI roundtrip, executable modes, symlinks, signature and corruption rejection; production rejects ad-hoc package')
