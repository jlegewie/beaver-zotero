// @vitest-environment jsdom

/**
 * The table card: a single Create while the request has no cost, the
 * destination line, the live count of a collection added on the card, the
 * over-cap warning disabling Create, and the reply it sends; with a cost,
 * "Create and fill" beside "Create only", the row line, the credit chip and
 * the live estimate that holds the run button back after an edit.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import type {
    WSTableCardResponse,
    WSTableCreateCardRequest,
    WSTableFillCardRequest,
} from '@beaver/agent-core/protocol/tableCardProtocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    resolveLibraryScope: vi.fn(),
    resolveItems: vi.fn(),
    describeItems: vi.fn(async (ids: string[]) => ids.map((id) => ({ item_id: id, display_name: `Paper ${id}`, has_pdf: true }))),
    target: null as any,
    estimates: [] as unknown[],
}));

// The estimate goes over the run's socket; here it is recorded and the test
// answers it by writing the draft as the socket handler does.
vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return {
        requestTableCardEstimateAtom: atom(null, (_get, _set, card: unknown) => {
            mocks.estimates.push(card);
            return null;
        }),
    };
});

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
    resolveObjectId: (id: string) => {
        const [ref, key] = id.split('-');
        return { library_ref: ref, library_id: ref === 'u' ? 1 : 0, zotero_key: key };
    },
}));

import { setHost } from '@beaver/agent-ui/host';
import { tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import { applyEstimateResult, startEstimate } from '@beaver/agent-core/run-state/tableCardDraft';
import { TableCard } from '../../../react/components/tables/card/TableCard';
import { TableFillCard } from '../../../react/components/tables/card/TableFillCard';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';

const FIXTURES = join(__dirname, '../../fixtures/artifacts/table-cards');
const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
/** A create card as the backend sent it before the filler: no cost, a single Create. */
const fixture = (name: string): WSTableCreateCardRequest => ({ ...read(name).request, cost: null });
/** A create card with its cost, as the backend sends it now. */
const costedFixture = (name: string): WSTableCreateCardRequest => read(name).request;

let root: Root | null = null;
let container: HTMLDivElement;
let sent: WSTableCardResponse[];

function render(request: WSTableCreateCardRequest, store = createStore()) {
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

/** The one-line summary a completed step folds into. */
function doneStep(step: string): string | undefined {
    const line = container.querySelector(`button[aria-label^="${step}: "]`);
    return line?.getAttribute('aria-label')?.slice(step.length + 2).replace(/\. Edit$/, '');
}

async function clickElement(target: Element | null) {
    if (!target) throw new Error('No element to click');
    await act(async () => {
        (target as HTMLElement).click();
    });
}

async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function press(field: Element, key: string) {
    await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
}

/** A drag event carrying Zotero drag data, as Zotero's trees set it. */
function dragEvent(type: string, data: Record<string, string>): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: { types: Object.keys(data), getData: (t: string) => data[t] ?? '', dropEffect: 'none' },
    });
    return event;
}

