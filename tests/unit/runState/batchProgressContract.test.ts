import { describe, it, expect } from 'vitest';
import {
    isBatchProgressStamp,
    selectLiveBatchProgress,
    selectTrackedBatch,
} from '@beaver/agent-core/run-state/batchProgress';
import type {
    BatchProgressEntry,
    BatchProgressStamp,
} from '@beaver/agent-core/run-state/batchProgress';
import type { AgentRun } from '@beaver/agent-core/agents/types';

import sortStamp from './fixtures/batchProgress-sort.json';
import tagStamp from './fixtures/batchProgress-tag.json';
import editMetadataStamp from './fixtures/batchProgress-edit_metadata.json';
import annotateStamp from './fixtures/batchProgress-annotate.json';
import extractStamp from './fixtures/batchProgress-extract.json';
import createNotesStamp from './fixtures/batchProgress-create_notes.json';
import reviewStamp from './fixtures/batchProgress-review.json';
import removalsOverflowStamp from './fixtures/batchProgress-removals-overflow.json';
import failuresOverflowStamp from './fixtures/batchProgress-failures-overflow.json';
import completedStamp from './fixtures/batchProgress-completed.json';
import pausedStamp from './fixtures/batchProgress-paused.json';

/**
 * The wire contract, against payloads the BACKEND actually produced.
 *
 * The fixtures are `build_progress_stamp` output captured from the real
 * builder, one per operation, not hand-written approximations. They exist
 * because the two halves of this feature live in different repositories: a
 * field renamed backend-side type-checks perfectly here and shows up as a blank
 * row in the bar, with nothing failing. These tests are what turns that into a
 * red test instead.
 *
 * Re-capture them by running `build_progress_stamp` in beaver-backend when the
 * record changes shape.
 */

const FIXTURES: Record<string, unknown> = {
    sort: sortStamp,
    tag: tagStamp,
    edit_metadata: editMetadataStamp,
    annotate: annotateStamp,
    extract: extractStamp,
    create_notes: createNotesStamp,
    review: reviewStamp,
};

/** A live run carrying `stamp` on its only tool return. */
function liveRun(stamp: unknown): AgentRun {
    return {
        id: 'r1',
        status: 'in_progress',
        model_messages: [
            {
                kind: 'request',
                run_id: 'r1',
                instructions: '',
                parts: [
                    {
                        part_kind: 'tool-return',
                        tool_name: 'organize_items',
                        tool_call_id: 'call-0',
                        content: {},
                        metadata: { batch_progress: stamp },
                    },
                ],
            },
        ],
    } as unknown as AgentRun;
}

/** The outcome block of `kind` on an entry, or undefined. */
function block(entry: BatchProgressEntry, kind = 'destination') {
    return (entry.blocks ?? []).find((b) => b.kind === kind);
}

const rowsOf = (entry: BatchProgressEntry, kind = 'destination') =>
    block(entry, kind)?.rows ?? [];

describe('backend payload contract', () => {
    it.each(Object.keys(FIXTURES))('reads a real %s record', (name) => {
        const stamp = FIXTURES[name];
        expect(isBatchProgressStamp(stamp)).toBe(true);
        const tracked = selectTrackedBatch(stamp as BatchProgressStamp);
        expect(tracked).not.toBeNull();
        // The things the collapsed bar renders. A backend rename of any of
        // them shows up here rather than as a blank row.
        expect(tracked!.operation).toBe(name);
        expect(tracked!.progress_title).toBeTruthy();
        expect(tracked!.progress_primary).toMatch(/\d/);
        expect(tracked!.progress_secondary).toBeTruthy();
        expect(tracked!.total).toBeGreaterThan(0);
    });

    it('marks every operation big enough to show', () => {
        // Every fixture is a realistic population, so the backend's own
        // threshold should pass all of them — if one stops passing, the slice
        // sizes moved and the floor needs revisiting.
        for (const stamp of Object.values(FIXTURES)) {
            expect(selectTrackedBatch(stamp as BatchProgressStamp)).not.toBeNull();
        }
    });
});

