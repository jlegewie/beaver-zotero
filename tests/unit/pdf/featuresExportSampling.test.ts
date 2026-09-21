/**
 * Unit tests for the pure helpers behind `beaver-extract features`:
 * the page policy, the inventory CSV parser, and the stratified
 * document sampler.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it, expect } from 'vitest';

import {
    ABORT_RETRY_LIMIT,
    discardUncommittedOutput,
    featureContractMismatch,
    PAGE_BUCKETS,
    PAGE_POLICY_FULL_MAX,
    PAGE_POLICY_HEAD,
    PAGE_POLICY_TAIL,
    parseCsvLine,
    parseInventoryCsv,
    planBatch,
    readLedger,
    repairLedger,
    resolveExportPageIndices,
    toCsvCell,
    stratifiedSample,
    type InventoryRow,
} from '../../../src/beaver-extract/cli/commands/features';

describe('resolveExportPageIndices', () => {
    it('takes every page of a short document', () => {
        expect(resolveExportPageIndices(1)).toEqual([0]);
        expect(resolveExportPageIndices(PAGE_POLICY_FULL_MAX)).toHaveLength(
            PAGE_POLICY_FULL_MAX,
        );
        expect(resolveExportPageIndices(15)).toEqual(
            Array.from({ length: 15 }, (_, i) => i),
        );
    });

    it('takes the head and tail of a long document, sorted and deduplicated', () => {
        const indices = resolveExportPageIndices(300);
        expect(indices).toHaveLength(PAGE_POLICY_HEAD + PAGE_POLICY_TAIL);
        expect(new Set(indices).size).toBe(indices.length);
        expect([...indices].sort((a, b) => a - b)).toEqual(indices);
        expect(indices.slice(0, PAGE_POLICY_HEAD)).toEqual(
            Array.from({ length: PAGE_POLICY_HEAD }, (_, i) => i),
        );
        expect(indices[indices.length - 1]).toBe(299);
    });

    it('keeps head and tail distinct just past the full-extraction limit', () => {
        const indices = resolveExportPageIndices(PAGE_POLICY_FULL_MAX + 1);
        expect(new Set(indices).size).toBe(indices.length);
        expect(indices).toHaveLength(PAGE_POLICY_HEAD + PAGE_POLICY_TAIL);
    });

    it('returns nothing for a document with no pages', () => {
        expect(resolveExportPageIndices(0)).toEqual([]);
        expect(resolveExportPageIndices(Number.NaN)).toEqual([]);
    });
});

describe('parseInventoryCsv', () => {
    it('reads sha256 / path / page_count and tolerates a missing page count', () => {
        const rows = parseInventoryCsv(
            [
                'sha256,path,byte_size,page_count,copies,error',
                'aa,/tmp/a.pdf,100,5,1,',
                'bb,/tmp/b.pdf,200,,1,cannot open',
                '',
            ].join('\n'),
        );
        expect(rows).toEqual([
            { sha256: 'aa', path: '/tmp/a.pdf', pageCount: 5 },
            { sha256: 'bb', path: '/tmp/b.pdf', pageCount: 0 },
        ]);
    });

    it('keeps commas and quotes inside quoted paths', () => {
        const rows = parseInventoryCsv(
            'sha256,path,page_count\n' +
                'aaa,"/papers/Smith, Jones.pdf",12\n' +
                'bbb,"/papers/say ""hi"".pdf",3\n',
        );
        expect(rows).toEqual([
            { sha256: 'aaa', path: '/papers/Smith, Jones.pdf', pageCount: 12 },
            { sha256: 'bbb', path: '/papers/say "hi".pdf', pageCount: 3 },
        ]);
        expect(parseCsvLine('a,"b,c",,"d""e"')).toEqual(['a', 'b,c', '', 'd"e']);
    });

    it('quotes cells that need it so a manifest round-trips', () => {
        expect(toCsvCell('/plain/path.pdf')).toBe('/plain/path.pdf');
        expect(toCsvCell('/papers/Smith, Jones.pdf')).toBe('"/papers/Smith, Jones.pdf"');
        expect(toCsvCell('a"b')).toBe('"a""b"');
        const path = '/papers/Smith, "Jones".pdf';
        expect(parseCsvLine(`x,${toCsvCell(path)},5`)).toEqual(['x', path, '5']);
    });

    it('rejects a CSV without the required columns', () => {
        expect(() => parseInventoryCsv('foo,bar\n1,2\n')).toThrow(/sha256/);
    });
});

describe('stratifiedSample', () => {
    function inventory(): InventoryRow[] {
        // Mirrors the corpus shape: many short documents, few long ones.
        const counts = [80, 400, 250, 90, 40, 50];
        const sizes = [2, 10, 20, 45, 120, 400];
        const rows: InventoryRow[] = [];
        for (let bucket = 0; bucket < counts.length; bucket++) {
            for (let i = 0; i < counts[bucket]; i++) {
                rows.push({
                    sha256: `${bucket}${String(i).padStart(4, '0')}`,
                    path: `/tmp/${bucket}-${i}.pdf`,
                    pageCount: sizes[bucket],
                });
            }
        }
        return rows;
    }

    it('is deterministic for a given seed and changes with the seed', () => {
        const a = stratifiedSample(inventory(), { sample: 120, seed: 7 });
        const b = stratifiedSample(inventory(), { sample: 120, seed: 7 });
        const c = stratifiedSample(inventory(), { sample: 120, seed: 8 });
        expect(a.rows).toEqual(b.rows);
        expect(c.rows).not.toEqual(a.rows);
        expect(c.rows).toHaveLength(a.rows.length);
    });

    it('draws the requested total and covers every populated bucket', () => {
        const result = stratifiedSample(inventory(), {
            sample: 120,
            seed: 7,
            bucketFloor: 15,
        });
        expect(result.rows).toHaveLength(120);
        expect(result.allocation).toHaveLength(PAGE_BUCKETS.length);
        expect(result.allocation.reduce((sum, n) => sum + n, 0)).toBe(120);
        for (let i = 0; i < result.allocation.length; i++) {
            expect(result.allocation[i]).toBeGreaterThanOrEqual(15);
            expect(result.allocation[i]).toBeLessThanOrEqual(result.available[i]);
        }
    });

    it('caps the per-bucket floor so a small sample stays feasible', () => {
        const result = stratifiedSample(inventory(), {
            sample: 12,
            seed: 3,
            bucketFloor: 60,
        });
        expect(result.rows).toHaveLength(12);
        expect(result.allocation.every((n) => n > 0)).toBe(true);
    });

    it('skips rows without a usable page count', () => {
        const rows: InventoryRow[] = [
            { sha256: 'a', path: '/tmp/a.pdf', pageCount: 5 },
            { sha256: 'b', path: '/tmp/b.pdf', pageCount: 0 },
            { sha256: 'c', path: '/tmp/c.pdf', pageCount: Number.NaN },
        ];
        const result = stratifiedSample(rows, { sample: 10, seed: 1 });
        expect(result.skipped).toBe(2);
        expect(result.rows.map((r) => r.sha256)).toEqual(['a']);
    });

    it('never returns more documents than the population holds', () => {
        const result = stratifiedSample(inventory(), { sample: 100000, seed: 1 });
        expect(result.rows).toHaveLength(910);
    });

    it('interleaves buckets so a prefix of the manifest is still stratified', () => {
        const drawn = stratifiedSample(inventory(), { sample: 300, seed: 5, bucketFloor: 20 });
        const bucketOf = (pageCount: number) =>
            PAGE_BUCKETS.findIndex((b) => pageCount >= b.min && pageCount <= b.max);
        const firstHalf = new Set(drawn.rows.slice(0, 150).map((r) => bucketOf(r.pageCount)));
        expect(firstHalf.size).toBeGreaterThan(2);
    });

    it('assigns each document to the bucket its page count falls in', () => {
        const rows: InventoryRow[] = PAGE_BUCKETS.map((bucket, i) => ({
            sha256: `s${i}`,
            path: `/tmp/${i}.pdf`,
            pageCount: bucket.min,
        }));
        const result = stratifiedSample(rows, { sample: 6, seed: 1 });
        expect(result.available).toEqual([1, 1, 1, 1, 1, 1]);
        expect(result.rows).toHaveLength(6);
    });
});

describe('planBatch', () => {
    const docs: InventoryRow[] = ['a', 'b', 'c', 'd', 'e'].map((sha256) => ({
        sha256,
        path: `/${sha256}.pdf`,
        pageCount: 3,
    }));

    it('skips done documents and keeps manifest order for the rest', () => {
        const plan = planBatch(docs, new Set(['b', 'd']), undefined);
        expect(plan.pending.map((d) => d.sha256)).toEqual(['a', 'c', 'e']);
        expect(plan.batch).toEqual(plan.pending);
        expect(plan.skipped).toBe(2);
        expect(plan.remaining).toBe(0);
    });

    it('honours the limit and reports what is left for the next invocation', () => {
        const plan = planBatch(docs, new Set(['a']), 3);
        expect(plan.batch.map((d) => d.sha256)).toEqual(['b', 'c', 'd']);
        expect(plan.skipped).toBe(1);
        expect(plan.remaining).toBe(1);
    });

    it('reports nothing remaining once every document is done', () => {
        const plan = planBatch(docs, new Set(docs.map((d) => d.sha256)), 2);
        expect(plan.batch).toEqual([]);
        expect(plan.skipped).toBe(5);
        expect(plan.remaining).toBe(0);
    });
});

describe('featureContractMismatch', () => {
    const current = { featureVersion: 2, featureNames: ['a', 'b'] };

    it('accepts an identical layout', () => {
        expect(featureContractMismatch({ featureVersion: 2, featureNames: ['a', 'b'] }, current)).toBeNull();
    });

    it('names the first difference it finds', () => {
        expect(featureContractMismatch({ featureVersion: 1, featureNames: ['a', 'b'] }, current)).toMatch(/version 1/);
        expect(featureContractMismatch({ featureVersion: 2, featureNames: ['a'] }, current)).toMatch(/1 feature names/);
        expect(featureContractMismatch({ featureVersion: 2, featureNames: ['a', 'c'] }, current)).toMatch(/feature 1 is "c"/);
        expect(featureContractMismatch({ featureVersion: 2 }, current)).toMatch(/no feature name list/);
        expect(featureContractMismatch(null, current)).toMatch(/not an object/);
    });
});

describe('readLedger', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function writeLedger(lines: unknown[]): string {
        const dir = mkdtempSync(join(tmpdir(), 'beaver-ledger-'));
        dirs.push(dir);
        const file = join(dir, 'out.jsonl.ledger.jsonl');
        writeFileSync(
            file,
            lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
        );
        return file;
    }

    it('treats ok, empty and failed as done and counts aborts until the retry limit', async () => {
        const file = writeLedger([
            { sha256: 'ok1', status: 'ok', pages: 3, rows: 12 },
            { sha256: 'emp', status: 'empty', pages: 2, rows: 0 },
            { sha256: 'bad', status: 'failed', pages: 0, rows: 0, error: 'no text layer' },
            { sha256: 'once', status: 'aborted', pages: 0, rows: 0, error: 'timed out' },
            ...Array.from({ length: ABORT_RETRY_LIMIT }, () => ({
                sha256: 'twice',
                status: 'aborted',
                pages: 0,
                rows: 0,
                error: 'Cannot enlarge memory',
            })),
            'not json at all',
        ]);
        const ledger = await readLedger(file);
        expect([...ledger.done].sort()).toEqual(['bad', 'emp', 'ok1', 'twice']);
        expect([...ledger.abortCounts.entries()]).toEqual([['once', 1]]);
    });

    it('lets a later terminal status supersede earlier aborts', async () => {
        const file = writeLedger([
            { sha256: 'doc', status: 'aborted', pages: 0, rows: 0, error: 'timed out' },
            { sha256: 'doc', status: 'ok', pages: 4, rows: 30 },
        ]);
        const ledger = await readLedger(file);
        expect(ledger.done.has('doc')).toBe(true);
        expect(ledger.abortCounts.size).toBe(0);
    });

    it('treats a missing ledger as nothing attempted', async () => {
        const ledger = await readLedger(join(tmpdir(), 'no-such-ledger.jsonl'));
        expect(ledger.done.size).toBe(0);
        expect(ledger.abortCounts.size).toBe(0);
        expect(ledger.entryCount).toBe(0);
        expect(ledger.committedOutputBytes).toBeNull();
    });

    it('cuts a torn ledger tail back to the last complete line', () => {
        const dir = mkdtempSync(join(tmpdir(), 'beaver-ledger-'));
        dirs.push(dir);
        const file = join(dir, 'ledger.jsonl');
        const complete = JSON.stringify({ sha256: 'a', status: 'ok', pages: 1, rows: 1, outputBytes: 9 }) + '\n';
        writeFileSync(file, complete + '{"sha256":"b","sta');
        expect(repairLedger(file)).toBe('{"sha256":"b","sta'.length);
        expect(readFileSync(file, 'utf8')).toBe(complete);
        expect(repairLedger(file)).toBe(0);
        writeFileSync(file, '{"torn');
        expect(repairLedger(file)).toBe(6);
        expect(readFileSync(file, 'utf8')).toBe('');
        expect(repairLedger(join(dir, 'missing.jsonl'))).toBe(0);
    });

    it('ignores a complete entry that lacks its trailing newline', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'beaver-ledger-'));
        dirs.push(dir);
        const file = join(dir, 'ledger.jsonl');
        writeFileSync(
            file,
            JSON.stringify({ sha256: 'a', status: 'ok', pages: 1, rows: 1, outputBytes: 10 }) + '\n' +
                JSON.stringify({ sha256: 'b', status: 'ok', pages: 1, rows: 1, outputBytes: 20 }),
        );
        const ledger = await readLedger(file);
        expect([...ledger.done]).toEqual(['a']);
        expect(ledger.entryCount).toBe(1);
        expect(ledger.committedOutputBytes).toBe(10);
        // The same tail is what repair removes, so read and repair agree.
        expect(repairLedger(file)).toBeGreaterThan(0);
        expect((await readLedger(file)).entryCount).toBe(1);
    });

    it('reports a zero commit offset for an empty ledger', async () => {
        const file = writeLedger([]);
        const ledger = await readLedger(file);
        expect(ledger.entryCount).toBe(0);
        expect(ledger.committedOutputBytes).toBe(0);
    });

    it('tracks the largest committed output offset and counts entries', async () => {
        const file = writeLedger([
            { sha256: 'a', status: 'ok', pages: 1, rows: 2, outputBytes: 120 },
            { sha256: 'b', status: 'failed', pages: 0, rows: 0, outputBytes: 120, error: 'x' },
            { sha256: 'c', status: 'ok', pages: 1, rows: 1, outputBytes: 180 },
            'torn {"sha256":"d"',
        ]);
        const ledger = await readLedger(file);
        expect(ledger.entryCount).toBe(3);
        expect(ledger.committedOutputBytes).toBe(180);
    });

    it('does not truncate when no entry carries a commit offset', () => {
        const dir = mkdtempSync(join(tmpdir(), 'beaver-ledger-'));
        dirs.push(dir);
        const out = join(dir, 'out.jsonl');
        writeFileSync(out, 'line\n');
        const untouched = discardUncommittedOutput(out, {
            done: new Set(['a']),
            abortCounts: new Map(),
            entryCount: 1,
            committedOutputBytes: null,
        });
        expect(untouched).toBe(0);
        expect(readFileSync(out, 'utf8')).toBe('line\n');
        const discarded = discardUncommittedOutput(out, {
            done: new Set(['a']),
            abortCounts: new Map(),
            entryCount: 1,
            committedOutputBytes: 2,
        });
        expect(discarded).toBe(3);
        expect(readFileSync(out, 'utf8')).toBe('li');
    });
});