function instructionsField(): HTMLTextAreaElement {
    return container.querySelector('textarea[aria-label="What Beaver should do instead (optional)"]') as HTMLTextAreaElement;
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
        expect(container.textContent).toContain('My Library › Cash transfers');
        expect(container.textContent).toContain('Collection, incl. subcollections · My Library');
        expect(button('Next')).toBeTruthy();
        // Screening arrives with P4; until then the card offers no step for it.
        expect(button('Add screening')).toBeUndefined();
        await click('Next');
        expect(button('Create')).toBeTruthy();
        expect(button('Create only')).toBeUndefined();
        expect(button('Back')).toBeTruthy();
        expect(doneStep('Sources')).toBe('2 items from 1 source');
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
        expect(container.textContent).toContain('Counting items…');
        // Waiting on a count is a quiet status, not a warning.
        expect(container.querySelector('.table-card-footer [role="status"]')?.textContent).toContain('Counting items…');
        expect(container.querySelector('.table-card-footer [role="alert"]')).toBeNull();
        await act(async () => {
            finish({
                resolved: { count: 14, total: 14, truncated: false, without_pdf: 3, sample: [] },
                rows: Array.from({ length: 14 }, (_, i) => ({ item_id: `u-COLL${String(i).padStart(4, '0')}`, display_name: `C${i}` })),
                name: 'Cash transfers',
            });
        });
        expect(button('Create')!.disabled).toBe(false);
        expect(doneStep('Sources')).toBe('16 items from 2 sources');
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
        expect(doneStep('Sources')).toBe('4 items from 2 sources');
    });

    it('warns on the over-cap card and keeps Create disabled', async () => {
        render(fixture('create-over-cap'));
        expect(container.textContent).toContain('This table would have 1,840 items; the maximum is 1,000. Remove sources to continue.');
        await click('Next');
        expect(button('Create')!.disabled).toBe(true);
        expect(button('Create')!.title).toBe('This table would have 1,840 items; the maximum is 1,000. Remove sources to continue.');
    });

    it('declines from the cancel view and sends typed instructions with it', async () => {
        render(fixture('create-items'));
        await click('Cancel');
        expect(button('Next')).toBeUndefined();
        expect(button('Cancel table')).toBeDefined();
        await typeInto(instructionsField(), 'Use a note instead');
        await click('Send');
        expect(sent).toEqual([
            { type: 'table_card_response', card_id: fixture('create-items').card_id, approved: false, user_instructions: 'Use a note instead' },
        ]);
        await click('Send').catch(() => {});
        expect(sent).toHaveLength(1);
    });

    it('cancels without instructions when nothing was typed', async () => {
        render(fixture('create-items'));
        await click('Cancel');
        await click('Cancel table');
        expect(sent).toEqual([
            { type: 'table_card_response', card_id: fixture('create-items').card_id, approved: false, user_instructions: null },
        ]);
    });

    it('goes back to the table with the text kept, and Create never sends it', async () => {
        render(fixture('create-items'));
        await click('Cancel');
        await typeInto(instructionsField(), 'Use a note instead');
        await click('Back to table');
        expect(button('Send')).toBeUndefined();
        await click('Cancel');
        expect(instructionsField().value).toBe('Use a note instead');
        await click('Back to table');
        await click('Next');
        await click('Create');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ approved: true, choice: 'create' });
        expect(sent[0]).not.toHaveProperty('user_instructions');
    });

    it('goes back to the table on Escape', async () => {
        render(fixture('create-items'));
        await click('Cancel');
        await press(instructionsField(), 'Escape');
        expect(button('Next')).toBeDefined();
        expect(sent).toEqual([]);
    });

    it('stays in the cancel view when Escape dismisses an IME candidate', async () => {
        render(fixture('create-items'));
        await click('Cancel');
        const field = instructionsField();
        await typeInto(field, '日本語');
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
        await act(async () => {
            field.dispatchEvent(escape);
        });
        expect(escape.defaultPrevented).toBe(false);
        expect(instructionsField()).toBe(field);
        expect(field.value).toBe('日本語');
        expect(button('Next')).toBeUndefined();
    });

    describe('category options as rows', () => {
        const option = (n: number) =>
            container.querySelector(`input[aria-label="Column 2 option ${n}"]`) as HTMLInputElement;
        const labels = () =>
            [...container.querySelectorAll('input[aria-label^="Column 2 option "]')].map(
                (input) => (input as HTMLInputElement).value,
            );
        const openDesign = async (name = 'create-items') => {
            render(fixture(name));
            await click('Next');
            await clickElement(container.querySelectorAll('.table-card-column')[1]);
        };
        async function paste(field: HTMLInputElement, text: string) {
            await act(async () => {
                const event = new Event('paste', { bubbles: true, cancelable: true });
                Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
                field.dispatchEvent(event);
            });
        }

        it('adds a row below on Enter and removes an empty row on Backspace', async () => {
            await openDesign();
            expect(labels()).toEqual(['RCT', 'Observational', 'Other']);
            await press(option(1), 'Enter');
            expect(labels()).toEqual(['RCT', '', 'Observational', 'Other']);
            expect(container.ownerDocument.activeElement).toBe(option(2));
            await typeInto(option(2), 'Before, after');
            await press(option(2), 'Enter');
            await press(option(3), 'Backspace');
            expect(labels()).toEqual(['RCT', 'Before, after', 'Observational', 'Other']);
            expect(container.ownerDocument.activeElement).toBe(option(2));
            // A label with text is edited by Backspace, not removed.
            await press(option(2), 'Backspace');
            expect(labels()).toHaveLength(4);
            await click('Create');
            expect(sent[0].columns![1].options).toEqual([
                { label: 'RCT' }, { label: 'Before, after' }, { label: 'Observational' }, { label: 'Other' },
            ]);
        });

        it('splits a multi-line paste into rows', async () => {
            await openDesign();
            const field = option(3);
            field.setSelectionRange(0, field.value.length);
            await paste(field, 'Cohort\n\nCase study\nCross-sectional');
            expect(labels()).toEqual(['RCT', 'Observational', 'Cohort', 'Case study', 'Cross-sectional']);
            expect(container.ownerDocument.activeElement).toBe(option(5));
        });

        it('leaves Enter and Backspace to an IME that is composing', async () => {
            await openDesign();
            await press(option(1), 'Enter');
            const composing = (key: string) =>
                new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
            let enter!: KeyboardEvent;
            await act(async () => {
                enter = composing('Enter');
                option(1).dispatchEvent(enter);
            });
            expect(enter.defaultPrevented).toBe(false);
            expect(labels()).toEqual(['RCT', '', 'Observational', 'Other']);
            let backspace!: KeyboardEvent;
            await act(async () => {
                backspace = composing('Backspace');
                option(2).dispatchEvent(backspace);
            });
            expect(backspace.defaultPrevented).toBe(false);
            expect(labels()).toEqual(['RCT', '', 'Observational', 'Other']);
        });

        it('adds a definition behind Define and sends it with the option', async () => {
            await openDesign();
            expect(container.querySelector('textarea[aria-label="Definition of RCT"]')).toBeNull();
            await clickElement(container.querySelector('button[aria-label="Add a definition for RCT"]'));
            const definition = container.querySelector('textarea[aria-label="Definition of RCT"]') as HTMLTextAreaElement;
            expect(container.ownerDocument.activeElement).toBe(definition);
            await typeInto(definition, ' Random assignment to arms. ');
            await click('Done');
            const chip = [...container.querySelectorAll('.table-card-option')].find((c) => c.textContent === 'RCT')!;
            expect(chip.getAttribute('title')).toBe('RCT: Random assignment to arms.');
            await click('Create');
            expect(sent[0].columns![1].options![0]).toEqual({ label: 'RCT', description: 'Random assignment to arms.' });
        });

        it('opens no definition field on a new row that reuses a removed row\'s key', async () => {
            await openDesign();
            await click('Add option');
            await typeInto(option(4), 'Cohort');
            await clickElement(container.querySelector('button[aria-label="Add a definition for Cohort"]'));
            await typeInto(container.querySelector('textarea[aria-label="Definition of Cohort"]') as HTMLTextAreaElement, 'Followed.');
            await clickElement(container.querySelector('button[aria-label="Remove Cohort"]'));
            await click('Add option');
            expect(labels()).toEqual(['RCT', 'Observational', 'Other', '']);
            expect(container.querySelector('textarea[aria-label="Definition of option 4"]')).toBeNull();
            expect(container.querySelector('button[aria-label="Add a definition for option 4"]')).not.toBeNull();
        });

        it('shows proposed definitions and lets the user clear one', async () => {
            await openDesign('create-items-with-definitions');
            const rct = container.querySelector('textarea[aria-label="Definition of RCT"]') as HTMLTextAreaElement;
            expect(rct.value).toBe('Units are randomly assigned to arms by the researchers or a lottery.');
            expect(container.querySelector('button[aria-label="Add a definition for Other"]')).not.toBeNull();
            await act(async () => rct.focus());
            await typeInto(rct, '');
            // Cleared to be retyped: the focused field stays.
            expect(container.querySelector('textarea[aria-label="Definition of RCT"]')).toBe(rct);
            expect(container.ownerDocument.activeElement).toBe(rct);
            // Nor does a blur collapse it: the blur comes at mousedown, before the click lands.
            await act(async () => rct.blur());
            expect(container.querySelector('textarea[aria-label="Definition of RCT"]')).toBe(rct);
            await click('Add option');
            expect(labels()).toEqual(['RCT', 'Observational', 'Other', '']);
            // Closing the editor forgets the empty field.
            await click('Done');
            await clickElement(container.querySelectorAll('.table-card-column')[1]);
            expect(container.querySelector('textarea[aria-label="Definition of RCT"]')).toBeNull();
            await click('Create');
            expect(sent[0].columns![1].options).toEqual([
                { label: 'RCT' },
                { label: 'Observational', description: 'Exposure is not assigned; the study observes who has it.' },
                { label: 'Other' },
            ]);
        });
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
        expect(doneStep('Sources')).toBe('5 items from 2 sources');
        await click('Create');
        expect(sent[0].sources).toEqual([
            { type: 'library', scope: { kind: 'collection', library_ref: 'u', key: 'CASHTRN2', name: 'Cash transfers' } },
            { type: 'library', scope: { kind: 'tag', library_ref: 'u', tag: 'review' } },
        ]);
    });

    it.each([
        [true, 'Lab group'],
        [false, 'My Library'],
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
        const paper = { id: 5, key: 'PAPER005', libraryID: 1, isRegularItem: () => true, isAttachment: () => false, isNote: () => false, isAnnotation: () => false };
        const pdf = { id: 6, key: 'ATTACH06', libraryID: 1, parentItemID: 5, isRegularItem: () => false, isAttachment: () => true, isNote: () => false, isAnnotation: () => false };
        const loose = { id: 7, key: 'ATTACH07', libraryID: 1, parentItemID: null, isRegularItem: () => false, isAttachment: () => true, isNote: () => false, isAnnotation: () => false };
        const note = { id: 8, key: 'NOTE0008', libraryID: 1, isRegularItem: () => false, isAttachment: () => false, isNote: () => true, isAnnotation: () => false };
        const excluded = { id: 9, key: 'PAPER009', libraryID: 2, isRegularItem: () => true, isAttachment: () => false, isNote: () => false, isAnnotation: () => false };
        (globalThis as any).Zotero.Items = { get: (id: number) => (id === 5 ? paper : false) };
        render(fixture('create-collection-destination'));
        const { canAdd, asSourceItem } = mocks.target;
        expect([paper, pdf, loose, note, excluded].map((item) => canAdd(item))).toEqual([true, true, false, false, false]);
        // The menu lists a child attachment as the paper a pick adds.
        expect(asSourceItem(pdf)).toBe(paper);
        expect(asSourceItem(note)).toBeNull();
    });

    it('does not offer a paper in the trash, picked directly or through its attachment', async () => {
        const trashed = { id: 5, key: 'PAPER005', libraryID: 1, deleted: true, isRegularItem: () => true, isAttachment: () => false, isNote: () => false, isAnnotation: () => false };
        const pdf = { id: 6, key: 'ATTACH06', libraryID: 1, parentItemID: 5, isRegularItem: () => false, isAttachment: () => true, isNote: () => false, isAnnotation: () => false };
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

    it('warns about the row cap under the Sources heading and leaves the source collapsed', async () => {
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 1000, total: 1840, truncated: true, without_pdf: 0, sample: [] },
            rows: [{ item_id: 'u-PAPER001', display_name: 'Paper one', has_pdf: false }],
        });
        render(fixture('create-over-cap'));
        await act(async () => {});
        const alert = container.querySelector('.table-card-step [role="alert"]');
        expect(alert?.textContent).toBe('This table would have 1,840 items; the maximum is 1,000. Remove sources to continue.');
        // The source is not opened for the warning; its count is marked instead.
        const toggle = container.querySelector('.table-card-source-toggle') as HTMLButtonElement;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[aria-label="Items, more than a table holds"]')).not.toBeNull();
        expect(mocks.resolveLibraryScope).not.toHaveBeenCalled();
        // Expanding it looks its items up, and it collapses again.
        await clickElement(toggle);
        expect(mocks.resolveLibraryScope).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('Paper one');
        expect(container.textContent).toContain('No PDF');
        await clickElement(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('pages a long source instead of scrolling it', async () => {
        const rows = Array.from({ length: 60 }, (_, i) => ({ item_id: `u-P${String(i).padStart(7, '0')}`, display_name: `Paper ${i}` }));
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 60, total: 60, truncated: false, without_pdf: 0, sample: [] },
            rows,
        });
        render(fixture('create-collection-destination'));
        await clickElement(container.querySelector('.table-card-source-toggle'));
        expect(container.querySelectorAll('.table-card-item')).toHaveLength(25);
        await click('Show 25 more of 35 not shown');
        expect(container.querySelectorAll('.table-card-item')).toHaveLength(50);
        await click('Show 10 more of 10 not shown');
        expect(container.querySelectorAll('.table-card-item')).toHaveLength(60);
        expect(container.textContent).not.toContain('not shown');
    });

    it('keeps edits when the card is unmounted and mounted again in the same window', async () => {
        const store = createStore();
        render(fixture('create-items'), store);
        expect(container.querySelector('input[aria-label="Table title"]')).toBeNull();
        await clickElement(container.querySelector('button[aria-label="Edit title"]'));
        const title = container.querySelector('input[aria-label="Table title"]') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(title, 'Edited title');
            title.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await press(title, 'Enter');
        act(() => root?.unmount());
        render(fixture('create-items'), store);
        expect(container.textContent).toContain('Edited title');
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
        expect(doneStep('Sources')).toBe('2 items from 1 source');
    });

    it('reveals a paper in Zotero when its row in an expanded source is clicked', async () => {
        const revealInLibrary = vi.fn();
        setHost({ navigation: { revealInLibrary } as any });
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 2, total: 2, truncated: false, without_pdf: 0, sample: [] },
            rows: [
                { item_id: 'u-PAPER002', display_name: 'Paper two', has_pdf: true },
                { item_id: 'u-PAPER003', display_name: 'Paper three', has_pdf: true },
            ],
        });
        try {
            render(fixture('create-collection-destination'));
            await clickElement(container.querySelector('button[aria-expanded="false"]'));
            await clickElement(container.querySelector('[aria-label="Show Paper three in Zotero"]'));
            expect(revealInLibrary).toHaveBeenCalledWith({ library_ref: 'u', library_id: 1, zotero_key: 'PAPER003' });
        } finally {
            setHost({});
        }
    });

    it('opens a column for editing on click and folds it back on a click outside', async () => {
        render(fixture('create-items'));
        await click('Next');
        expect(container.querySelector('input[aria-label="Column 1 name"]')).toBeNull();
        await clickElement(container.querySelectorAll('.table-card-column')[0]);
        expect(container.querySelector('input[aria-label="Column 1 name"]')).not.toBeNull();
        // The press alone does not collapse it, so nothing moves under the pointer.
        await act(async () => {
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(container.querySelector('input[aria-label="Column 1 name"]')).not.toBeNull();
        await act(async () => {
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(container.querySelector('input[aria-label="Column 1 name"]')).toBeNull();
    });

    it('moves the editor to the column pressed below the open one', async () => {
        render(fixture('create-items'));
        await click('Next');
        await clickElement(container.querySelectorAll('.table-card-column')[0]);
        const next = container.querySelectorAll('.table-card-column')[1];
        await act(async () => {
            next.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        // Nothing collapses on the press, so the layout under the pointer holds
        // until the click arrives.
        expect(container.querySelector('input[aria-label="Column 1 name"]')).not.toBeNull();
        await act(async () => {
            (next as HTMLElement).click();
        });
        expect(container.querySelector('input[aria-label="Column 1 name"]')).toBeNull();
        expect(container.querySelector('input[aria-label="Column 2 name"]')).not.toBeNull();
    });

    it('keeps the editor open when a selection dragged out of a field ends outside the card', async () => {
        render(fixture('create-items'));
        await click('Next');
        await clickElement(container.querySelectorAll('.table-card-column')[0]);
        const header = container.querySelector('input[aria-label="Column 1 name"]') as HTMLInputElement;
        await act(async () => {
            header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(container.querySelector('input[aria-label="Column 1 name"]')).toBe(header);
    });

    it('restores the title when its edit is abandoned with Escape', async () => {
        render(fixture('create-items'));
        await clickElement(container.querySelector('button[aria-label="Edit title"]'));
        const title = container.querySelector('input[aria-label="Table title"]') as HTMLInputElement;
        const original = title.value;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(title, 'Something else');
            title.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(container.querySelector('input[aria-label="Table title"]')).toBeNull();
        expect(container.textContent).toContain(original);
        expect(container.textContent).not.toContain('Something else');
    });

    it.each([
        ['title', 'Edit title', 'input[aria-label="Table title"]'],
        ['description', 'Edit description', 'textarea[aria-label="Table description"]'],
    ])('keeps the %s editor open while an IME owns Enter and Escape', async (_part, editLabel, selector) => {
        render(fixture('create-items'));
        await clickElement(container.querySelector(`button[aria-label="${editLabel}"]`));
        const field = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
        const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        await act(async () => {
            Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, '日本語');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        for (const key of ['Enter', 'Escape']) {
            const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
            await act(async () => {
                field.dispatchEvent(event);
            });
            expect(event.defaultPrevented).toBe(false);
            expect(container.querySelector(selector)).toBe(field);
        }
        expect(field.value).toBe('日本語');
    });

    it('keeps a column editor open when Escape cancels an IME candidate', async () => {
        render(fixture('create-items'));
        await click('Next');
        await clickElement(container.querySelectorAll('.table-card-column')[0]);
        const header = container.querySelector('input[aria-label="Column 1 name"]') as HTMLInputElement;
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
        await act(async () => {
            header.dispatchEvent(enter);
            header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
        });
        expect(enter.defaultPrevented).toBe(false);
        expect(container.querySelector('input[aria-label="Column 1 name"]')).toBe(header);
        await act(async () => {
            header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(container.querySelector('input[aria-label="Column 1 name"]')).toBeNull();
    });

    it('discards a title edit on a click outside, without moving the layout before the click lands', async () => {
        render(fixture('create-items'));
        const original = fixture('create-items').title;
        await clickElement(container.querySelector('button[aria-label="Edit title"]'));
        const title = container.querySelector('input[aria-label="Table title"]') as HTMLInputElement;
        await typeInto(title, 'Unsaved title');
        const next = button('Next')!;
        await act(async () => {
            next.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            title.blur();
        });
        // Losing focus keeps the edit; only the completed click outside ends it.
        expect(container.querySelector('input[aria-label="Table title"]')).toBe(title);
        await act(async () => {
            next.click();
        });
        expect(container.querySelector('input[aria-label="Table title"]')).toBeNull();
        expect(container.textContent).toContain(original);
        expect(container.textContent).not.toContain('Unsaved title');
        expect(button('Create')).toBeTruthy();
    });

    it('saves a title edit with Enter or the check, and discards it with the cross', async () => {
        render(fixture('create-items'));
        await clickElement(container.querySelector('button[aria-label="Edit title"]'));
        await typeInto(container.querySelector('input[aria-label="Table title"]') as HTMLInputElement, 'With Enter');
        await press(container.querySelector('input[aria-label="Table title"]')!, 'Enter');
        expect(container.textContent).toContain('With Enter');

        await clickElement(container.querySelector('button[aria-label="Edit title"]'));
        await typeInto(container.querySelector('input[aria-label="Table title"]') as HTMLInputElement, 'With the check');
        await clickElement(container.querySelector('button[aria-label="Save changes"]'));
        expect(container.textContent).toContain('With the check');

        await clickElement(container.querySelector('button[aria-label="Edit title"]'));
        await typeInto(container.querySelector('input[aria-label="Table title"]') as HTMLInputElement, 'Thrown away');
        await clickElement(container.querySelector('button[aria-label="Discard changes"]'));
        expect(container.textContent).toContain('With the check');
        expect(container.textContent).not.toContain('Thrown away');

        await click('Next');
        await click('Create');
        expect(sent[0].title).toBe('With the check');
    });

    it('opens a column editor on the part that was clicked, with the caret at the end', async () => {
        render(fixture('create-items'));
        await click('Next');
        await clickElement(container.querySelectorAll('.table-card-column-question')[0]);
        const question = container.querySelector('textarea[aria-label="Column 1 question"]') as HTMLTextAreaElement;
        expect(document.activeElement).toBe(question);
        expect(question.selectionStart).toBe(question.value.length);
        await press(question, 'Escape');
        await clickElement(container.querySelectorAll('.table-card-column')[0]);
        const name = container.querySelector('input[aria-label="Column 1 name"]') as HTMLInputElement;
        expect(document.activeElement).toBe(name);
        expect(name.selectionStart).toBe(name.value.length);
    });

    it('adds a dropped paper, and the paper of a dropped attachment', async () => {
        const paper = { id: 5, key: 'PAPER005', libraryID: 1, isRegularItem: () => true, isAttachment: () => false, isNote: () => false, isAnnotation: () => false };
        const pdf = { id: 6, key: 'ATTACH06', libraryID: 1, parentItemID: 7, isRegularItem: () => false, isAttachment: () => true, isNote: () => false, isAnnotation: () => false };
        const parent = { id: 7, key: 'PAPER007', libraryID: 1, isRegularItem: () => true, isAttachment: () => false, isNote: () => false, isAnnotation: () => false };
        const byId: Record<number, unknown> = { 5: paper, 6: pdf, 7: parent };
        (globalThis as any).Zotero.Items = { get: (id: number) => byId[id] ?? false };
        render(fixture('create-items'));
        const zone = container.firstElementChild!;
        await act(async () => {
            zone.dispatchEvent(dragEvent('dragover', { 'zotero/item': '5,6' }));
        });
        expect(container.textContent).toContain('Drop to add 2 items');
        await act(async () => {
            zone.dispatchEvent(dragEvent('drop', { 'zotero/item': '5,6' }));
        });
        expect(mocks.resolveItems).toHaveBeenLastCalledWith(['u-PAPER001', 'u-PAPER002', 'u-PAPER005', 'u-PAPER007']);
        await click('Next');
        expect(doneStep('Sources')).toBe('4 items from 1 source');
    });

    it('refuses a dropped note with the reason, and says which items a mixed drop left out', async () => {
        const paper = { id: 5, key: 'PAPER005', libraryID: 1, isRegularItem: () => true, isAttachment: () => false, isNote: () => false, isAnnotation: () => false };
        const note = { id: 8, key: 'NOTE0008', libraryID: 1, isRegularItem: () => false, isAttachment: () => false, isNote: () => true, isAnnotation: () => false };
        const byId: Record<number, unknown> = { 5: paper, 8: note };
        (globalThis as any).Zotero.Items = { get: (id: number) => byId[id] ?? false };
        render(fixture('create-items'));
        const zone = container.firstElementChild!;
        const refused = dragEvent('drop', { 'zotero/item': '8' });
        await act(async () => {
            zone.dispatchEvent(refused);
        });
        expect(container.textContent).toContain('A note cannot be a table row');
        expect(mocks.resolveItems).not.toHaveBeenCalledWith(expect.arrayContaining(['u-NOTE0008']));
        await act(async () => {
            zone.dispatchEvent(dragEvent('drop', { 'zotero/item': '5,8' }));
        });
        expect(container.textContent).toContain('1 item was not added: a note cannot be a table row.');
        expect(mocks.resolveItems).toHaveBeenLastCalledWith(['u-PAPER001', 'u-PAPER002', 'u-PAPER005']);
    });

    it('adds a dropped collection as a source', async () => {
        mocks.resolveLibraryScope.mockResolvedValue({
            resolved: { count: 3, total: 3, truncated: false, without_pdf: 0, sample: [] },
            rows: [],
            name: 'Cash transfers',
        });
        render(fixture('create-items'));
        await act(async () => {
            container.firstElementChild!.dispatchEvent(dragEvent('drop', { 'zotero/collection': '41' }));
        });
        expect(mocks.resolveLibraryScope).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'collection', library_ref: 'u', key: 'CASHTRN2' }),
        );
    });

    it('selects the destination collection in Zotero from its breadcrumb', async () => {
        const revealCollection = vi.fn();
        const revealLibrary = vi.fn();
        setHost({ navigation: { revealCollection, revealLibrary } as any });
        try {
            render(fixture('create-collection-destination'));
            await clickElement(container.querySelector('button[title="Show Cash transfers in Zotero"]'));
            expect(revealCollection).toHaveBeenCalledWith({ library_id: 0, library_ref: 'u', zotero_key: 'CASHTRN2' });
            await clickElement(container.querySelector('button[title="Show My Library in Zotero"]'));
            expect(revealLibrary).toHaveBeenCalledWith(1);
        } finally {
            setHost({});
        }
    });

    it('shows the steps as circles beside the title, and makes way for the title field', async () => {
        render(fixture('create-items'));
        const stepper = () => container.querySelector('.table-card-header [role="group"]');
        const current = () => stepper()?.querySelector('[aria-current="step"]');
        expect(stepper()?.getAttribute('aria-label')).toBe('Step 1 of 2');
        expect(current()?.getAttribute('aria-label')).toBe('Step 1 of 2: Sources, current');
        // A step still to come is a number, not a way to skip ahead.
        expect(stepper()?.querySelector('button')).toBeNull();
        expect(stepper()?.textContent).toBe('12');
        await clickElement(container.querySelector('button[aria-label="Edit title"]'));
        expect(stepper()).toBeNull();
        await press(container.querySelector('input[aria-label="Table title"]')!, 'Escape');
        expect(stepper()).not.toBeNull();
        await click('Next');
        expect(current()?.getAttribute('aria-label')).toBe('Step 2 of 2: Columns, current');
    });

    it('goes back to a completed step from its circle', async () => {
        render(fixture('create-items'));
        await click('Next');
        const done = container.querySelector('.table-card-header button[aria-label^="Step 1 of 2: Sources, done"]');
        expect(done).not.toBeNull();
        await clickElement(done);
        expect(button('Next')).toBeTruthy();
        expect(container.querySelector('.table-card-header [aria-current="step"]')?.getAttribute('aria-label'))
            .toBe('Step 1 of 2: Sources, current');
    });

    it('puts each step\'s add action in its heading, and opens a column added there', async () => {
        render(fixture('create-items'));
        const heading = () => container.querySelector('.table-card-step-head')!;
        expect(heading().textContent).toContain('Add source');
        await click('Next');
        expect(heading().textContent).toContain('Add column');
        const before = container.querySelectorAll('.table-card-column').length;
        await clickElement([...heading().querySelectorAll('button')].find((b) => b.textContent?.includes('Add column'))!);
        expect(container.querySelectorAll('.table-card-column')).toHaveLength(before + 1);
        const name = container.querySelector(`input[aria-label="Column ${before + 1} name"]`);
        expect(name).not.toBeNull();
        expect(document.activeElement).toBe(name);
    });

    it('opens a source on an error that arrives after it was added, and lets it close', async () => {
        let fail: (value: unknown) => void = () => {};
        mocks.resolveLibraryScope.mockReturnValue(new Promise((resolve) => { fail = resolve; }));
        render(fixture('create-items'));
        await act(async () => {
            mocks.target.pickCollection(41);
        });
        const toggles = () => [...container.querySelectorAll('.table-card-source-toggle')] as HTMLButtonElement[];
        expect(toggles()[1].getAttribute('aria-expanded')).toBe('false');
        await act(async () => {
            fail({
                resolved: { count: 0, total: 0, truncated: false, without_pdf: 0, sample: [], error: 'This library is not available.' },
                rows: [],
            });
        });
        expect(toggles()[1].getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('This library is not available.');
        await clickElement(toggles()[1]);
        expect(toggles()[1].getAttribute('aria-expanded')).toBe('false');
    });

    it('explains a disabled Create in the footer and leads to the column that needs work', async () => {
        render(fixture('create-items'));
        await click('Next');
        expect(container.querySelector('.table-card-footer [role="alert"]')).toBeNull();
        // An empty column added from the heading blocks Create.
        await clickElement([...container.querySelectorAll('.table-card-step-head button')].find((b) => b.textContent?.includes('Add column'))!);
        await press(document.activeElement!, 'Escape');
        const notice = () => container.querySelector('.table-card-footer [role="alert"]');
        expect(notice()?.textContent).toContain('A column needs a name.');
        expect(button('Create')!.disabled).toBe(true);
        await click('Show');
        const index = container.querySelectorAll('.table-card-column').length;
        expect(document.activeElement).toBe(container.querySelector(`input[aria-label="Column ${index} name"]`));
    });

    it('leads from a missing title to the title field', async () => {
        const request = { ...fixture('create-items'), title: '' };
        render(request);
        await click('Next');
        expect(container.querySelector('.table-card-footer [role="alert"]')?.textContent).toContain('Add a title.');
        await click('Edit title');
        expect(document.activeElement).toBe(container.querySelector('input[aria-label="Table title"]'));
    });

    it('shows a column\'s type alone in its summary, with removal in the editor', async () => {
        const request = fixture('create-collection-destination');
        request.columns[0] = { ...request.columns[0], unit: 'participants' };
        render(request);
        await click('Next');
        const first = container.querySelectorAll('.table-card-column')[0];
        expect(first.querySelector('.table-card-type-tag')?.textContent).toBe('Number');
        expect(first.querySelector('button')).toBeNull();
        const before = container.querySelectorAll('.table-card-column').length;
        await clickElement(first);
        await click('Remove');
        expect(container.querySelectorAll('.table-card-column')).toHaveLength(before - 1);
    });

    it('moves to the missing field when the incomplete column is already open', async () => {
        render(fixture('create-items'));
        await click('Next');
        await clickElement([...container.querySelectorAll('.table-card-step-head button')].find((b) => b.textContent?.includes('Add column'))!);
        const index = container.querySelectorAll('.table-card-column').length;
        const name = container.querySelector(`input[aria-label="Column ${index} name"]`) as HTMLInputElement;
        await typeInto(name, 'Region');
        expect(container.querySelector('.table-card-footer [role="alert"]')?.textContent).toContain('Region: Add the question this column asks.');
        // The press on Show starts outside the open editor; the click closes and reopens it.
        const show = button('Show')!;
        await act(async () => {
            show.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            show.click();
        });
        const question = container.querySelector(`textarea[aria-label="Column ${index} question"]`);
        expect(question).not.toBeNull();
        expect(document.activeElement).toBe(question);
    });

    describe('with a cost', () => {
        it('offers "Create and fill" beside "Create only" with the row line, and no chip when the run fits', async () => {
            const request = costedFixture('create-items');
            render(request);
            await click('Next');
            expect(button('Create')).toBeUndefined();
            expect(button('Create only')).toBeTruthy();
            expect(button('Create and fill')!.disabled).toBe(false);
            expect(container.querySelector('.table-card-cost')?.textContent).toBe(
                'Fills 2 rows: 1 from the PDF, 1 without either',
            );
            expect(container.querySelector('.table-card-credit-chip')).toBeNull();
            await click('Create and fill');
            expect(sent[0]).toMatchObject({ approved: true, choice: 'create_and_run', estimate_id: request.cost!.estimate_id });
        });

        it('shows the credit chip when approving raises the authorization', async () => {
            const request = costedFixture('create-items');
            render({ ...request, cost: { ...request.cost!, credits: 12 } });
            expect(container.querySelector('.table-card-credit-chip')?.textContent).toContain('Up to 12 this run');
        });

        it('asks for an estimate on the last step after a source edit, and holds the run button until it lands', async () => {
            vi.useFakeTimers();
            try {
                mocks.estimates = [];
                mocks.resolveLibraryScope.mockResolvedValue({
                    resolved: { count: 40, total: 40, truncated: false, without_pdf: 4, sample: [] },
                    rows: Array.from({ length: 40 }, (_, i) => ({ item_id: `u-COLL${String(i).padStart(4, '0')}`, display_name: `C${i}` })),
                    name: 'Cash transfers',
                });
                const request = costedFixture('create-live-estimate');
                const store = createStore();
                render(request, store);
                await act(async () => {
                    mocks.target.pickCollection(41);
                });
                // Not on the sources step: the run choice is on the last.
                await act(async () => {
                    vi.advanceTimersByTime(1000);
                });
                expect(mocks.estimates).toHaveLength(0);
                await click('Next');
                expect(button('Create and fill')!.disabled).toBe(true);
                expect(button('Create only')!.disabled).toBe(false);
                expect(container.textContent).toContain('Updating the estimate…');
                await act(async () => {
                    vi.advanceTimersByTime(1000);
                });
                expect(mocks.estimates).toEqual([request]);

                // The socket handler marks the draft pending, then applies the answer.
                const { estimate_result } = read('create-live-estimate');
                await act(async () => {
                    const draft = store.get(tableCardDraftsAtom).get(request.card_id)!;
                    const pending = startEstimate(draft, request, estimate_result.request_id).draft;
                    store.set(tableCardDraftsAtom, new Map([[request.card_id, applyEstimateResult(pending, estimate_result)]]));
                });
                expect(button('Create and fill')!.disabled).toBe(false);
                expect(container.querySelector('.table-card-cost')?.textContent).toBe(
                    'Fills up to 43 rows: 37 from the PDF, 6 from title and abstract',
                );
                expect(container.querySelector('.table-card-credit-chip')?.textContent).toContain('Up to 9 this run');
                await click('Create and fill');
                expect(sent[0]).toMatchObject({ choice: 'create_and_run', estimate_id: estimate_result.cost.estimate_id });
            } finally {
                vi.useRealTimers();
            }
        });

        it('lets a failed estimate be asked again and keeps "Create only" available', async () => {
            const request = costedFixture('create-items');
            const store = createStore();
            render(request, store);
            await click('Next');
            await click('Add column');
            await act(async () => {
                const draft = store.get(tableCardDraftsAtom).get(request.card_id)!;
                const pending = startEstimate(draft, request, 'r1').draft;
                store.set(
                    tableCardDraftsAtom,
                    new Map([[request.card_id, applyEstimateResult(pending, { event: 'table_card_estimate_result', card_id: request.card_id, request_id: 'r1', error: 'unknown_card' } as any)]]),
                );
            });
            expect(container.textContent).toContain('The estimate could not be updated.');
            expect(button('Create and fill')!.disabled).toBe(true);
            mocks.estimates = [];
            await click('Try again');
            expect(container.textContent).not.toContain('The estimate could not be updated.');
        });
    });

    describe('the fill card', () => {
        function renderFill(request: WSTableFillCardRequest) {
            sent = [];
            act(() => {
                root = createRoot(container);
                root.render(
                    React.createElement(
                        Provider,
                        { store: createStore() },
                        React.createElement(TableFillCard, { request, onSubmit: (r: WSTableCardResponse) => sent.push(r) }),
                    ),
                );
            });
        }

        it('shows the columns, the row line, the credit chip and a run button named for the rows', async () => {
            const { request, reply } = read('fill-with-credits');
            const opened: unknown[] = [];
            setHost({ navigation: { openTable: async (key: string) => { opened.push(key); return { ok: true }; } } } as any);
            renderFill(request);
            expect(container.textContent).toContain('Comparison');
            expect(container.textContent).toContain('Sample size');
            expect(container.textContent).toContain('Design');
            expect(container.querySelector('.table-card-cost')?.textContent).toBe(
                'Fills 32 rows: 30 from the PDF, 2 from title and abstract',
            );
            expect(container.querySelector('.table-card-credit-chip')?.textContent).toContain('Up to 7 this run');
            // Nothing on it is editable.
            expect(container.querySelector('input, textarea')).toBeNull();
            await click('Open table');
            expect(opened).toEqual(['u-TABLE222']);
            await click('Fill 32');
            expect(sent).toEqual([{ type: 'table_card_response', card_id: reply.card_id, approved: true, choice: 'fill', estimate_id: reply.estimate_id }]);
        });

        it('declines with instructions from the cancel view', async () => {
            const { request, reply } = read('fill-declined');
            renderFill(request);
            expect(container.querySelector('.table-card-credit-chip')).toBeNull();
            await click('Cancel');
            await typeInto(instructionsField(), 'Try three papers first');
            await click('Send');
            expect(sent).toEqual([reply]);
        });
    });
});
