/**
 * How one outcome block draws, and what it says about the rows it did not list.
 *
 * Every block caps its rows, so each must report what it hid — a truncated list
 * with no count reads as a complete one. Hook-free components, called directly.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import type {
    BatchOutcomeBlock,
    BatchProgressEntry,
} from '@beaver/agent-core/run-state/batchProgress';
import {
    BatchOutcomeBlocks,
    BatchOutcomeBlockView,
} from '@beaver/agent-ui/chat/BatchOutcomeBlocks';

function entry(overrides: Partial<BatchProgressEntry> = {}): BatchProgressEntry {
    return {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '40 of 184',
        show_progress: true,
        ...overrides,
    };
}

function renderedText(node: React.ReactNode, out: string[] = []): string[] {
    if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
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

const text = (node: React.ReactNode) => renderedText(node).join(' ');

const view = (block: BatchOutcomeBlock, resolved?: number) =>
    text(BatchOutcomeBlockView({ block, resolved }));

describe('one outcome block', () => {
    it.each(['destination', 'removal', 'failure'] as const)(
        'reports the %s rows it hid',
        (kind) => {
            const rendered = view({
                heading: 'Heading',
                kind,
                rows: [{ label: 'Ecology', count: 4 }],
                overflow: 7,
            });
            expect(rendered).toContain('+ 7 more');
        },
    );

    it('says nothing when it listed every row', () => {
        const rendered = view({
            heading: 'Removed',
            kind: 'removal',
            rows: [{ label: 'Unsorted', count: 3 }],
        });
        expect(rendered).not.toContain('more');
    });

    it('renders the backend heading verbatim', () => {
        const rendered = view({
            heading: 'Where items went',
            kind: 'destination',
            rows: [{ label: 'Ecology', count: 4 }],
        });
        expect(rendered).toContain('Where items went');
    });

    it('renders nothing at all without rows', () => {
        expect(BatchOutcomeBlockView({ block: { heading: 'Removed', kind: 'removal' } })).toBeNull();
    });

    it('explains a destination total that runs past the item count', () => {
        // Destination rows count memberships, not items: one item takes several
        // tags, so the sum legitimately exceeds the population.
        const rendered = view(
            { heading: 'Tags applied', kind: 'destination', rows: [{ label: 'ml', count: 40 }], total: 278 },
            108,
        );
        expect(rendered).toContain('278 across 108 items');
    });

    it('does not explain a total on a removal block', () => {
        // Only destinations carry a membership total; a removal block has none.
        const rendered = view(
            { heading: 'Removed', kind: 'removal', rows: [{ label: 'needs-filing', count: 44 }], total: 44 },
            10,
        );
        expect(rendered).not.toContain('across');
    });
});

describe('the block list', () => {
    it('renders every block the backend sent, in order', () => {
        const blocks: BatchOutcomeBlock[] = [
            { heading: 'Where items went', kind: 'destination', rows: [{ label: 'Ecology', count: 4 }] },
            { heading: 'Removed', kind: 'removal', rows: [{ label: 'Inbox', count: 2 }] },
            { heading: 'Could not be read', kind: 'failure', rows: [{ label: 'No text layer', count: 1 }] },
        ];
        const tree = BatchOutcomeBlocks({ batch: entry({ blocks, resolved: 12 }) });
        const children = React.Children.toArray(
            (tree as React.ReactElement<any>).props.children,
        ) as React.ReactElement<any>[];
        expect(children.map((child) => child.props.block)).toEqual(blocks);
        // The memberships footnote needs the item count, which only the entry has.
        expect(children.every((child) => child.props.resolved === 12)).toBe(true);
    });

    it('renders nothing for an operation that records no outcomes', () => {
        // The absence of blocks is how the backend says so; the client never
        // learns which operations those are.
        expect(BatchOutcomeBlocks({ batch: entry() })).toBeNull();
    });
});
