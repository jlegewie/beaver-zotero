/**
 * The provider `edit` inside Zotero, as a fill drives it: a 1,000-row table
 * with abstracts, filled by 200 commits of ten rows each through
 * `/beaver/artifact`, with a retried commit (the reply lost after an
 * ambiguous timeout) and an older `seq` half-way through.
 *
 * Checks that the run's commits collapse into one retained version, that the
 * rendered snapshot names both hashes of the final `table.json`, and that the
 * replay applies nothing. Prints the measurements a fill's commit cadence is
 * set from: commit latency, file sizes, and the open tab's re-render.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isZoteroAvailable, skipIfNoZotero } from '../../helpers/zoteroAvailability';
import { post } from '../../helpers/zoteroHttpClient';

const ROWS = 1000;
const ROWS_PER_COMMIT = 10;
const COMMITS = 200;
const libraryRef = process.env.BEAVER_TEST_TABLE_LIBRARY_REF || 'u';
const stamp = Date.now();
const runId = `edit-session-run-${stamp}`;
const threadId = `edit-session-thread-${stamp}`;
const sessionId = `edit-session-${stamp}`;
const meta = { actor: 'agent', run_id: runId, thread_id: threadId, change: 'Filled table' };

let available = false;
let key = '';
let libraryID = 0;
let zoteroKey = '';

const sentence = (i: number, words: number) =>
    Array.from({ length: words }, (_, w) => `word${(i * 31 + w) % 997}`).join(' ') + '.';

function tableSpec() {
    return {
        id: `edit-session-${stamp}`,
        title: 'Edit session measurement',
        columns: [
            { id: 'abstract', header: 'Abstract', type: 'text', description: 'The abstract.' },
            { id: 'summary', header: 'Summary', type: 'text', description: 'What does the paper find?' },
            { id: 'n', header: 'Sample size', type: 'number', description: 'How many participants?' },
        ],
        rows: Array.from({ length: ROWS }, (_, i) => ({
            id: `r${i}`,
            cells: {
                abstract: {
                    outcome: 'answered',
                    provenance: 'metadata',
                    value: { kind: 'text', text: sentence(i, 90) },
                    evidence: [{ quote: sentence(i, 40), field: 'abstract' }],
                },
            },
        })),
    };
}

/** The cell writes of commit `index`: ten rows of one column, as the filler writes them. */
function commitCells(index: number) {
    const column = index < COMMITS / 2 ? 'summary' : 'n';
    const first = (index % (COMMITS / 2)) * ROWS_PER_COMMIT;
    return Array.from({ length: ROWS_PER_COMMIT }, (_, offset) => {
        const row = first + offset;
        const cell =
            column === 'summary'
                ? { kind: 'text', text: `Finding ${row}: ${sentence(row, 25)}` }
                : { kind: 'number', value: 100 + row };
        return {
            row: `r${row}`,
            column,
            cell: {
                outcome: 'answered',
                provenance: 'document',
                value: cell,
                evidence: [{ locator: `s${row % 50}-s${(row % 50) + 2}`, quote: sentence(row, 30), page: row % 12 }],
                reasoning: sentence(row + 7, 20),
            },
        };
    });
}

const artifact = (op: string, fields: Record<string, unknown> = {}) =>
    post<any>(
        '/beaver/artifact',
        {
            event: 'artifact_request',
            request_id: `${sessionId}-${op}-${Math.random()}`,
            op,
            ...(key ? { key } : {}),
            ...fields,
        },
        { timeout: 120_000 },
    );

const edit = (seq: number, cells: unknown[]) =>
    artifact('edit', { operation_id: sessionId, seq, mutations: [{ op: 'set_cells', cells }], meta });

function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

beforeAll(async () => {
    available = await isZoteroAvailable();
});

afterAll(async () => {
    if (available && key) await artifact('delete').catch(() => {});
});

describe('provider edit sessions in Zotero', () => {
    it('fills a 1,000-row table with 200 commits into one retained version and a current snapshot', async (ctx) => {
        skipIfNoZotero(ctx, available);
        const created = await artifact('create', {
            kind: 'table',
            library_ref: libraryRef,
            title: 'Edit session measurement',
            spec: tableSpec(),
            meta,
            operation_id: `${sessionId}-create`,
        });
        expect(created).toMatchObject({ ok: true, version: 1 });
        key = `${created.zotero_item.library_ref}-${created.zotero_item.zotero_key}`;
        libraryID = created.zotero_item.library_id;
        zoteroKey = created.zotero_item.zotero_key;

        // The open tab re-renders from the store's update event after each commit.
        const opened = await post<any>('/beaver/test/table-tab', { command: 'open', key: zoteroKey, libraryID }).catch(() => null);

        const latencies: number[] = [];
        let last: any = null;
        for (let index = 0; index < COMMITS; index++) {
            const seq = index + 1;
            const cells = commitCells(index);
            const started = performance.now();
            last = await edit(seq, cells);
            latencies.push(performance.now() - started);
            expect(last, `commit ${seq}`).toMatchObject({ ok: true, version: 2, skipped: [] });

            if (seq === COMMITS / 2) {
                // The reply was lost: the same request again replays, applying nothing.
                const replay = await edit(seq, cells);
                expect(replay).toMatchObject({ ok: true, replayed: true, version: 2, sha256: last.sha256, skipped: [] });
                expect(await edit(seq - 1, commitCells(index - 1))).toMatchObject({ ok: false, error_code: 'stale_seq' });
            }
        }

        const versions = await artifact('versions');
        expect(versions.versions.map((v: any) => v.version)).toEqual([1, 2]);
        const read = await artifact('read');
        expect(read.sha256).toBe(last.sha256);
        expect(read.summary.columns_detail.summary).toMatchObject({ answered: ROWS, unattempted: 0 });
        expect(read.summary.columns_detail.n).toMatchObject({ answered: ROWS, unattempted: 0 });

        const local = await post<any>('/beaver/test/table-read', { key: zoteroKey, libraryID });
        const directory: string = local.storage_directory;
        const tableFile = await readFile(join(directory, 'table.json'));
        const htmlName = (await readdir(directory)).find((name) => name.endsWith('.html'))!;
        const html = await readFile(join(directory, htmlName), 'utf8');
        expect(html).toContain(`data-beaver-spec-sha256="${last.sha256}"`);
        expect(html).toContain(`data-beaver-file-sha256="${sha256(tableFile)}"`);
        expect(JSON.parse(await readFile(join(directory, 'beaver', 'bookkeeping.json'), 'utf8'))).toEqual({
            sha256: last.sha256,
            file_sha256: sha256(tableFile),
        });

        const tab = opened ? await post<any>('/beaver/test/table-tab', { command: 'state' }).catch(() => null) : null;
        const entry = tab?.entries?.find((e: any) => e.key === zoteroKey);
        console.log(
            'edit session measurement',
            JSON.stringify(
                {
                    rows: ROWS,
                    commits: COMMITS,
                    rows_per_commit: ROWS_PER_COMMIT,
                    commit_ms: stats(latencies),
                    table_json_bytes: tableFile.length,
                    html_bytes: Buffer.byteLength(html),
                    tab_last_renders: entry?.renders ?? null,
                },
                null,
                2,
            ),
        );
    }, 15 * 60_000);
});
