/**
 * Reality check for the spawned-binary path.
 *
 * The unit tier exercises `runCli(argv, deps)` in-process; this is the
 * one test that actually `spawn`s `tsx src/beaver-extract/cli/main.ts ...`
 * to verify argv handling, exit codes, and stdout JSON parses end-to-end.
 *
 * If this passes but the in-process tests don't, the seam between
 * `cli/main.ts` and `node/runCli.ts` regressed.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SMOKE_PDF, smokePdfExists } from './_helpers';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const mainTs = resolve(repoRoot, 'src/beaver-extract/cli/main.ts');
// Use the locally-installed tsx binary directly. `npx tsx` works but adds
// 5-10s of dependency-resolution overhead on the first run, which breaks
// realistic smoke timeouts on CI.
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');

interface SpawnResult {
    code: number;
    stdout: string;
    stderr: string;
}

function spawnCli(argv: string[]): Promise<SpawnResult> {
    return new Promise((res, rej) => {
        const child = spawn(tsxBin, [mainTs, ...argv], {
            cwd: repoRoot,
            // NODE_NO_WARNINGS keeps `(node:XXX) ExperimentalWarning: ...`
            // out of the child's stderr so the structured-error JSON we
            // print there parses cleanly.
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        child.on('error', rej);
        child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
    });
}

describe.runIf(smokePdfExists())('beaver-extract spawn (smoke)', () => {
    it('info --json exits 0 and prints a parseable JSON envelope', async () => {
        const r = await spawnCli(['info', SMOKE_PDF, '--json']);
        expect(r.code).toBe(0);
        const env = JSON.parse(r.stdout) as {
            ok: boolean;
            input: { pdfBytes: number; pdfSha256: string };
            result: { pageCount: number };
        };
        expect(env.ok).toBe(true);
        expect(env.input.pdfBytes).toBeGreaterThan(0);
        expect(env.result.pageCount).toBeGreaterThan(0);
    }, 60000);

    it('exits non-zero with a structured error envelope on a missing file', async () => {
        const r = await spawnCli(['info', '/path/does/not/exist.pdf', '--json']);
        expect(r.code).not.toBe(0);
        const env = JSON.parse(r.stderr) as {
            ok: boolean;
            error: { name: string; message: string };
        };
        expect(env.ok).toBe(false);
        expect(env.error.message.toLowerCase()).toMatch(/no such file|enoent/);
    }, 30000);
});
