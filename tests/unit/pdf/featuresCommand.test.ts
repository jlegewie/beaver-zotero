/**
 * In-process tests for the `features` command action: ledger and failure
 * semantics that decide whether a long corpus run terminates. Uses the
 * same `runCli(argv, deps)` seam as the envelope tests — a stubbed Node
 * API, no WASM.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FEATURE_NAMES, FEATURE_VERSION } from '../../../src/beaver-extract/classify/itemFeatures';

import { runCli } from '../../../src/beaver-extract/node/runCli';
import type { CliDeps } from '../../../src/beaver-extract/cli/runCliTypes';
import type * as NodeApi from '../../../src/beaver-extract/node/api';
import type { ItemFeatureExtractResult } from '../../../src/beaver-extract/worker/ops';

class StringSink extends Writable {
    chunks: string[] = [];
    _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
        this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
    }
    text(): string {
        return this.chunks.join('');
    }
}

function makeDeps() {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const extractItemFeatures = vi.fn();
    const deps: CliDeps = {
        api: { extractItemFeatures } as unknown as typeof NodeApi,
        drawOverlay: vi.fn(),
        loadPdf: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
        writePngFile: vi.fn(),
        writeJsonFile: vi.fn(),
        stdout,
        stderr,
    };
    return { deps, stdout, stderr, extractItemFeatures };
}

function okResult(pageCount: number, rowsPerPage: number): ItemFeatureExtractResult {
    return {
        pageCount,
        featureVersion: 1,
        featureNames: ['a', 'b'],
        pages: [
            {
                pageIndex: 0,
                items: Array.from({ length: rowsPerPage }, (_, i) => ({
                    itemId: `p0:i${i}`,
                    index: i,
                    columnIndex: 0,
                    kind: 'text',
                    text: `item ${i}`,
                    bbox: { l: 0, t: 0, r: 1, b: 1, origin: 'top-left' as const },
                    features: [0, 1],
                    neighborIds: { prev: [], next: [] },
                })),
            },
        ],
    };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('features command', () => {
    let dir: string;
    let out: string;
    let manifest: string;

    beforeEach(() => {
        process.exitCode = undefined;
        dir = mkdtempSync(join(tmpdir(), 'beaver-features-cmd-'));
        out = join(dir, 'out.jsonl');
        manifest = join(dir, 'manifest.csv');
        writeFileSync(
            manifest,
            ['sha256,path,page_count', 'aaa,/a.pdf,5', 'bbb,/b.pdf,7', 'ccc,/c.pdf,9', ''].join('\n'),
        );
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes rows and ledger lines, letting the worker apply the page policy', async () => {
        const { deps, stdout, extractItemFeatures } = makeDeps();
        extractItemFeatures.mockResolvedValue(okResult(5, 2));

        const code = await runCli(['features', '--manifest', manifest, '--out', out], deps);

        expect(code).toBe(0);
        expect(extractItemFeatures).toHaveBeenCalledTimes(3);
        const call = extractItemFeatures.mock.calls[0][0] as Record<string, unknown>;
        expect(call.applyExportPagePolicy).toBe(true);
        expect(call.pageIndices).toBeUndefined();
        expect(readJsonl(out)).toHaveLength(6);
        expect(readJsonl(`${out}.ledger.jsonl`).map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);
        expect(JSON.parse(readFileSync(`${out}.features.json`, 'utf8'))).toEqual({
            featureVersion: FEATURE_VERSION,
            featureNames: [...FEATURE_NAMES],
        });
        expect(JSON.parse(stdout.text())).toMatchObject({
            processed: 3,
            failed: 0,
            aborted: 0,
            remaining: 0,
            rows: 6,
        });
    });

    it('records a WASM trap as failed and continues with the next document', async () => {
        const { deps, stdout, extractItemFeatures } = makeDeps();
        extractItemFeatures
            .mockResolvedValueOnce(okResult(5, 1))
            .mockRejectedValueOnce(new Error('RuntimeError: memory access out of bounds'))
            .mockResolvedValueOnce(okResult(9, 1));

        const code = await runCli(['features', '--manifest', manifest, '--out', out], deps);

        expect(code).toBe(0);
        expect(readJsonl(`${out}.ledger.jsonl`).map((e) => [e.sha256, e.status])).toEqual([
            ['aaa', 'ok'],
            ['bbb', 'failed'],
            ['ccc', 'ok'],
        ]);
        expect(readJsonl(`${out}.failures.jsonl`)).toMatchObject([{ sha256: 'bbb', wasmReset: true }]);
        expect(JSON.parse(stdout.text())).toMatchObject({ processed: 2, failed: 1, aborted: 0, remaining: 0 });
    });

    it('records heap exhaustion as aborted, stops the batch, and leaves the rest pending', async () => {
        const { deps, stdout, extractItemFeatures } = makeDeps();
        extractItemFeatures
            .mockResolvedValueOnce(okResult(5, 1))
            .mockRejectedValueOnce(new Error('Cannot enlarge memory arrays'));

        const code = await runCli(['features', '--manifest', manifest, '--out', out], deps);

        expect(code).toBe(0);
        expect(extractItemFeatures).toHaveBeenCalledTimes(2);
        expect(readJsonl(`${out}.ledger.jsonl`).map((e) => [e.sha256, e.status])).toEqual([
            ['aaa', 'ok'],
            ['bbb', 'aborted'],
        ]);
        expect(readJsonl(`${out}.failures.jsonl`)).toEqual([]);
        // The aborted document and the untouched one are both still pending.
        expect(JSON.parse(stdout.text())).toMatchObject({ processed: 1, aborted: 1, remaining: 2 });
    });

    it('retries an aborted document on resume and gives up after the retry limit', async () => {
        const first = makeDeps();
        first.extractItemFeatures.mockRejectedValue(new Error('Cannot enlarge memory arrays'));
        await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], first.deps);
        expect(first.extractItemFeatures).toHaveBeenCalledTimes(1);

        const second = makeDeps();
        second.extractItemFeatures.mockRejectedValue(new Error('Cannot enlarge memory arrays'));
        await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], second.deps);
        // Same document again: aborts are retried until the limit.
        expect(second.extractItemFeatures).toHaveBeenCalledTimes(1);
        expect(JSON.parse(second.stdout.text())).toMatchObject({ aborted: 1, remaining: 2 });

        const third = makeDeps();
        third.extractItemFeatures.mockResolvedValue(okResult(5, 1));
        await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], third.deps);
        // Twice-aborted `aaa` is skipped; the other two are processed.
        expect(third.extractItemFeatures).toHaveBeenCalledTimes(2);
        expect(JSON.parse(third.stdout.text())).toMatchObject({ processed: 2, skipped: 1, remaining: 0 });
    });

    it('makes --limit resumable so repeated steps advance through the manifest', async () => {
        const first = makeDeps();
        first.extractItemFeatures.mockResolvedValue(okResult(5, 1));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '2'], first.deps);
        expect(JSON.parse(first.stdout.text())).toMatchObject({ processed: 2, remaining: 1 });

        const second = makeDeps();
        second.extractItemFeatures.mockResolvedValue(okResult(5, 1));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '2'], second.deps);
        expect(second.extractItemFeatures).toHaveBeenCalledTimes(1);
        expect(JSON.parse(second.stdout.text())).toMatchObject({ processed: 1, skipped: 2, remaining: 0 });
        expect(readJsonl(out)).toHaveLength(3);
    });

    it('discards an interrupted partial write on resume and retries that document', async () => {
        // A first run committed `aaa`, then was killed while appending `bbb`:
        // one complete row and a torn second row survive past the commit offset.
        const first = makeDeps();
        first.extractItemFeatures.mockResolvedValueOnce(okResult(5, 2));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '1'], first.deps);
        const committed = readFileSync(out, 'utf8');
        expect(readJsonl(`${out}.ledger.jsonl`)[0]).toMatchObject({
            sha256: 'aaa',
            outputBytes: Buffer.byteLength(committed),
        });
        writeFileSync(
            out,
            committed + JSON.stringify({ sha256: 'bbb', itemId: 'p0:i0' }) + '\n{"sha256":"bbb","item',
        );

        const second = makeDeps();
        second.extractItemFeatures.mockResolvedValue(okResult(7, 3));
        await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], second.deps);

        expect(second.stderr.text()).toMatch(/discarded \d+ uncommitted byte/);
        expect(second.extractItemFeatures).toHaveBeenCalledTimes(2);
        const rows = readJsonl(out);
        expect(rows.map((r) => r.sha256)).toEqual(['aaa', 'aaa', 'bbb', 'bbb', 'bbb', 'ccc', 'ccc', 'ccc']);
        expect(JSON.parse(second.stdout.text())).toMatchObject({ processed: 2, skipped: 1, remaining: 0 });
    });

    it('recovers from a kill during the first document by discarding all output', async () => {
        // The ledger was created but never written to; a partial first row survives.
        writeFileSync(`${out}.ledger.jsonl`, '');
        writeFileSync(out, '{"sha256":"aaa","item');
        const { deps, stdout, stderr, extractItemFeatures } = makeDeps();
        extractItemFeatures.mockResolvedValue(okResult(5, 1));

        expect(await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], deps)).toBe(0);

        expect(stderr.text()).toMatch(/discarded \d+ uncommitted byte/);
        expect(extractItemFeatures).toHaveBeenCalledTimes(3);
        expect(readJsonl(out).map((r) => r.sha256)).toEqual(['aaa', 'bbb', 'ccc']);
        expect(JSON.parse(stdout.text())).toMatchObject({ processed: 3, skipped: 0, remaining: 0 });
    });

    it('repairs a torn ledger line before resuming so the document is retried, not duplicated', async () => {
        const first = makeDeps();
        first.extractItemFeatures.mockResolvedValueOnce(okResult(5, 2));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '1'], first.deps);
        const committedOut = readFileSync(out, 'utf8');
        const committedLedger = readFileSync(`${out}.ledger.jsonl`, 'utf8');
        // `bbb`'s rows landed, then the process died mid ledger line.
        writeFileSync(out, committedOut + JSON.stringify({ sha256: 'bbb', itemId: 'p0:i0' }) + '\n');
        writeFileSync(`${out}.ledger.jsonl`, committedLedger + '{"sha256":"bbb","status":"ok","pa');

        const second = makeDeps();
        second.extractItemFeatures.mockResolvedValue(okResult(7, 3));
        await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], second.deps);

        expect(second.stderr.text()).toMatch(/torn \d+-byte ledger line/);
        expect(second.extractItemFeatures).toHaveBeenCalledTimes(2);
        expect(readJsonl(out).map((r) => r.sha256)).toEqual(['aaa', 'aaa', 'bbb', 'bbb', 'bbb', 'ccc', 'ccc', 'ccc']);
        const ledger = readJsonl(`${out}.ledger.jsonl`);
        expect(ledger.map((e) => [e.sha256, e.status])).toEqual([['aaa', 'ok'], ['bbb', 'ok'], ['ccc', 'ok']]);

        // A further resume finds everything committed and touches nothing.
        const third = makeDeps();
        await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], third.deps);
        expect(third.extractItemFeatures).not.toHaveBeenCalled();
        expect(readJsonl(out)).toHaveLength(8);
    });

    it('retries a document whose ledger entry was written without its newline', async () => {
        const first = makeDeps();
        first.extractItemFeatures.mockResolvedValueOnce(okResult(5, 2));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '1'], first.deps);
        const committedOut = readFileSync(out, 'utf8');
        const committedLedger = readFileSync(`${out}.ledger.jsonl`, 'utf8');
        // `bbb`'s rows landed and its ledger object is complete, but the
        // process died before the newline: not a commit.
        const bbbRows = JSON.stringify({ sha256: 'bbb', itemId: 'p0:i0' }) + '\n';
        writeFileSync(out, committedOut + bbbRows);
        writeFileSync(
            `${out}.ledger.jsonl`,
            committedLedger +
                JSON.stringify({
                    sha256: 'bbb',
                    status: 'ok',
                    pages: 1,
                    rows: 1,
                    outputBytes: Buffer.byteLength(committedOut + bbbRows),
                }),
        );

        const second = makeDeps();
        second.extractItemFeatures.mockResolvedValue(okResult(7, 3));
        await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], second.deps);

        expect(second.stderr.text()).toMatch(/torn \d+-byte ledger line/);
        expect(second.stderr.text()).toMatch(/discarded \d+ uncommitted byte/);
        expect(second.extractItemFeatures).toHaveBeenCalledTimes(2);
        expect(readJsonl(out).map((r) => r.sha256)).toEqual(['aaa', 'aaa', 'bbb', 'bbb', 'bbb', 'ccc', 'ccc', 'ccc']);
        expect(readJsonl(`${out}.ledger.jsonl`).map((e) => [e.sha256, e.status])).toEqual([['aaa', 'ok'], ['bbb', 'ok'], ['ccc', 'ok']]);
        expect(JSON.parse(second.stdout.text())).toMatchObject({ processed: 2, skipped: 1, remaining: 0 });
    });

    it('refuses to resume when committed rows are missing from the output', async () => {
        const first = makeDeps();
        first.extractItemFeatures.mockResolvedValueOnce(okResult(5, 2));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '1'], first.deps);
        const committed = readFileSync(out, 'utf8');

        truncateSync(out, Math.floor(Buffer.byteLength(committed) / 2));
        const shorter = makeDeps();
        expect(await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], shorter.deps)).not.toBe(0);
        expect(shorter.stderr.text()).toMatch(/committed rows are missing/);
        expect(shorter.extractItemFeatures).not.toHaveBeenCalled();

        rmSync(out);
        const gone = makeDeps();
        expect(await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], gone.deps)).not.toBe(0);
        expect(gone.stderr.text()).toMatch(/committed rows are missing/);
        expect(gone.extractItemFeatures).not.toHaveBeenCalled();

        // A fresh run must not silently start over on top of the stale ledger either.
        const fresh = makeDeps();
        expect(await runCli(['features', '--manifest', manifest, '--out', out], fresh.deps)).not.toBe(0);
        expect(fresh.stderr.text()).toMatch(/--resume/);
        expect(readJsonl(`${out}.ledger.jsonl`)).toHaveLength(1);
    });

    it.skipIf(process.getuid?.() === 0)(
        'stops without a ledger line when writing rows fails, and retries the document next time',
        async () => {
            const first = makeDeps();
            first.extractItemFeatures.mockResolvedValueOnce(okResult(5, 2));
            await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '1'], first.deps);
            const committed = readFileSync(out, 'utf8');

            chmodSync(out, 0o444);
            try {
                const blocked = makeDeps();
                blocked.extractItemFeatures.mockResolvedValue(okResult(7, 3));
                const code = await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], blocked.deps);
                expect(code).not.toBe(0);
                expect(blocked.extractItemFeatures).toHaveBeenCalledTimes(1);
                expect(blocked.stderr.text()).toMatch(/writing .*out\.jsonl failed/);
                expect(blocked.stdout.text()).toBe('');
                expect(readJsonl(`${out}.ledger.jsonl`).map((e) => e.sha256)).toEqual(['aaa']);
                expect(readFileSync(out, 'utf8')).toBe(committed);
            } finally {
                chmodSync(out, 0o644);
            }

            // The failed invocation set the process exit code, as a real CLI run would.
            process.exitCode = undefined;
            const retry = makeDeps();
            retry.extractItemFeatures.mockResolvedValue(okResult(7, 3));
            expect(await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], retry.deps)).toBe(0);
            expect(retry.extractItemFeatures).toHaveBeenCalledTimes(2);
            expect(readJsonl(out).map((r) => r.sha256)).toEqual(['aaa', 'aaa', 'bbb', 'bbb', 'bbb', 'ccc', 'ccc', 'ccc']);
            expect(readJsonl(`${out}.ledger.jsonl`).map((e) => e.sha256)).toEqual(['aaa', 'bbb', 'ccc']);
        },
    );

    it('leaves a validated sidecar untouched when resuming', async () => {
        const first = makeDeps();
        first.extractItemFeatures.mockResolvedValueOnce(okResult(5, 2));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '1'], first.deps);
        // Same contract, different bytes: a rewrite would reformat it.
        const compact = JSON.stringify({ featureVersion: FEATURE_VERSION, featureNames: [...FEATURE_NAMES] });
        writeFileSync(`${out}.features.json`, compact);

        const second = makeDeps();
        second.extractItemFeatures.mockResolvedValue(okResult(7, 1));
        expect(await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], second.deps)).toBe(0);
        expect(second.extractItemFeatures).toHaveBeenCalledTimes(2);
        expect(readFileSync(`${out}.features.json`, 'utf8')).toBe(compact);
        expect(existsSync(`${out}.features.json.${process.pid}.tmp`)).toBe(false);
    });

    it('refuses to resume an export produced under a different feature layout', async () => {
        const first = makeDeps();
        first.extractItemFeatures.mockResolvedValueOnce(okResult(5, 2));
        await runCli(['features', '--manifest', manifest, '--out', out, '--limit', '1'], first.deps);
        const foreign = JSON.stringify({ featureVersion: FEATURE_VERSION + 1, featureNames: [...FEATURE_NAMES] }, null, 2) + '\n';
        writeFileSync(`${out}.features.json`, foreign);
        // Leave an interrupted write behind too: the refusal must not repair or truncate anything.
        const tornLedger = readFileSync(`${out}.ledger.jsonl`, 'utf8') + '{"sha256":"bbb","sta';
        const strayOutput = readFileSync(out, 'utf8') + '{"sha256":"bbb","item';
        writeFileSync(`${out}.ledger.jsonl`, tornLedger);
        writeFileSync(out, strayOutput);
        const inventory = join(dir, 'inventory.csv');
        writeFileSync(inventory, 'sha256,path,byte_size,page_count,copies,error\naaa,/a.pdf,1,5,1,\n');

        const resumed = makeDeps();
        expect(
            await runCli(['features', '--inventory', inventory, '--sample', '1', '--out', out, '--resume'], resumed.deps),
        ).not.toBe(0);
        expect(resumed.stderr.text()).toMatch(/different feature layout/);
        expect(resumed.extractItemFeatures).not.toHaveBeenCalled();
        // Nothing was rewritten: sidecar, torn ledger, stray output and manifest are as found.
        expect(readFileSync(`${out}.features.json`, 'utf8')).toBe(foreign);
        expect(readFileSync(`${out}.ledger.jsonl`, 'utf8')).toBe(tornLedger);
        expect(readFileSync(out, 'utf8')).toBe(strayOutput);
        expect(existsSync(`${out}.manifest.csv`)).toBe(false);

        rmSync(`${out}.features.json`);
        const unverifiable = makeDeps();
        expect(await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], unverifiable.deps)).not.toBe(0);
        expect(unverifiable.stderr.text()).toMatch(/cannot be verified/);
        expect(unverifiable.extractItemFeatures).not.toHaveBeenCalled();
        expect(existsSync(`${out}.features.json`)).toBe(false);
        expect(readFileSync(`${out}.ledger.jsonl`, 'utf8')).toBe(tornLedger);
        expect(readFileSync(out, 'utf8')).toBe(strayOutput);
    });

    it('refuses to append to an existing output without --resume or without a ledger', async () => {
        writeFileSync(out, JSON.stringify({ sha256: 'zzz', itemId: 'p0:i0' }) + '\n');
        const fresh = makeDeps();
        expect(await runCli(['features', '--manifest', manifest, '--out', out], fresh.deps)).not.toBe(0);
        expect(fresh.stderr.text()).toMatch(/--resume/);
        expect(fresh.extractItemFeatures).not.toHaveBeenCalled();

        const noLedger = makeDeps();
        expect(
            await runCli(['features', '--manifest', manifest, '--out', out, '--resume'], noLedger.deps),
        ).not.toBe(0);
        expect(noLedger.stderr.text()).toMatch(/no ledger/);
        expect(readJsonl(out)).toHaveLength(1);
    });

    it('records a timeout as aborted, stops the batch, and exits once the summary is written', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        try {
            const { deps, stdout, extractItemFeatures } = makeDeps();
            extractItemFeatures
                .mockResolvedValueOnce(okResult(5, 1))
                .mockReturnValueOnce(new Promise(() => undefined));

            await runCli(
                ['features', '--manifest', manifest, '--out', out, '--timeout-ms', '5'],
                deps,
            );
            // The exit is scheduled from the stdout write callback, one tick later.
            await new Promise((resolve) => setImmediate(resolve));

            expect(extractItemFeatures).toHaveBeenCalledTimes(2);
            expect(readJsonl(`${out}.ledger.jsonl`).map((e) => [e.sha256, e.status])).toEqual([
                ['aaa', 'ok'],
                ['bbb', 'aborted'],
            ]);
            expect(JSON.parse(stdout.text())).toMatchObject({ processed: 1, aborted: 1, remaining: 2 });
            expect(exit).toHaveBeenCalledTimes(1);
        } finally {
            exit.mockRestore();
        }
    });

    it('rejects a non-integer bucket floor instead of drawing an empty sample', async () => {
        const inventory = join(dir, 'inventory.csv');
        writeFileSync(inventory, 'sha256,path,byte_size,page_count,copies,error\naaa,/a.pdf,1,5,1,\n');
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ['features', '--inventory', inventory, '--sample', '1', '--bucket-floor', 'x', '--out', out],
            deps,
        );
        expect(code).not.toBe(0);
        expect(stderr.text()).toMatch(/--bucket-floor/);
    });
});
