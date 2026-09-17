/**
 * How one outcome block draws, and what it says about the rows it did not list.
 *
 * Every block caps its rows, so each must report what it hid — a truncated list
 * with no count reads as a complete one. The block components are hook-free and
 * called directly; the rows they draw own their disclosure state, so the walkers
 * below invoke function components under a hook stand-in (jsdom is not loaded),
 * the same approach as `batchDoneRows.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        useMemo: (fn: any) => fn(),
        useEffect: () => {},
    };

    return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import React from 'react';
import type {
    BatchItemsRecord,
    BatchOutcomeBlock,
    BatchPopulationLookup,
    BatchProgressEntry,
} from '@beaver/agent-core/run-state/batchProgress';
import {
    BatchOutcomeBlocks,
    BatchOutcomeBlockView,
    BatchProgressTrack,
    BatchTallyRow,
} from '@beaver/agent-ui/chat/BatchOutcomeBlocks';
import { BatchItemFilter, BatchItemFindingRow, BatchItemList } from '@beaver/agent-ui/chat/BatchItemRows';
import { setHost } from '@beaver/agent-ui/host';

beforeEach(() => {
    hookState.slots = [];
    hookState.index = 0;
});

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
    const element = node as React.ReactElement<any>;
    if (typeof element.type === 'function') {
        renderedText((element.type as (props: any) => React.ReactNode)(element.props), out);
        return out;
    }
    renderedText(element.props.children ?? null, out);
    return out;
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

const text = (node: React.ReactNode) => renderedText(node).join(' ');

const view = (block: BatchOutcomeBlock, resolved?: number) =>
    text(BatchOutcomeBlockView({ block, resolved }));

describe('one outcome block', () => {
    it.each(['destination', 'removal', 'finding', 'failure', 'no_change'] as const)(
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

    it('draws the breakdown as a legend when asked, one entry per segment', () => {
        // The backend lists the parts in segment order, dropping zeros, so
        // each part pairs with a non-zero segment; the parts stay verbatim.
        const rendered = text(
            BatchProgressTrack({
                batch: entry({
                    detail_label: '14 annotated · 15 no change · 2 failed',
                    total: 31,
                    resolved: 14,
                    no_change: 15,
                    failed: 2,
                }),
                legend: true,
            }),
        );
        expect(rendered).toContain('14 annotated');
        expect(rendered).toContain('15 no change');
        expect(rendered).toContain('2 failed');
        expect(rendered).not.toContain('14 annotated · 15 no change');
    });

    it('falls back to the caption when the parts do not pair with the segments', () => {
        // A record whose wording the client cannot place is labelled, not mislabelled.
        const rendered = text(
            BatchProgressTrack({
                batch: entry({
                    detail_label: '14 annotated · 15 no change',
                    total: 31,
                    resolved: 14,
                    no_change: 15,
                    failed: 2,
                }),
                legend: true,
            }),
        );
        expect(rendered).toContain('14 annotated · 15 no change');
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
    return elements(node).filter((element) => element.type === BatchTallyRow);
}

/** Every item-first finding row the block rendered, in order. */
function findingRows(node: React.ReactNode): React.ReactElement<any>[] {
    return elements(node).filter((element) => element.type === BatchItemFindingRow);
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
        // A reason is free text, never a place in the library: no link, no bar.
        setHost({ navigation: { revealBatchOutcome: () => {} } as any });
        const rendered = BatchOutcomeBlockView({
            block: { heading: 'Could not be read', kind: 'failure', rows: [{ label: 'No text layer', count: 2 }] },
            operation: 'extract',
        });
        const rows = tallyRows(rendered);
        expect(rows).toHaveLength(1);
        expect(rows[0].props.onActivate).toBeUndefined();
        expect(rows[0].props.showMeter).toBe(false);
    });
});

