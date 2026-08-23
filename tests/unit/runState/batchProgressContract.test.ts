import { describe, it, expect } from 'vitest';
import {
    isBatchProgressStamp,
    selectTrackedBatch,
} from '@beaver/agent-core/run-state/batchProgress';
import type { BatchProgressStamp } from '@beaver/agent-core/run-state/batchProgress';

import sortStamp from './fixtures/batchProgress-sort.json';
import tagStamp from './fixtures/batchProgress-tag.json';
import editMetadataStamp from './fixtures/batchProgress-edit_metadata.json';
import annotateStamp from './fixtures/batchProgress-annotate.json';
import extractStamp from './fixtures/batchProgress-extract.json';
import createNotesStamp from './fixtures/batchProgress-create_notes.json';
import completedStamp from './fixtures/batchProgress-completed.json';

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
};

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
        expect(tracked.tally_heading).toBeTruthy();
        expect(tracked.tallies?.length).toBeGreaterThan(0);
    });

    it.each(['annotate', 'extract', 'create_notes'])('%s carries none', (name) => {
        // Their outcome label is the same string on every call. The client hides
        // the block on the empty heading alone and never learns the list.
        const tracked = selectTrackedBatch(FIXTURES[name] as BatchProgressStamp)!;
        expect(tracked.tally_heading ?? '').toBe('');
        expect(tracked.tallies ?? []).toEqual([]);
    });
});

describe('sort destinations', () => {
    const tracked = selectTrackedBatch(sortStamp as BatchProgressStamp)!;

    it('arrive as names, not collection keys', () => {
        // The backend composes these from the `collection_names` this client
        // returns while validating the action, then splits the composed label
        // back into halves — so nothing here resolves a key.
        for (const row of tracked.tallies ?? []) {
            expect(row.label).not.toMatch(/^[A-Z0-9]{8}$/);
            expect(row.label).not.toMatch(/\([A-Z0-9]{8}\)$/);
        }
    });

    it('keep the key as the row identity', () => {
        expect(tracked.tallies?.[0].reference).toMatch(/^[A-Z0-9]{8}$/);
    });

    it('mark a destination the run invented', () => {
        const created = (tracked.tallies ?? []).filter((row) => row.created);
        expect(created).toHaveLength(1);
        expect(created[0].label).toBe('Remote sensing');
    });

    it('keep removals out of the distribution', () => {
        expect((tracked.tallies ?? []).some((row) => row.removal)).toBe(false);
        expect(tracked.removals?.[0].removal).toBe(true);
        expect(tracked.removals?.[0].label).toBe('Inbox');
    });

    it('report a tally sum the listed rows are a share of', () => {
        const listed = (tracked.tallies ?? []).reduce((sum, row) => sum + row.count, 0);
        expect(tracked.tallies_total).toBeGreaterThanOrEqual(listed);
        expect(tracked.tallies_overflow).toBeGreaterThan(0);
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
        const reasons = tracked.failure_reasons ?? [];
        expect(reasons.length).toBeGreaterThan(0);
        // Grouping keys are also the text a user reads, so no placeholders.
        for (const reason of reasons) expect(reason.label).not.toMatch(/<[a-z]+>/);
    });

    it('counts tag memberships past the item count', () => {
        // One item takes several tags, so the sum deliberately exceeds what was
        // resolved — the bar states this rather than leaving it to be inferred.
        const tracked = selectTrackedBatch(tagStamp as BatchProgressStamp)!;
        expect(tracked.tallies_total!).toBeGreaterThan(tracked.resolved!);
    });
});