describe('the title, which is the only thing the counts cannot say', () => {
    it.each([
        ['sort', 'Filing items'],
        ['tag', 'Tagging'],
        ['extract', 'Reading'],
        ['annotate', 'Annotating'],
        ['edit_metadata', 'Editing items'],
        ['create_notes', 'Writing notes'],
        ['review', 'Reviewing'],
    ])('names what a running %s batch is doing', (name, expected) => {
        const tracked = selectTrackedBatch(FIXTURES[name] as BatchProgressStamp)!;
        expect(tracked.progress_title).toBe(expected);
    });

    it('moves to the past once the batch is over', () => {
        // The bar outlives the batch by design, so a present participle beside
        // a completed tick would read as work still going on.
        const tracked = selectTrackedBatch(completedStamp as BatchProgressStamp)!;
        expect(tracked.status).toBe('completed');
        expect(tracked.progress_title).toBe('Filed items');
    });

    it('stays short enough to share one line with the count', () => {
        // The bar is one line in a narrow sidebar and the title shares it with
        // the count and, when things go wrong, a failure chip.
        for (const stamp of [...Object.values(FIXTURES), completedStamp]) {
            const tracked = selectTrackedBatch(stamp as BatchProgressStamp)!;
            expect(tracked.progress_title!.length).toBeLessThanOrEqual(14);
        }
    });

    it('is optional, so an older backend still renders', () => {
        // The plugin ships against a backend that may not have deployed this
        // field yet. The bar falls back to the headline; nothing must require
        // the title to be present.
        const { progress_title: _omitted, ...withoutTitle } = selectTrackedBatch(
            sortStamp as BatchProgressStamp,
        )!;
        expect(isBatchProgressStamp({ batches: [withoutTitle] })).toBe(true);
    });
});

describe('the distribution the backend registry decides', () => {
    it.each(['sort', 'tag', 'edit_metadata'])('%s carries a heading and rows', (name) => {
        const tracked = selectTrackedBatch(FIXTURES[name] as BatchProgressStamp)!;
        expect(block(tracked)?.heading).toBeTruthy();
        expect(rowsOf(tracked).length).toBeGreaterThan(0);
    });

    it.each(['annotate', 'extract', 'create_notes', 'review'])('%s carries none', (name) => {
        // Their outcome label is the same string on every call. No block is
        // sent, so the client renders nothing and never learns the list.
        const tracked = selectTrackedBatch(FIXTURES[name] as BatchProgressStamp)!;
        expect(block(tracked)).toBeUndefined();
    });
});

describe('findings, which any operation may record', () => {
    // A review changes nothing: every item ends either flagged with a finding
    // or recorded as having no issue, so this is the block the bar and the
    // receipt draw for it. Renamed backend-side, a review would read as a
    // batch that did nothing.
    const tracked = selectTrackedBatch(reviewStamp as BatchProgressStamp)!;

    it('arrive as their own block, grouped by finding', () => {
        expect(block(tracked, 'finding')?.heading).toBe('Findings');
        const rows = rowsOf(tracked, 'finding');
        expect(rows.length).toBeGreaterThan(0);
        // Most-common first, so the collapsed panel shows the biggest group.
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1].count).toBeGreaterThanOrEqual(rows[i].count);
        }
    });

    it('count items, so the block total is the findings count', () => {
        expect(tracked.findings).toBeGreaterThan(0);
        expect(block(tracked, 'finding')?.total).toBe(tracked.findings);
    });

    it('fill the track alongside the items found in order', () => {
        // Both are decisions the model made, so both count as done.
        const done = (tracked.no_change ?? 0) + (tracked.findings ?? 0);
        expect(tracked.progress_primary).toBe(`${done} of ${tracked.total}`);
        expect(tracked.detail_label).toContain('findings');
        expect(tracked.detail_label).toContain('no issue');
    });

    it('name what a review does without claiming a change', () => {
        expect(tracked.resolved).toBeUndefined();
        expect(tracked.progress_secondary).toBe('items reviewed');
    });
});

describe('sort destinations', () => {
    const tracked = selectTrackedBatch(sortStamp as BatchProgressStamp)!;

    it('arrive as names, not collection keys', () => {
        // The backend composes these from the `collection_names` this client
        // returns while validating the action, then splits the composed label
        // back into halves — so nothing here resolves a key.
        for (const row of rowsOf(tracked)) {
            expect(row.label).not.toMatch(/^[A-Z0-9]{8}$/);
            expect(row.label).not.toMatch(/\([A-Z0-9]{8}\)$/);
        }
    });

    it('keep the key as the row identity', () => {
        expect(rowsOf(tracked)[0].reference).toMatch(/^[A-Z0-9]{8}$/);
    });

    it('mark a destination the run invented', () => {
        const created = (rowsOf(tracked)).filter((row) => row.created);
        expect(created).toHaveLength(1);
        expect(created[0].label).toBe('Remote sensing');
    });

    it('keep removals in their own block, out of the distribution', () => {
        expect(rowsOf(tracked).map((row) => row.label)).not.toContain('Inbox');
        expect(rowsOf(tracked, 'removal').map((row) => row.label)).toEqual(['Inbox']);
        expect(block(tracked, 'removal')?.heading).toBe('Removed');
    });

    it('report a tally sum the listed rows are a share of', () => {
        const listed = (rowsOf(tracked)).reduce((sum, row) => sum + row.count, 0);
        expect(block(tracked)?.total).toBeGreaterThanOrEqual(listed);
        expect(block(tracked)?.overflow).toBeGreaterThan(0);
    });
});