describe('a block with an item record', () => {
    afterEach(() => setHost({}));

    const record = (groups: BatchItemsRecord['groups']): BatchItemsRecord => ({ batch_id: 'b1', groups });
    const finding = (label: string, ids: string[]) => ({ kind: 'finding' as const, label, item_ids: ids });

    it('lists the rows the cap hid behind "Show all" instead of counting them as missing', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ label: `finding ${n}`, count: 2 })),
            overflow: 2,
        };
        const items = record(
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => finding(`finding ${n}`, [`u-A${n}`, `u-B${n}`])),
        );
        const rendered = BatchOutcomeBlockView({ block, items });
        expect(tallyRows(rendered)).toHaveLength(10);
        expect(text(rendered)).toContain('Show all 12');
        expect(text(rendered)).not.toContain('more');
    });

    it('still reports what a surface cap dropped', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [1, 2, 3, 4].map((n) => ({ label: `finding ${n}`, count: 2 })),
        };
        const items = record([1, 2, 3, 4].map((n) => finding(`finding ${n}`, [`u-A${n}`, `u-B${n}`])));
        expect(text(BatchOutcomeBlockView({ block, items, maxRows: 3 }))).toContain('+ 1 more');
    });

    it('opens a row to its items, and only a row the record names', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [{ label: 'known', count: 2 }, { label: 'unrecorded', count: 2 }],
        };
        const rows = tallyRows(BatchOutcomeBlockView({ block, items: record([finding('known', ['u-A', 'u-B'])]) }));
        expect(rows.map((row) => [row.props.name, typeof row.props.onToggle])).toEqual([
            ['known', 'function'],
            ['unrecorded', 'undefined'],
        ]);
    });

    it('draws every finding as a tally once one finding covers several items', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [{ label: 'duplicate of another item', count: 3 }, { label: 'wrong item type', count: 1 }],
        };
        const items = record([
            finding('duplicate of another item', ['u-A', 'u-B', 'u-C']),
            finding('wrong item type', ['u-D']),
        ]);
        const rendered = BatchOutcomeBlockView({ block, items });
        // One row shape: both are tallies, in one list, under one head, and
        // the one-item row folds and measures like the rest.
        const rows = tallyRows(rendered);
        expect(rows.map((row) => row.props.name)).toEqual(['duplicate of another item', 'wrong item type']);
        expect(findingRows(rendered)).toHaveLength(0);
        expect(text(rendered)).not.toContain('One item each');
        for (const row of rows) {
            expect(typeof row.props.onToggle).toBe('function');
            expect(row.props.expanded).toBe(false);
            expect(row.props.showMeter).toBe(true);
        }
    });

    it('draws item-first when every finding is one item', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [{ label: 'a', count: 1 }, { label: 'b', count: 1 }],
        };
        const rendered = BatchOutcomeBlockView({
            block,
            items: record([finding('a', ['u-A']), finding('b', ['u-B'])]),
        });
        expect(tallyRows(rendered)).toHaveLength(0);
        expect(findingRows(rendered).map((row) => row.props.group.label)).toEqual(['a', 'b']);
        expect(text(rendered)).toContain('Findings');
    });

    it('does not change shape while the filter box narrows the rows', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [{ label: 'shared', count: 2 }, { label: 'alone', count: 1 }],
        };
        const items = record([finding('shared', ['u-A', 'u-B']), finding('alone', ['u-C'])]);
        // Only the one-item row survives the filter, yet the block stays
        // finding-first: the shape is the block's, not the visible rows'.
        const rendered = BatchOutcomeBlockView({ block, items, filter: 'alone' });
        expect(tallyRows(rendered).map((row) => row.props.name)).toEqual(['alone']);
        expect(findingRows(rendered)).toHaveLength(0);
    });

    it('counts the findings and the items they fall on in the receipt head', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [{ label: 'a', count: 2 }, { label: 'b', count: 2 }],
            total: 4,
        };
        // Item A carries both findings: four findings on three items.
        const items = record([finding('a', ['u-A', 'u-B']), finding('b', ['u-A', 'u-C'])]);
        expect(text(BatchOutcomeBlockView({ block, items, surface: 'receipt' }))).toContain('4 across 3 items');
        expect(text(BatchOutcomeBlockView({ block, items }))).not.toContain('across');
    });

    it('moves the place a row names into its item list once it can open', () => {
        // Two click targets on one row would be indistinguishable: with items
        // behind it the row toggles, and the collection is a named action.
        const seen: unknown[] = [];
        setHost({ navigation: { revealBatchOutcome: (t: unknown) => seen.push(t) } as any });
        const block: BatchOutcomeBlock = {
            heading: 'Where items went',
            kind: 'destination',
            rows: [{ label: 'Ecology', count: 2, reference: 'CHT8AIF6' }],
        };
        const items = record([
            { kind: 'destination', label: 'Ecology', reference: 'CHT8AIF6', item_ids: ['u-A', 'u-B'] },
        ]);
        const rendered = BatchOutcomeBlockView({ block, items, operation: 'sort' });
        const row = tallyRows(rendered)[0];
        expect(row.props.onActivate).toBeUndefined();
        expect(typeof row.props.onToggle).toBe('function');
        row.props.onToggle();
        // Every walk re-runs the components, so each starts from slot 0 to
        // read the same state back.
        hookState.index = 0;
        const opened = BatchOutcomeBlockView({ block, items, operation: 'sort' });
        expect(text(opened)).toContain('Open collection');
        hookState.index = 0;
        const action = elements(opened).find((e) => e.props.children === 'Open collection');
        action?.props.onClick({ stopPropagation() {} });
        expect(seen).toEqual([{ kind: 'collection', key: 'CHT8AIF6', name: 'Ecology', libraryRef: undefined }]);
    });

    it('draws no bar when no row counts two', () => {
        // A bar of "1 of 1" says nothing.
        const block: BatchOutcomeBlock = {
            heading: 'Tags applied',
            kind: 'destination',
            rows: [{ label: 'a', count: 1 }, { label: 'b', count: 1 }],
        };
        expect(tallyRows(BatchOutcomeBlockView({ block })).every((row) => row.props.showMeter === false)).toBe(true);
    });

    it('joins a sort row to its group by collection key, not by name', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Where items went',
            kind: 'destination',
            rows: [
                { label: 'Ecology', count: 2, reference: 'AAAA0001' },
                { label: 'Ecology', count: 1, reference: 'AAAA0002' },
            ],
        };
        const items = record([
            { kind: 'destination', label: 'Ecology', reference: 'AAAA0001', item_ids: ['u-A', 'u-B'] },
        ]);
        const rows = tallyRows(BatchOutcomeBlockView({ block, items }));
        expect(rows.map((row) => typeof row.props.onToggle)).toEqual(['function', 'undefined']);
    });

    it('draws exactly as before without a record', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [{ label: 'a', count: 3 }, { label: 'b', count: 1 }],
            overflow: 4,
        };
        const rendered = BatchOutcomeBlockView({ block });
        expect(tallyRows(rendered).map((row) => [row.props.name, row.props.onToggle])).toEqual([
            ['a', undefined],
            ['b', undefined],
        ]);
        expect(findingRows(rendered)).toHaveLength(0);
        expect(text(rendered)).toContain('+ 4 more');
    });

    it('puts a filter box above a batch whose record runs to many rows', () => {
        const rows = Array.from({ length: 30 }, (_, n) => ({ label: `finding ${n}`, count: 1 }));
        const batch = entry({ blocks: [{ heading: 'Findings', kind: 'finding', rows: rows.slice(0, 10), overflow: 20 }] });
        const items = record(rows.map((row, n) => finding(row.label, [`u-A${n}`])));
        expect(elements(BatchOutcomeBlocks({ batch, items })).some((e) => e.type === BatchItemFilter)).toBe(true);
        expect(elements(BatchOutcomeBlocks({ batch })).some((e) => e.type === BatchItemFilter)).toBe(false);
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


it('shows why no action was needed', () => {
    const rendered = view({
        heading: 'No action needed', kind: 'no_change',
        rows: [{ label: 'Outside the requested date range', count: 2 }],
    });
    expect(rendered).toContain('Outside the requested date range');
    expect(rendered).toContain('2');
});

describe('rows drawn from the population record', () => {
    afterEach(() => setHost({}));

    const finding = (label: string, ids: string[]) => ({ kind: 'finding' as const, label, item_ids: ids });
    const population: BatchPopulationLookup = new Map([
        ['u-A', { id: 'u-A', n: 'Smith 2004', s: 'A study of things', t: 'journalArticle' }],
        ['u-B', { id: 'u-B', n: 'Jones 2010', s: 'Another study', t: 'book' }],
    ]);

    it('names an item from the record without asking the host', () => {
        const resolveItemDisplay = vi.fn(async () => null);
        setHost({ itemData: { resolveItemDisplay } as any });

        const rendered = text(BatchItemFindingRow({ group: finding('wrong type', ['u-A']), population }));

        expect(rendered).toContain('Smith 2004');
        expect(rendered).toContain('A study of things');
        expect(rendered).toContain('wrong type');
        expect(resolveItemDisplay).not.toHaveBeenCalled();
    });

    it('joins the record to a group whichever grammar spelled the id', () => {
        // The group came from a later close-out that spelled the id numerically.
        const rendered = text(BatchItemList({ group: finding('x', ['1-A', 'u-B']), population }));
        expect(rendered).toContain('Smith 2004');
        expect(rendered).toContain('Jones 2010');
    });

    it('draws an item the record lacks as it did before the record existed', () => {
        const rendered = text(BatchItemList({ group: finding('x', ['u-C']), population }));
        // No host to ask under the stand-in, so the row waits for one.
        expect(rendered).toContain('…');
        expect(rendered).not.toContain('Smith');
    });

    it('lets the filter box find rows by the names of the items under them', () => {
        const block: BatchOutcomeBlock = {
            heading: 'Findings',
            kind: 'finding',
            rows: [{ label: 'missing DOI', count: 1 }, { label: 'no abstract', count: 1 }],
        };
        const items: BatchItemsRecord = {
            batch_id: 'b1',
            groups: [finding('missing DOI', ['u-A']), finding('no abstract', ['u-B'])],
        };

        const bySmith = text(BatchOutcomeBlockView({ block, items, population, filter: 'smith' }));
        expect(bySmith).toContain('missing DOI');
        expect(bySmith).not.toContain('no abstract');

        const byTitle = text(BatchOutcomeBlockView({ block, items, population, filter: 'another study' }));
        expect(byTitle).toContain('no abstract');
        expect(byTitle).not.toContain('missing DOI');

        // Without the record, a name matches nothing: only labels and ids do.
        expect(BatchOutcomeBlockView({ block, items, filter: 'smith' })).toBeNull();
    });
});
