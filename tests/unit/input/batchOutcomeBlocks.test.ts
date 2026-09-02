/**
 * How one outcome block draws, and what it says about the rows it did not list.
 *
 * Every block caps its rows, so each must report what it hid — a truncated list
 * with no count reads as a complete one. Hook-free components, called directly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import type {
    BatchOutcomeBlock,
    BatchProgressEntry,
} from '@beaver/agent-core/run-state/batchProgress';
import {
    BatchOutcomeBlocks,
    BatchOutcomeBlockView,
    BatchProgressTrack,
} from '@beaver/agent-ui/chat/BatchOutcomeBlocks';
import { setHost } from '@beaver/agent-ui/host';

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
    it.each(['destination', 'removal', 'finding', 'failure'] as const)(
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

describe('the progress track', () => {
    it('captions the bar with the backend breakdown', () => {
        expect(
            text(
                BatchProgressTrack({
                    batch: entry({
                        detail_label: '14 annotated · 15 no change',
                        total: 29,
                        resolved: 14,
                        no_change: 15,
                    }),
                }),
            ),
        ).toContain('14 annotated · 15 no change');
    });

    it('falls back to the headline count when there is no breakdown', () => {
        // Older records, and a just-started batch, may omit detail_label.
        expect(
            text(
                BatchProgressTrack({
                    batch: entry({ progress_primary: '0 of 29', total: 29 }),
                }),
            ),
        ).toContain('0 of 29');
    });

    it('omits the caption when asked', () => {
        expect(
            text(
                BatchProgressTrack({
                    batch: entry({
                        detail_label: '14 annotated · 15 no change',
                        progress_primary: '29 of 29',
                    }),
                    showDetail: false,
                }),
            ),
        ).toBe('');
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

/** Every `BatchTallyRow` element the block rendered, in order. */
function tallyRows(node: React.ReactNode): React.ReactElement<any>[] {
    const element = node as React.ReactElement<any> | null;
    if (!element) return [];
    return (React.Children.toArray(element.props.children) as React.ReactElement<any>[]).filter(
        (child) => React.isValidElement(child) && 'onActivate' in (child.props ?? {}),
    );
}

describe('a block with more rows than the surface has room for', () => {
    const block: BatchOutcomeBlock = {
        heading: 'Tags applied',
        kind: 'destination',
        rows: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `tag-${n}`, count: 10 - n })),
        overflow: 3,
    };

    it('lists every row it was sent when uncapped', () => {
        expect(tallyRows(BatchOutcomeBlockView({ block }))).toHaveLength(6);
        expect(view(block)).toContain('+ 3 more');
    });

    it('lists only the capped rows', () => {
        const capped = BatchOutcomeBlockView({ block, maxRows: 4 });
        expect(tallyRows(capped).map((row) => row.props.name)).toEqual([
            'tag-1',
            'tag-2',
            'tag-3',
            'tag-4',
        ]);
    });

    it('counts the rows it dropped alongside the ones the backend never sent', () => {
        // 3 withheld by the backend + 2 dropped by the cap.
        expect(text(BatchOutcomeBlockView({ block, maxRows: 4 }))).toContain('+ 5 more');
    });

    it('scales the bars against the whole block, not the part it listed', () => {
        const capped = tallyRows(BatchOutcomeBlockView({ block, maxRows: 2 }));
        expect(capped.every((row) => row.props.top === 9)).toBe(true);
    });
});

describe('a row that names something in the library', () => {
    afterEach(() => setHost({}));

    const sortBlock: BatchOutcomeBlock = {
        heading: 'Where items went',
        kind: 'destination',
        rows: [{ label: 'Ecology', count: 4, reference: 'CHT8AIF6' }],
    };

    it('is inert without an operation, whatever the host offers', () => {
        setHost({ navigation: { revealBatchOutcome: () => {} } as any });
        expect(tallyRows(BatchOutcomeBlockView({ block: sortBlock }))[0].props.onActivate)
            .toBeUndefined();
    });

    it('is inert when the host cannot go there', () => {
        setHost({});
        expect(
            tallyRows(BatchOutcomeBlockView({ block: sortBlock, operation: 'sort' }))[0].props
                .onActivate,
        ).toBeUndefined();
    });

    it('hands the host what the row names', () => {
        const seen: unknown[] = [];
        setHost({ navigation: { revealBatchOutcome: (t: unknown) => seen.push(t) } as any });
        const row = tallyRows(BatchOutcomeBlockView({ block: sortBlock, operation: 'sort' }))[0];
        row.props.onActivate();
        expect(seen).toEqual([
            { kind: 'collection', key: 'CHT8AIF6', name: 'Ecology', libraryRef: undefined },
        ]);
    });

    it('hands the host the batch library when the batch named one', () => {
        const seen: any[] = [];
        setHost({ navigation: { revealBatchOutcome: (t: unknown) => seen.push(t) } as any });
        const row = tallyRows(
            BatchOutcomeBlockView({ block: sortBlock, operation: 'sort', libraryRef: 'g900' }),
        )[0];
        row.props.onActivate();
        expect(seen[0].libraryRef).toBe('g900');
    });

    it('leaves a failure reason alone', () => {
        setHost({ navigation: { revealBatchOutcome: () => {} } as any });
        const rendered = BatchOutcomeBlockView({
            block: { heading: 'Could not be read', kind: 'failure', rows: [{ label: 'No text layer', count: 2 }] },
            operation: 'extract',
        });
        expect(tallyRows(rendered)).toHaveLength(0);
    });
});

describe('the block list and the surface it draws on', () => {
    it('offers the rows only where the surface asked for it', () => {
        const batch = entry({
            blocks: [
                { heading: 'Where items went', kind: 'destination', rows: [{ label: 'Ecology', count: 4 }] },
            ],
        });
        const operationOf = (node: React.ReactNode) =>
            (React.Children.toArray((node as React.ReactElement<any>).props.children)[0] as
                React.ReactElement<any>).props.operation;
        expect(operationOf(BatchOutcomeBlocks({ batch }))).toBeUndefined();
        expect(operationOf(BatchOutcomeBlocks({ batch, revealTargets: true }))).toBe('sort');
    });

    it("passes the batch's library down to its blocks", () => {
        const batch = entry({
            library_ref: 'g900',
            blocks: [
                { heading: 'Tags applied', kind: 'destination', rows: [{ label: 'methods', count: 4 }] },
            ],
        });
        const block = React.Children.toArray(
            (BatchOutcomeBlocks({ batch, revealTargets: true }) as React.ReactElement<any>).props
                .children,
        )[0] as React.ReactElement<any>;
        expect(block.props.libraryRef).toBe('g900');
    });
});