describe('per-operation wording the registry owns', () => {
    it('calls an extract population attachments, not items', () => {
        const tracked = selectTrackedBatch(extractStamp as BatchProgressStamp)!;
        expect(tracked.progress_secondary).toBe('attachments read');
    });

    it("uses extract's own word for an item it left alone", () => {
        // "left as-is" would be wrong: nothing was collected from it, rather
        // than nothing needing to change on it.
        const tracked = selectTrackedBatch(extractStamp as BatchProgressStamp)!;
        expect(tracked.detail_label).toContain('not usable / not relevant');
    });

    it('reports why extract could not read a document', () => {
        const tracked = selectTrackedBatch(extractStamp as BatchProgressStamp)!;
        const reasons = rowsOf(tracked, 'failure');
        expect(reasons.length).toBeGreaterThan(0);
        // Grouping keys are also the text a user reads, so no placeholders.
        for (const reason of reasons) expect(reason.label).not.toMatch(/<[a-z]+>/);
    });

    it('counts tag memberships past the item count', () => {
        // One item takes several tags, so the sum deliberately exceeds what was
        // resolved — the bar states this rather than leaving it to be inferred.
        const tracked = selectTrackedBatch(tagStamp as BatchProgressStamp)!;
        expect(block(tracked)!.total!).toBeGreaterThan(tracked.resolved!);
    });
});

describe('a capped list says what it hides', () => {
    // A truncated list with no count reads as a complete one, so every block
    // that caps its rows reports the remainder.
    it('reports the destination rows left off the distribution', () => {
        const tracked = selectTrackedBatch(tagStamp as BatchProgressStamp)!;
        expect(block(tracked)?.overflow).toBeGreaterThan(0);
    });

    it('reports the removal rows left off', () => {
        const tracked = selectTrackedBatch(removalsOverflowStamp as BatchProgressStamp)!;
        expect(rowsOf(tracked, 'removal').length).toBeGreaterThan(0);
        expect(block(tracked, 'removal')?.overflow).toBeGreaterThan(0);
    });

    it('reports the failure reasons left off', () => {
        const tracked = selectTrackedBatch(failuresOverflowStamp as BatchProgressStamp)!;
        expect(rowsOf(tracked, 'failure').length).toBeGreaterThan(0);
        expect(block(tracked, 'failure')?.overflow).toBeGreaterThan(0);
    });

    it('omits the count when every row was listed', () => {
        // Absent, not zero — the backend drops a default-valued field.
        const tracked = selectTrackedBatch(sortStamp as BatchProgressStamp)!;
        expect(rowsOf(tracked, 'removal').length).toBe(1);
        expect(block(tracked, 'removal')?.overflow).toBeUndefined();
    });
});


describe('a paused batch, which no live surface draws', () => {
    // Captured from a run working `b1` while `b2` sits open from an earlier
    // turn. The flag is the whole contract: renamed backend-side, a paused
    // batch reads as active again and the bar claims work nothing is doing.
    const entries = (pausedStamp as BatchProgressStamp).batches;

    it('flags the batch nothing is working', () => {
        expect(entries.find((e) => e.batch_id === 'b2')!.paused).toBe(true);
    });

    it('omits the flag on the batch the run IS working', () => {
        const worked = entries.find((e) => e.batch_id === 'b1')!;
        expect(worked.paused).toBeUndefined();
        expect(worked.is_handover).toBe(true);
    });

    it('is otherwise a complete record, so nothing renders half a row', () => {
        // Paused is about whether to draw it at all, not about what it holds:
        // the entry still has to satisfy the type guard.
        expect(isBatchProgressStamp(pausedStamp)).toBe(true);
    });

    it('is kept out of the panel while the worked batch stays in', () => {
        const live = selectLiveBatchProgress([liveRun(pausedStamp)]);
        expect(live?.batches.map((e) => e.batch_id)).toEqual(['b1']);
    });
});
