/**
 * Queue rendering for the batch progress bar.
 *
 * Driven through a hook stand-in rather than mounted — same approach as
 * `batchApprovalCard.test.ts` (jsdom is not loaded).
 *
 * Which batches reach the bar is `selectBatchPanelGroups`' decision, covered in
 * `tests/unit/runState/batchProgress.test.ts`; the bar renders what it is given.
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
import { BatchProgressBar } from '@beaver/agent-ui/chat/BatchProgressBar';

function entry(overrides: Partial<BatchProgressEntry> = {}): BatchProgressEntry {
    return {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '40 of 184',
        show_progress: true,
        ...overrides,
    };
}

/** Every string the bar renders, joined — what the user actually reads. */
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
    renderedText((node as React.ReactElement<any>).props.children ?? null, out);
    return out;
}

function render(batch: BatchProgressEntry, queuedBatches: BatchProgressEntry[]): string {
    hookState.slots = [];
    hookState.index = 0;
    const tree = BatchProgressBar({ batch, queuedBatches }) as React.ReactNode;
    return renderedText(tree).join(' ');
}

const tracked = entry({ batch_id: 'tracked', progress_title: 'Filing items' });

describe('the batch progress bar queue', () => {
    it('names a sibling that is still to come', () => {
        const text = render(tracked, [
            entry({ batch_id: 'next', progress_title: 'Tagging items' }),
        ]);
        expect(text).toContain('Tagging items');
    });

    it('counts repeats of one kind of work rather than listing them', () => {
        const text = render(tracked, [
            entry({ batch_id: 'a', progress_title: 'Tagging items' }),
            entry({ batch_id: 'b', progress_title: 'Tagging items' }),
        ]);
        expect(text).toContain('Tagging items ×2');
    });

    it('renders the tracked batch when nothing is queued behind it', () => {
        const text = render(tracked, []);
        expect(text).toContain('Filing items');
    });
});

/**
 * The live bar renders `BatchOutcomeBody` only once opened. The hook stand-in
 * has no re-render, so flip the disclosure's state cell and call again.
 */
function renderExpanded(batch: BatchProgressEntry): React.ReactNode {
    hookState.slots = [];
    hookState.index = 0;
    BatchProgressBar({ batch, queuedBatches: [] });
    hookState.slots[0].value = true;
    hookState.index = 0;
    return BatchProgressBar({ batch, queuedBatches: [] }) as React.ReactNode;
}

/** The opened batch's body element, wherever it sits in the tree. */
function outcomeBody(node: React.ReactNode): React.ReactElement<any> | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = outcomeBody(child);
            if (found) return found;
        }
        return null;
    }
    if (!React.isValidElement(node)) return null;
    const props = (node as React.ReactElement<any>).props ?? {};
    if ('bounded' in props || 'maxRows' in props) return node as React.ReactElement<any>;
    return outcomeBody(props.children ?? null);
}

describe('the batch progress bar, opened', () => {
    const batch = entry({
        blocks: [
            {
                heading: 'Where items went',
                kind: 'destination',
                rows: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
                    label: `Collection ${n}`,
                    count: 10 - n,
                    reference: `KEY0000${n}`,
                })),
            },
        ],
    });

    it('caps the distribution at what the strip has room for', () => {
        const body = outcomeBody(renderExpanded(batch));
        expect(body).not.toBeNull();
        expect(body?.props.maxRows).toBe(5);
    });

    it('does not offer its rows as places to go', () => {
        const body = outcomeBody(renderExpanded(batch));
        // Assert the body was found first: `undefined?.props` is falsy too, and
        // a walker that stopped matching would pass this test in silence.
        expect(body).not.toBeNull();
        expect(body?.props.revealTargets).toBeFalsy();
    });
});
