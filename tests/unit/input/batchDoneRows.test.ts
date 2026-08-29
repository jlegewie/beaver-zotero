/**
 * The completed-batch rows a run keeps under it in the transcript.
 *
 * Driven through a hook stand-in rather than mounted — same approach as
 * `batchProgressBar.test.ts` (jsdom is not loaded). Which batches reach here is
 * `selectRunBatchOutcomes`' decision, covered in
 * `tests/unit/runState/batchProgress.test.ts`; these rows render what they are
 * given.
 */
import { describe, expect, it, vi } from 'vitest';

const { hookState } = vi.hoisted(() => ({
    hookState: { slots: [] as any[], index: 0 },
}));

vi.mock('react', async () => {
    const actual = await vi.importActual<any>('react');

    const slot = <T,>(initial: () => T): { value: T } => {
        const i = hookState.index++;
        if (hookState.slots.length <= i) hookState.slots[i] = { value: initial() };
        return hookState.slots[i];
    };

    const hooks = {
        useState: (initial: any) => {
            const cell = slot(() => (typeof initial === 'function' ? initial() : initial));
            return [cell.value, (next: any) => {
                cell.value = typeof next === 'function' ? next(cell.value) : next;
            }];
        },
        useRef: (initial: any) => slot(() => ({ current: initial })).value,
        useCallback: (fn: any) => fn,
        useEffect: () => {},
    };

    return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import React from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { BatchDoneRows } from '@beaver/agent-ui/chat/BatchDoneRows';

function entry(overrides: Partial<BatchProgressEntry> = {}): BatchProgressEntry {
    return {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '184 of 184',
        show_progress: true,
        status: 'completed',
        ...overrides,
    };
}

/** Walk the tree, invoking function components so their props are reachable. */
function elements(node: React.ReactNode, out: React.ReactElement<any>[] = []): React.ReactElement<any>[] {
    if (Array.isArray(node)) {
        node.forEach((child) => elements(child, out));
        return out;
    }
    if (!React.isValidElement(node)) return out;
    const element = node as React.ReactElement<any>;
    out.push(element);
    if (typeof element.type === 'function') {
        elements((element.type as (props: any) => React.ReactNode)(element.props), out);
        return out;
    }
    elements(element.props.children ?? null, out);
    return out;
}

/** Every string rendered, joined — what the user actually reads. */
function renderedText(node: React.ReactNode, out: string[] = []): string[] {
    if (typeof node === 'string') {
        out.push(node);
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach((child) => renderedText(child, out));
        return out;
    }
    if (!React.isValidElement(node)) return out;
    const element = node as React.ReactElement<any>;
    // The stack renders row elements, whose own function bodies only run when
    // React does. Call them here so the text of a row is reachable.
    if (typeof element.type === 'function') {
        renderedText((element.type as (props: any) => React.ReactNode)(element.props), out);
        return out;
    }
    renderedText(element.props.children ?? null, out);
    return out;
}

/** The props the stack hands each row, without rendering one. */
function rowProps(batches: BatchProgressEntry[]): { ruleAbove: boolean; showGoal: boolean }[] {
    hookState.slots = [];
    hookState.index = 0;
    const stack = BatchDoneRows({ batches }) as React.ReactElement<any>;
    // Children are [heading, rows[]]; find the array so this survives chrome changes.
    const rows = (stack.props.children as unknown[]).find(Array.isArray) as
        | React.ReactElement<any>[]
        | undefined;
    return (rows ?? []).map((row) => row.props);
}

function render(batches: BatchProgressEntry[]): string {
    hookState.slots = [];
    hookState.index = 0;
    return renderedText(BatchDoneRows({ batches }) as React.ReactNode).join(' ');
}

describe('the completed batch rows', () => {
    it('renders nothing when this run has finished no batch', () => {
        expect(BatchDoneRows({ batches: [] })).toBeNull();
    });

    it('states what a finished batch did, so it does not just vanish', () => {
        const text = render([
            entry({ progress_title: 'Filed items', progress_primary: '184 of 184' }),
        ]);
        expect(text).toContain('Filed items');
        expect(text).toContain('184 of 184');
    });

    it('states how the batch came out rather than that it reached its own total', () => {
        // "184 of 184" is the only value "N of N" can take once a batch has
        // ended, so the breakdown is the half of the line carrying anything.
        const text = render([
            entry({
                progress_title: 'Filed items',
                progress_primary: '184 of 184',
                detail_label: '151 filed · 33 left as-is',
            }),
        ]);
        expect(text).toContain('Filed items');
        expect(text).toContain('151 filed · 33 left as-is');
        expect(text).not.toContain('184 of 184');
    });

    it('falls back to the headline when a record carries no title', () => {
        const text = render([
            entry({ progress_primary: '96 of 96', progress_secondary: 'items tagged' }),
        ]);
        expect(text).toContain('96 of 96');
        expect(text).toContain('items tagged');
    });

    it('keeps stating the failures the live bar stated', () => {
        const text = render([
            entry({ progress_title: 'Filed items', failed: 7, status: 'failed_out' }),
        ]);
        expect(text).toContain('7 failed');
    });

    it('says nothing about failure for a batch that had none', () => {
        const text = render([entry({ progress_title: 'Filed items' })]);
        expect(text).not.toContain('failed');
    });

    it('opens onto the goal, the track and the distribution', () => {
        hookState.slots = [];
        hookState.index = 0;
        const batches = [
            entry({
                progress_title: 'Filed items',
                goal: 'File the Methods collection by topic',
                detail_label: '151 filed · 26 left as-is · 7 failed',
                total: 184,
                resolved: 151,
                no_change: 26,
                failed: 7,
                blocks: [
                    {
                        heading: 'Where items went',
                        kind: 'destination',
                        rows: [{ label: 'Ecology', count: 76, reference: 'CHT8AIF6' }],
                        overflow: 4,
                        total: 177,
                    },
                ],
            }),
        ];
        // Walking the tree runs the row body and mounts its hooks; slot 0 is `isExpanded`.
        renderedText(BatchDoneRows({ batches }) as React.ReactNode);
        hookState.slots[0].value = true;
        hookState.index = 0;
        const text = renderedText(BatchDoneRows({ batches }) as React.ReactNode).join(' ');
        expect(text).toContain('File the Methods collection by topic');
        // On the row's own line, and again as the track's legend — a segmented
        // bar with no caption reads as a half-finished job.
        expect(text.split('151 filed · 26 left as-is · 7 failed')).toHaveLength(3);
        expect(text).toContain('Where items went');
        expect(text).toContain('Ecology');
        expect(text).toContain('+ 4 more');
    });

    it('keeps every batch the run finished, however many that is', () => {
        const text = render([
            entry({ batch_id: 'a', progress_title: 'Filed items' }),
            entry({ batch_id: 'b', progress_title: 'Tagged items' }),
            entry({ batch_id: 'c', progress_title: 'Read attachments' }),
            entry({ batch_id: 'd', progress_title: 'Edited fields' }),
        ]);
        expect(text).toContain('Filed items');
        expect(text).toContain('Tagged items');
        expect(text).toContain('Read attachments');
        expect(text).toContain('Edited fields');
    });

    it('is a card, not a strip bleeding into something', () => {
        const stack = BatchDoneRows({ batches: [entry({ progress_title: 'Filed items' })] }) as
            React.ReactElement<any>;
        expect(stack.props.className).toContain('batch-run-receipt');
        expect(stack.props.className).toContain('rounded-card');
    });

    it('names itself, having no live bar above it to do so', () => {
        expect(render([entry({ progress_title: 'Filed items' })])).toContain('Batch job');
    });

    it('matches the approval card wording, in the number the rows call for', () => {
        // Singular is a substring of plural, so `toContain` alone would pass a hard-coded plural.
        const single = render([entry({ progress_title: 'Filed items' })]);
        expect(single).toContain('Batch job');
        expect(single).not.toContain('Batch jobs');
        expect(render([
            entry({ batch_id: 'a', progress_title: 'Filed items' }),
            entry({ batch_id: 'b', progress_title: 'Tagged items' }),
        ])).toContain('Batch jobs');
    });

    it('rules the rows off from one another', () => {
        expect(rowProps([
            entry({ batch_id: 'a', progress_title: 'Filed items' }),
            entry({ batch_id: 'b', progress_title: 'Tagged items' }),
        ]).map((row) => row.ruleAbove)).toEqual([false, true]);
    });

    it('keeps a row to one line when its label already identifies it', () => {
        const batches = [
            entry({ batch_id: 'a', progress_title: 'Filed items', goal: 'File by topic' }),
            entry({ batch_id: 'b', progress_title: 'Tagged items', goal: 'Tag by field' }),
        ];
        expect(rowProps(batches).map((row) => row.showGoal)).toEqual([false, false]);
        const text = render(batches);
        expect(text).not.toContain('File by topic');
        expect(text).not.toContain('Tag by field');
    });

    it('spends a second line on the goal when two rows share a label', () => {
        // Two `edit_metadata` batches are both "Edited items"; without the goal
        // there is nothing on the line to tell one from the other.
        const batches = [
            entry({ batch_id: 'a', progress_title: 'Edited items', goal: 'Add missing DOIs' }),
            entry({ batch_id: 'b', progress_title: 'Edited items', goal: 'Add missing abstracts' }),
        ];
        expect(rowProps(batches).map((row) => row.showGoal)).toEqual([true, true]);
        const text = render(batches);
        expect(text).toContain('Add missing DOIs');
        expect(text).toContain('Add missing abstracts');
    });

    it('labels the track when the batch recorded no distribution', () => {
        // A batch with no outcome blocks has only the caption to say what the
        // bar's segments are.
        hookState.slots = [];
        hookState.index = 0;
        const batches = [
            entry({
                operation: 'annotate',
                progress_title: 'Annotated',
                progress_primary: '29 of 29',
                detail_label: '14 annotated · 15 no change',
                goal: 'Highlight methods and findings',
                total: 29,
                resolved: 14,
                no_change: 15,
            }),
        ];
        renderedText(BatchDoneRows({ batches }) as React.ReactNode);
        hookState.slots[0].value = true;
        hookState.index = 0;
        const text = renderedText(BatchDoneRows({ batches }) as React.ReactNode).join(' ');
        expect(text).toContain('Highlight methods and findings');
        expect(text.split('14 annotated · 15 no change')).toHaveLength(3);
    });

    it('lets an opened row grow instead of scrolling inside itself', () => {
        // Nested scroll inside the transcript would swallow the wheel.
        hookState.slots = [];
        hookState.index = 0;
        const batches = [entry({ progress_title: 'Filed items', goal: 'File by topic' })];
        elements(BatchDoneRows({ batches }) as React.ReactNode);
        hookState.slots[0].value = true;
        hookState.index = 0;
        const body = elements(BatchDoneRows({ batches }) as React.ReactNode)
            .find((element) => element.props && 'bounded' in element.props);
        expect(body?.props.bounded).toBe(false);
    });
});
