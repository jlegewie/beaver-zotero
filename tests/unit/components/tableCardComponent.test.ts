// @vitest-environment jsdom

/**
 * The table card: a single Create while the request has no cost, the
 * destination line, the live count of a collection added on the card, the
 * over-cap warning disabling Create, and the reply it sends.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import type { WSTableCardRequest, WSTableCardResponse } from '@beaver/agent-core/protocol/tableCardProtocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    resolveLibraryScope: vi.fn(),
    resolveItems: vi.fn(),
    describeItems: vi.fn(async (ids: string[]) => ids.map((id) => ({ item_id: id, display_name: `Paper ${id}`, has_pdf: true }))),
    target: null as any,
}));

vi.mock('../../../react/components/tables/card/liveSources', () => ({
    resolveLibraryScope: mocks.resolveLibraryScope,
    resolveItems: mocks.resolveItems,
    describeItems: mocks.describeItems,
}));

vi.mock('../../../react/components/ui/menus/AddSourcesMenu', () => ({
    default: React.forwardRef((props: any, _ref) => {
        mocks.target = props.target;
        return React.createElement('button', { type: 'button' }, props.triggerLabel);
    }),
}));

vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { searchableLibraryIdsAtom: atom([1, 5]) };
});

vi.mock('../../../react/utils/selectItem', () => ({
    selectCollection: vi.fn(),
    selectTagFilter: vi.fn(),
    selectView: vi.fn(),
}));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveLibraryRef: (ref: { library_ref?: string }) => (ref.library_ref === 'u' ? 1 : ref.library_ref === 'g5' ? 5 : null),
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : id === 5 ? 'g5' : null),
}));

import { TableCard } from '../../../react/components/tables/card/TableCard';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';

const FIXTURES = join(__dirname, '../../fixtures/artifacts/table-cards');
const fixture = (name: string): WSTableCardRequest =>
    JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')).request;

let root: Root | null = null;
let container: HTMLDivElement;
let sent: WSTableCardResponse[];

function render(request: WSTableCardRequest, store = createStore()) {
    sent = [];
    act(() => {
        root = createRoot(container);
        root.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(TableCard, { request, onSubmit: (r: WSTableCardResponse) => sent.push(r) }),
            ),
        );
    });
}

function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as
        | HTMLButtonElement
        | undefined;
}

async function click(label: string) {
    const target = button(label);
    if (!target) throw new Error(`No button ${label}: ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`);
    await act(async () => {
        target.click();
    });
}

beforeEach(() => {
    // Selected items resolve to themselves unless a test says otherwise.
    mocks.resolveItems.mockImplementation(async (ids: string[]) => {
        const rows = await mocks.describeItems(ids);
        return { resolved: { count: rows.length, total: ids.length, truncated: false, without_pdf: 0, sample: [] }, rows };
    });
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    const zotero = (globalThis as any).Zotero;
    zotero.Collections = {
        get: (id: number) => (id === 41 ? { id: 41, key: 'CASHTRN2', libraryID: 1, name: 'Cash transfers' } : false),
        getByLibraryAndKey: (_l: number, key: string) => (key === 'CASHTRN2' ? { id: 41, key, libraryID: 1, name: 'Cash transfers', hasChildCollections: () => true } : false),
    };
    zotero.Tags = { getID: () => false };
    zotero.Libraries = { get: () => ({ name: 'My Library', editable: true, filesEditable: true }) };
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
});

describe('TableCard', () => {
    it('shows the destination line and a single Create on the last step', async () => {
        render(fixture('create-collection-destination'));
        expect(container.textContent).toContain('Saved to My Library › Cash transfers');
        expect(container.textContent).toContain('Collection, incl. subcollections · My Library');
        expect(button('Next')).toBeTruthy();
        // Screening arrives with P4; until then the card offers no step for it.
        expect(button('Add screening')).toBeUndefined();
        await click('Next');
        expect(button('Create')).toBeTruthy();
        expect(button('Create only')).toBeUndefined();
        expect(button('Back')).toBeTruthy();
        expect(container.textContent).toContain('Sources: 2 papers from 1 source');
        await click('Create');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            approved: true,
            choice: 'create',
            sources: [{ type: 'library', scope: { kind: 'collection', library_ref: 'u', key: 'CASHTRN2' } }],
        });
    });

    it('counts a collection added through "+ Source" before Create can be pressed', async () => {
        let finish: (value: unknown) => void = () => {};
        mocks.resolveLibraryScope.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
        render(fixture('create-items'));
        await act(async () => {
            mocks.target.pickCollection(41);
        });
        expect(mocks.resolveLibraryScope).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'collection', library_ref: 'u', key: 'CASHTRN2' }),
        );
        await click('Next');
        expect(button('Create')!.disabled).toBe(true);
        expect(container.textContent).toContain('Counting papers…');
        await act(async () => {
            finish({
                resolved: { count: 14, total: 14, truncated: false, without_pdf: 3, sample: [] },
                rows: Array.from({ length: 14 }, (_, i) => ({ item_id: `u-COLL${String(i).padStart(4, '0')}`, display_name: `C${i}` })),
                name: 'Cash transfers',
            });
        });
        expect(button('Create')!.disabled).toBe(false);
        expect(container.textContent).toContain('Sources: 16 papers from 2 sources');
        await click('Create');
        expect(sent[0].sources).toHaveLength(2);
    });

    it('counts merged papers from the same items the source counts, without one trashed since the proposal', async () => {
        // PAPER002 went to the trash while the card was open.
        mocks.resolveItems.mockImplementation(async (ids: string[]) => {
            const rows = (await mocks.describeItems(ids)).filter((row) => row.item_id !== 'u-PAPER002');
            return { resolved: { count: rows.length, total: ids.length, truncated: false, without_pdf: 0, sample: [] }, rows };
        });
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 3, total: 3, truncated: false, without_pdf: 0, sample: [] },
            rows: ['u-COLL0001', 'u-COLL0002', 'u-COLL0003'].map((id) => ({ item_id: id, display_name: id })),
            name: 'Cash transfers',
        });
        render(fixture('create-items'));
        await act(async () => { mocks.target.pickCollection(41); });
        await click('Next');
        expect(mocks.resolveItems).toHaveBeenCalledWith(['u-PAPER001', 'u-PAPER002']);
        expect(container.textContent).toContain('Sources: 4 papers from 2 sources');
    });

    it('warns on the over-cap card and keeps Create disabled', async () => {
        render(fixture('create-over-cap'));
        expect(container.textContent).toContain('1,840 papers; a table holds 1,000. Narrow the collection or add a tag filter.');
        await click('Next');
        expect(button('Create')!.disabled).toBe(true);
        expect(container.textContent).toContain('1,840 papers; a table holds 1,000.');
    });

    it('declines with Cancel and sends typed instructions with it', async () => {
        render(fixture('create-items'));
        await click('Next');
        await click('Add instructions');
        const field = container.querySelector('textarea[aria-label="Instructions for this table (optional)"]') as HTMLTextAreaElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(field, 'Use a note instead');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click('Send instructions');
        expect(sent).toEqual([
            { type: 'table_card_response', card_id: fixture('create-items').card_id, approved: false, user_instructions: 'Use a note instead' },
        ]);
        await click('Send instructions').catch(() => {});
        expect(sent).toHaveLength(1);
    });

    it('keeps a comma inside a choice option, one option per line', async () => {
        render(fixture('create-items'));
        await click('Next');
        const field = container.querySelector('textarea[aria-label="Column 2 options"]') as HTMLTextAreaElement;
        expect(field.value).toBe('RCT\nObservational\nOther');
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(field, 'RCT\nBefore, after\n\nOther');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click('Create');
        expect(sent[0].columns![1].options).toEqual(['RCT', 'Before, after', 'Other']);
    });

    it('adds a tag beside an existing collection instead of replacing it', async () => {
        mocks.resolveLibraryScope.mockImplementation(async (scope: any) =>
            scope.kind === 'tag'
                ? {
                    resolved: { count: 3, total: 3, truncated: false, without_pdf: 0, sample: [] },
                    rows: [{ item_id: 'u-TAG00001', display_name: 'T1' }, { item_id: 'u-TAG00002', display_name: 'T2' }, { item_id: 'u-TAG00003', display_name: 'T3' }],
                }
                : {
                    resolved: { count: 2, total: 2, truncated: false, without_pdf: 0, sample: [] },
                    rows: [{ item_id: 'u-COLL0001', display_name: 'C1' }, { item_id: 'u-COLL0002', display_name: 'C2' }],
                },
        );
        render(fixture('create-collection-destination'));
        await act(async () => {
            mocks.target.pickTag({ id: 9, tag: 'review', libraryId: 1, type: 0, color: '' });
        });
        await click('Next');
        expect(container.textContent).toContain('Sources: 5 papers from 2 sources');
        await click('Create');
        expect(sent[0].sources).toEqual([
            { type: 'library', scope: { kind: 'collection', library_ref: 'u', key: 'CASHTRN2', name: 'Cash transfers' } },
            { type: 'library', scope: { kind: 'tag', library_ref: 'u', tag: 'review' } },
        ]);
    });

    it.each([
        [true, 'Saved to Lab group'],
        [false, 'Saved to My Library'],
    ])('derives an edited group destination only when the group allows file edits (%s)', async (filesEditable, line) => {
        const zotero = (globalThis as any).Zotero;
        zotero.Libraries = {
            get: (id: number) => (id === 5
                ? { name: 'Lab group', editable: true, filesEditable }
                : { name: 'My Library', editable: true, filesEditable: true }),
        };
        zotero.Collections = {
            get: (id: number) => (id === 42 ? { id: 42, key: 'LABCOLL1', libraryID: 5, name: 'Lab papers' } : false),
            getByLibraryAndKey: () => false,
        };
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 1, total: 1, truncated: false, without_pdf: 0, sample: [] },
            rows: [{ item_id: 'g5-LABPAPR1', display_name: 'L1' }],
            name: 'Lab papers',
        });
        const request = fixture('create-items');
        request.destination = { library_ref: 'g5', library_name: 'Lab group', collection_key: null, collection_name: null, explicit: false };
        request.sources[0].ids = ['g5-PAPER001', 'g5-PAPER002'];
        render(request);
        await act(async () => {
            mocks.target.pickCollection(42);
        });
        expect(container.textContent).toContain(line);
    });

    it('offers papers in "+ Source", and attachments by their paper, but not notes or standalone files', async () => {
        const paper = { id: 5, key: 'PAPER005', libraryID: 1, isRegularItem: () => true, isAttachment: () => false };
        const pdf = { id: 6, key: 'ATTACH06', libraryID: 1, parentItemID: 5, isRegularItem: () => false, isAttachment: () => true };
        const loose = { id: 7, key: 'ATTACH07', libraryID: 1, parentItemID: null, isRegularItem: () => false, isAttachment: () => true };
        const note = { id: 8, key: 'NOTE0008', libraryID: 1, isRegularItem: () => false, isAttachment: () => false };
        const excluded = { id: 9, key: 'PAPER009', libraryID: 2, isRegularItem: () => true, isAttachment: () => false };
        (globalThis as any).Zotero.Items = { get: (id: number) => (id === 5 ? paper : false) };
        render(fixture('create-collection-destination'));
        const { canAdd } = mocks.target;
        expect([paper, pdf, loose, note, excluded].map((item) => canAdd(item))).toEqual([true, true, false, false, false]);
    });

    it('does not offer a paper in the trash, picked directly or through its attachment', async () => {
        const trashed = { id: 5, key: 'PAPER005', libraryID: 1, deleted: true, isRegularItem: () => true, isAttachment: () => false };
        const pdf = { id: 6, key: 'ATTACH06', libraryID: 1, parentItemID: 5, isRegularItem: () => false, isAttachment: () => true };
        (globalThis as any).Zotero.Items = { get: (id: number) => (id === 5 ? trashed : false) };
        render(fixture('create-collection-destination'));
        expect([trashed, pdf].map((item) => mocks.target.canAdd(item))).toEqual([false, false]);
    });

    it('blocks Create when an edited card has no library to file the table in', async () => {
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 1, total: 1, truncated: false, without_pdf: 0, sample: [] },
            rows: [{ item_id: 'g5-LABPAPR1', display_name: 'L1' }],
        });
        (globalThis as any).Zotero.Collections = {
            get: (id: number) => (id === 42 ? { id: 42, key: 'LABCOLL1', libraryID: 5, name: 'Lab papers' } : false),
            getByLibraryAndKey: () => false,
        };
        // My Library is excluded; the sources span it and a group, so the
        // backend would fall back to My Library and refuse.
        const store = createStore();
        store.set(searchableLibraryIdsAtom, [5]);
        render(fixture('create-items'), store);
        await act(async () => { mocks.target.pickCollection(42); });
        expect(container.textContent).toContain('No library to save the table in');
        await click('Next');
        expect(button('Create')!.disabled).toBe(true);
        expect(container.textContent).toContain('My Library cannot hold the table');
    });

    it('looks up the items of a card that opens on its own warning', async () => {
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 1000, total: 1840, truncated: true, without_pdf: 0, sample: [] },
            rows: [{ item_id: 'u-PAPER001', display_name: 'Paper one', has_pdf: false }],
        });
        render(fixture('create-over-cap'));
        await act(async () => {});
        expect(mocks.resolveLibraryScope).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('Paper one');
        expect(container.textContent).toContain('No PDF');
    });

    it('keeps edits when the card is unmounted and mounted again in the same window', async () => {
        const store = createStore();
        render(fixture('create-items'), store);
        const title = container.querySelector('input[aria-label="Table title"]') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(title, 'Edited title');
            title.dispatchEvent(new Event('input', { bubbles: true }));
        });
        act(() => root?.unmount());
        render(fixture('create-items'), store);
        expect((container.querySelector('input[aria-label="Table title"]') as HTMLInputElement).value).toBe('Edited title');
    });

    it('drops a count that lands after its card unmounted and the source changed', async () => {
        const store = createStore();
        const finishers: Array<(value: unknown) => void> = [];
        mocks.resolveLibraryScope.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
        render(fixture('create-items'), store);
        await act(async () => { mocks.target.pickCollection(41); });
        expect(finishers).toHaveLength(1);
        act(() => root?.unmount());
        render(fixture('create-items'), store);
        expect(finishers).toHaveLength(2);
        // The user removes the collection on the remounted card ...
        await act(async () => { mocks.target.pickCollection(41); });
        // ... and the first card's lookup lands afterwards.
        await act(async () => {
            finishers[0]({ resolved: { count: 99, total: 99, truncated: false, without_pdf: 0, sample: [] }, rows: [] });
        });
        await click('Next');
        expect(container.textContent).toContain('Sources: 2 papers from 1 source');
    });
});

