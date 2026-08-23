/**
 * Queue rendering for the batch progress bar.
 *
 * Driven through a hook stand-in rather than mounted — same approach as
 * `batchApprovalCard.test.ts` (jsdom is not loaded).
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

function render(batch: BatchProgressEntry, otherBatches: BatchProgressEntry[]): string {
    hookState.slots = [];
    hookState.index = 0;
    const tree = BatchProgressBar({ batch, otherBatches }) as React.ReactNode;
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

    it('leaves out a sibling that has already finished', () => {
        const text = render(tracked, [
            entry({ batch_id: 'done', progress_title: 'Tagging items', status: 'completed' }),
        ]);
        expect(text).not.toContain('Tagging items');
    });

    it.each(['completed', 'failed_out', 'cancelled'] as const)(
        'leaves out a %s sibling',
        (status) => {
            const text = render(tracked, [
                entry({ batch_id: 'ended', progress_title: 'Reading documents', status }),
            ]);
            expect(text).not.toContain('Reading documents');
        },
    );

    it('leaves out a sibling the backend said is too small to show', () => {
        const text = render(tracked, [
            entry({
                batch_id: 'small',
                progress_title: 'Tagging items',
                show_progress: false,
            }),
        ]);
        expect(text).not.toContain('Tagging items');
    });

    it('keeps the open siblings and drops only the ended ones', () => {
        const text = render(tracked, [
            entry({ batch_id: 'done', progress_title: 'Tagging items', status: 'completed' }),
            entry({ batch_id: 'next', progress_title: 'Reading documents' }),
        ]);
        expect(text).toContain('Reading documents');
        expect(text).not.toContain('Tagging items');
    });

    it('still renders the tracked batch when every sibling has ended', () => {
        const text = render(tracked, [
            entry({ batch_id: 'done', progress_title: 'Tagging items', status: 'completed' }),
        ]);
        expect(text).toContain('Filing items');
    });
});
