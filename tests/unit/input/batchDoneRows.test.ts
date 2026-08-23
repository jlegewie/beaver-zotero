/**
 * The completed-batch rows stacked under the live progress bar.
 *
 * Driven through a hook stand-in rather than mounted — same approach as
 * `batchProgressBar.test.ts` (jsdom is not loaded). Which batches are `done` is
 * `selectBatchPanelGroups`' decision, covered in
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

    it('falls back to the headline when a record carries no title', () => {
        const text = render([
            entry({ progress_primary: '96 of 96', progress_secondary: 'items tagged' }),
        ]);
        expect(text).toContain('96 of 96');
        expect(text).toContain('items tagged');
    });

    it('keeps stating the failures the live bar stated', () => {
        // A batch must not lose its numbers by finishing.
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
        // Walking the tree is what runs the row's own body, and so what mounts
        // its hooks; the state it allocates there is what the click flips.
        renderedText(BatchDoneRows({ batches }) as React.ReactNode);
        // Slot 0 is the stack's `showAll`; slot 1 is the row's `isExpanded`.
        hookState.slots[1].value = true;
        hookState.index = 0;
        const text = renderedText(BatchDoneRows({ batches }) as React.ReactNode).join(' ');
        expect(text).toContain('File the Methods collection by topic');
        expect(text).toContain('151 filed · 26 left as-is · 7 failed');
        expect(text).toContain('Where items went');
        expect(text).toContain('Ecology');
        expect(text).toContain('+ 4 more');
    });

    it('folds everything past the first two behind one line', () => {
        const text = render([
            entry({ batch_id: 'a', progress_title: 'Filed items' }),
            entry({ batch_id: 'b', progress_title: 'Tagged items' }),
            entry({ batch_id: 'c', progress_title: 'Read attachments' }),
            entry({ batch_id: 'd', progress_title: 'Edited fields' }),
        ]);
        expect(text).toContain('Filed items');
        expect(text).toContain('Tagged items');
        expect(text).not.toContain('Read attachments');
        expect(text).not.toContain('Edited fields');
        expect(text).toContain('2 more completed');
    });

    it('shows every row once the overflow line is opened', () => {
        hookState.slots = [];
        hookState.index = 0;
        const batches = [
            entry({ batch_id: 'a', progress_title: 'Filed items' }),
            entry({ batch_id: 'b', progress_title: 'Tagged items' }),
            entry({ batch_id: 'c', progress_title: 'Read attachments' }),
        ];
        // First pass mounts the hooks; flipping the stack's own state and
        // re-rendering is what the click does.
        BatchDoneRows({ batches });
        hookState.slots[0].value = true;
        hookState.index = 0;
        const text = renderedText(BatchDoneRows({ batches }) as React.ReactNode).join(' ');
        expect(text).toContain('Read attachments');
        // The open row must not still offer rows it has already revealed.
        expect(text).not.toContain('more completed');
        expect(text).toContain('Show fewer');
    });

    it('keeps the two most recent completions, which arrive first', () => {
        const text = render([
            entry({ batch_id: 'newest', progress_title: 'Edited fields' }),
            entry({ batch_id: 'older', progress_title: 'Tagged items' }),
            entry({ batch_id: 'oldest', progress_title: 'Filed items' }),
        ]);
        expect(text).toContain('Edited fields');
        expect(text).toContain('Tagged items');
        expect(text).not.toContain('Filed items');
    });
});
