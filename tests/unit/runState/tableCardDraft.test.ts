import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WSTableCardRequest, WSTableCardResponse } from '@beaver/agent-core/protocol/tableCardProtocol';
import {
    cardDestination,
    cardRowCount,
    setSourceItemIds,
    stepCount,
    addColumn,
    addItems,
    addLibrarySource,
    addScreening,
    cardTotals,
    columnProblem,
    createActions,
    createBlocker,
    destinationLine,
    initialTableCardDraft,
    itemsSource,
    mergeLine,
    nextStep,
    overCapMessage,
    overCapSources,
    previousStep,
    removeColumn,
    removeItem,
    removeScreening,
    removeSource,
    setSourceResolved,
    stepSummary,
    tableCardDecline,
    tableCardResponse,
    tableCardSteps,
    undoRemoveItem,
    updateColumn,
} from '@beaver/agent-core/run-state/tableCardDraft';

const FIXTURES = join(__dirname, '../../fixtures/artifacts/table-cards');

interface CardFixture {
    description: string;
    request: WSTableCardRequest;
    reply?: WSTableCardResponse;
}

function fixture(name: string): CardFixture {
    return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const resolved = (count: number, total = count, extra = {}) => ({
    count,
    total,
    truncated: total > count,
    without_pdf: 0,
    sample: [],
    ...extra,
});

describe('table card draft', () => {
    it('reads every shared fixture', () => {
        for (const file of readdirSync(FIXTURES)) {
            const { request } = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as CardFixture;
            const draft = initialTableCardDraft(request);
            expect(draft.sources).toHaveLength(request.sources.length);
            expect(draft.columns).toHaveLength(request.columns.length);
        }
    });

    it('sends the proposal unchanged with a single Create while cost is null', () => {
        const { request, reply } = fixture('create-items');
        const draft = initialTableCardDraft(request);
        expect(createActions(draft, request)).toEqual({ primary: { label: 'Create', choice: 'create' } });
        expect(createBlocker(draft, request)).toBeNull();
        const response = tableCardResponse(draft, request, 'create');
        expect(response).toMatchObject({
            card_id: reply!.card_id,
            approved: true,
            choice: 'create',
            title: reply!.title,
            sources: [{ type: 'items', ids: request.sources[0].ids }],
            criteria: [],
            user_instructions: null,
        });
        expect(response.columns).toEqual(reply!.columns);
    });

    it('names the primary for what runs once the card carries a cost', () => {
        const { request } = fixture('create-items');
        const costed = { ...request, cost: { extraction: { rows: 2, credits: 4 } } };
        const draft = initialTableCardDraft(costed);
        expect(createActions(draft, costed)).toEqual({
            primary: { label: 'Create and fill', choice: 'create_and_run' },
            secondary: { label: 'Create only', choice: 'create' },
        });
        const screening = { ...draft, criteria: ['Adults only'] };
        expect(createActions(screening, costed).primary.label).toBe('Create and run');
        expect(createActions({ ...screening, columns: [] }, costed).primary.label).toBe('Create and screen');
    });

    it('produces the edited reply the backend fixture expects', () => {
        const { request, reply } = fixture('create-items-edited');
        let draft = initialTableCardDraft(request);
        draft = { ...draft, title: reply!.title! };
        draft = removeItem(draft, request.sources[0].ids![1]);
        draft = addLibrarySource(draft, { kind: 'collection', library_ref: 'u', key: 'CASHTRN2' }).draft;
        draft = updateColumn(draft, draft.columns[0].key, { description: reply!.columns![0].description! });
        const response = tableCardResponse(draft, request, 'create');
        expect(response.title).toBe(reply!.title);
        expect(response.sources).toEqual([
            { type: 'items', ids: [request.sources[0].ids![0]] },
            { type: 'library', scope: { kind: 'collection', library_ref: 'u', key: 'CASHTRN2' } },
        ]);
        expect(response.columns).toEqual(reply!.columns);
    });

    it('steps through Sources and Columns, with Screening only once added', () => {
        const { request } = fixture('create-items');
        let draft = initialTableCardDraft(request);
        expect(tableCardSteps(draft)).toEqual(['sources', 'columns']);
        draft = nextStep(draft);
        expect(draft.step).toBe('columns');
        expect(nextStep(draft).step).toBe('columns');
        draft = previousStep(draft);
        expect(draft.step).toBe('sources');
        draft = addScreening(draft);
        expect(tableCardSteps(draft)).toEqual(['sources', 'screening', 'columns']);
        expect(draft.step).toBe('screening');
        expect(stepSummary(draft, 'screening', request)).toBe('No criteria');
        expect(tableCardResponse(draft, request, 'create').criteria).toEqual([]);
        draft = removeScreening(draft);
        expect(draft.step).toBe('sources');
        expect(tableCardSteps(draft)).toEqual(['sources', 'columns']);
    });

    it('summarises completed steps in one line', () => {
        const { request } = fixture('create-merge-across-sources');
        const draft = initialTableCardDraft(request);
        // The backend's merged count for the proposal as sent.
        expect(stepSummary(draft, 'sources', request)).toBe('2 items from 2 sources');
        expect(stepSummary(draft, 'columns', request)).toBe('2 questions');
    });

    it('shows the destination line', () => {
        expect(destinationLine(fixture('create-items').request.destination)).toBe('My Library');
        expect(destinationLine(fixture('create-collection-destination').request.destination)).toBe(
            'My Library › Cash transfers',
        );
    });

    it("uses the backend's merge line until the sources are edited", () => {
        const { request } = fixture('create-merge-across-sources');
        let draft = initialTableCardDraft(request);
        expect(mergeLine(draft, request)).toBe('2 items across sources; found in more than one source, merged −1');
        draft = removeItem(draft, request.sources[0].ids![0]);
        draft = undoRemoveItem(draft, request.sources[0].ids![0]);
        expect(mergeLine(draft, request)).toBe('3 items across sources; duplicates are merged on create');
        expect(mergeLine(initialTableCardDraft(fixture('create-items').request), fixture('create-items').request)).toBeNull();
    });

    it('removes items from the Selected items card with undo', () => {
        const { request } = fixture('create-items');
        const id = request.sources[0].ids![0];
        let draft = removeItem(initialTableCardDraft(request), id);
        expect(itemsSource(draft)!.ids).not.toContain(id);
        expect(itemsSource(draft)!.removed).toEqual([id]);
        expect(createBlocker(draft, request)).toBe('Counting items…');
        draft = undoRemoveItem(draft, id);
        expect(itemsSource(draft)!.ids).toContain(id);
        draft = setSourceResolved(draft, 'items', resolved(1));
        expect(tableCardResponse(draft, request, 'create').sources![0].ids).toHaveLength(2);
    });

    it('collects picked items into one Selected items card', () => {
        const { request } = fixture('create-collection-destination');
        let draft = addItems(initialTableCardDraft(request), ['u-PAPER001', 'u-PAPER001']);
        draft = addItems(draft, ['u-PAPER001', 'u-PAPER004']);
        expect(draft.sources.filter((s) => s.type === 'items')).toHaveLength(1);
        expect(itemsSource(draft)!.ids).toEqual(['u-PAPER001', 'u-PAPER004']);
    });

    it('counts a collection added on the card once its count lands', () => {
        const { request } = fixture('create-items');
        const scope = { kind: 'collection' as const, library_ref: 'u', key: 'CASHTRN2' };
        const added = addLibrarySource(initialTableCardDraft(request), scope);
        expect(addLibrarySource(added.draft, scope).key).toBeNull();
        expect(createBlocker(added.draft, request)).toBe('Counting items…');
        const counted = setSourceResolved(added.draft, added.key!, resolved(14));
        expect(cardTotals(counted)).toEqual({ count: 16, total: 16 });
        expect(createBlocker(counted, request)).toBeNull();
        expect(removeSource(counted, added.key!).sources).toHaveLength(1);
    });

    it('warns on the over-cap card and disables Create', () => {
        const { request } = fixture('create-over-cap');
        const draft = initialTableCardDraft(request);
        const [key] = overCapSources(draft, request);
        expect(key).toBe(draft.sources[0].key);
        expect(overCapMessage(draft, request)).toBe(
            'This table would have 1,840 items; the maximum is 1,000. Remove sources to continue.',
        );
        expect(createBlocker(draft, request)).toBe(overCapMessage(draft, request));
        // The step reports the source's full size, not the rows the cap left.
        expect(stepCount(draft, 'sources', request)).toBe(1840);
        expect(stepSummary(draft, 'sources', request)).toBe('1,840 items from 1 source');
    });

    it('warns once with the neutral message when only the sum is over the cap', () => {
        const { request } = fixture('create-items');
        let draft = initialTableCardDraft(request);
        const a = addLibrarySource(draft, { kind: 'tag', library_ref: 'u', tag: 'a' });
        draft = setSourceResolved(a.draft, a.key!, resolved(600));
        const b = addLibrarySource(draft, { kind: 'tag', library_ref: 'u', tag: 'b' });
        draft = setSourceResolved(b.draft, b.key!, resolved(500));
        expect(overCapSources(draft, request)).toEqual([a.key]);
        // The same neutral message, whichever source tipped the table over.
        expect(overCapMessage(draft, request)).toBe(
            'This table would have 1,102 items; the maximum is 1,000. Remove sources to continue.',
        );
    });

    it('needs a finished question column', () => {
        const { request } = fixture('create-without-columns');
        let draft = initialTableCardDraft(request);
        expect(createBlocker(draft, request)).toBe('Add a question column.');
        const added = addColumn(draft);
        draft = added.draft;
        expect(createBlocker(draft, request)).toBe('Finish the question columns.');
        draft = updateColumn(draft, added.key, { header: 'Design', description: 'What design?', type: 'select' });
        expect(createBlocker(draft, request)).toBe('Finish the question columns.');
        draft = updateColumn(draft, added.key, { options: ['RCT', ' rct '] });
        expect(createBlocker(draft, request)).toBe('Finish the question columns.');
        draft = updateColumn(draft, added.key, { options: ['RCT', 'Other', ''] });
        expect(createBlocker(draft, request)).toBeNull();
        expect(tableCardResponse(draft, request, 'create').columns).toEqual([
            { header: 'Design', type: 'select', description: 'What design?', options: ['RCT', 'Other'] },
        ]);
        expect(removeColumn(draft, added.key).columns).toHaveLength(0);
    });

    it('declines with instructions only when the user typed them', () => {
        const { request } = fixture('create-items');
        const draft = initialTableCardDraft(request);
        expect(tableCardDecline(draft, request)).toEqual({
            type: 'table_card_response',
            card_id: request.card_id,
            approved: false,
            user_instructions: null,
        });
        expect(tableCardDecline({ ...draft, instructions: ' Use a note ' }, request).user_instructions).toBe('Use a note');
    });

    it('blocks Create while a source cannot be resolved', () => {
        const { request } = fixture('create-items');
        const added = addLibrarySource(initialTableCardDraft(request), { kind: 'collection', library_ref: 'u', key: 'NQSUCHC2' });
        const draft = setSourceResolved(added.draft, added.key!, resolved(0, 0, { error: 'Collection not found' }));
        expect(createBlocker(draft, request)).toBe('Remove the source that cannot be used.');
    });

    it("measures the cap against the backend's merged rows for the proposal as sent", () => {
        const { request } = fixture('create-merge-across-sources');
        const overlapping = {
            ...request,
            row_cap: 900,
            merge: { rows: 700, duplicates: 700 },
            sources: request.sources.map((source) => ({
                ...source,
                resolved: { ...source.resolved!, count: 700, total: 700, truncated: false },
            })),
        };
        const draft = initialTableCardDraft(overlapping);
        expect(overCapSources(draft, overlapping)).toEqual([]);
        expect(createBlocker(draft, overlapping)).toBeNull();
        // After an edit the card cannot merge, so it counts every source's rows.
        const edited = removeItem(draft, overlapping.sources[0].ids![0]);
        const counted = setSourceResolved(edited, 'items', resolved(700));
        expect(overCapSources(counted, overlapping)).toHaveLength(1);
    });

    it('warns on a source the cap cut short even when the merged rows fit', () => {
        const { request } = fixture('create-over-cap');
        const draft = initialTableCardDraft({ ...request, merge: { rows: 1000, duplicates: 0 } });
        expect(overCapSources(draft, request)).toEqual([draft.sources[0].key]);
    });

    it('folds several item entries into the one Selected items source', () => {
        const { request } = fixture('create-items');
        const two = {
            ...request,
            sources: [
                { id: 's1', type: 'items' as const, ids: ['u-AAAAAAAA'] },
                { id: 's2', type: 'items' as const, ids: ['u-BBBBBBBB', 'u-AAAAAAAA'] },
            ],
        };
        let draft = initialTableCardDraft(two);
        expect(draft.sources).toHaveLength(1);
        expect(itemsSource(draft)!.ids).toEqual(['u-AAAAAAAA', 'u-BBBBBBBB']);
        expect(itemsSource(draft)!.counting).toBe(true);
        draft = addItems(draft, ['u-CCCCCCCC']);
        expect(tableCardResponse(draft, two, 'create').sources).toEqual([
            { type: 'items', ids: ['u-AAAAAAAA', 'u-BBBBBBBB', 'u-CCCCCCCC'] },
        ]);
    });

    it("counts a paper in two edited sources once when every source's items are known", () => {
        const { request } = fixture('create-items');
        const added = addLibrarySource(initialTableCardDraft(request), { kind: 'collection', library_ref: 'u', key: 'CASHTRN2' });
        let draft = setSourceResolved(added.draft, added.key!, resolved(3), ['u-PAPER001', 'u-PAPER003', 'u-PAPER004']);
        // Until the Selected items' own items are known, the counts are summed.
        expect(cardRowCount(draft, request)).toBe(5);
        draft = setSourceItemIds(draft, 'items', ['u-PAPER001', 'u-PAPER002']);
        expect(cardRowCount(draft, request)).toBe(4);
        expect(mergeLine(draft, request)).toBe('4 items across sources; duplicates are merged on create');
        expect(stepCount(draft, 'sources', request)).toBe(4);
    });

    it('puts an undone item back where it was', () => {
        const { request } = fixture('create-items');
        const [first, second] = request.sources[0].ids!;
        let draft = removeItem(initialTableCardDraft(request), first);
        draft = undoRemoveItem(draft, first);
        expect(itemsSource(draft)!.ids).toEqual([first, second]);
    });

    describe('select options, checked as the backend checks the reply', () => {
        const select = (options: string[]) => ({
            key: 'c', header: 'Design', type: 'select' as const, description: 'Which design?', options,
        });

        it('treats labels that differ only in case, spacing, dashes or trailing punctuation as one option', () => {
            expect(columnProblem(select(['Yes', 'Yes.']))).toBe('Options must differ.');
            expect(columnProblem(select(['low-risk', 'low risk']))).toBe('Options must differ.');
            expect(columnProblem(select(['Yes', 'No']))).toBeNull();
        });

        it('allows at most 50 options of at most 60 characters', () => {
            const many = Array.from({ length: 51 }, (_, i) => `Option ${i}`);
            expect(columnProblem(select(many))).toContain('at most 50');
            expect(columnProblem(select(many.slice(0, 50)))).toBeNull();
            expect(columnProblem(select(['x'.repeat(61)]))).toContain('60 characters');
            // Code points, as Python counts them: 60 emoji are 120 UTF-16 units.
            expect(columnProblem(select(['😀'.repeat(60)]))).toBeNull();
        });

        it('blocks Create above the question-column cap', () => {
            const { request } = fixture('create-items');
            let draft = initialTableCardDraft(request);
            while (draft.columns.length <= 30) {
                const added = addColumn(draft);
                draft = updateColumn(added.draft, added.key, { header: 'H', description: 'Q?' });
            }
            expect(createBlocker(draft, request)).toContain('at most 30 question columns');
        });
    });

    describe('destination', () => {
        const libraries: Record<string, { name: string; writable: boolean }> = {
            u: { name: 'My Library', writable: true },
            g42: { name: 'Lab', writable: true },
            g77: { name: 'Archive', writable: false },
        };
        const libraryOf = (ref: string) => libraries[ref] ?? null;
        const groupCollection = { kind: 'collection' as const, library_ref: 'g42', key: 'LABPAPR2', name: 'Lab papers' };

        it('follows the edited sources when it was derived', () => {
            const { request } = fixture('create-collection-destination');
            let draft = initialTableCardDraft(request);
            expect(cardDestination(draft, request, libraryOf)).toEqual(request.destination);
            draft = addItems(draft, ['u-PAPER001']);
            expect(cardDestination(draft, request, libraryOf)).toEqual({
                library_ref: 'u', library_name: 'My Library', explicit: false,
            });
        });

        it('stays fixed when the model named it', () => {
            const { request } = fixture('create-collection-destination');
            const explicit = { ...request, destination: { ...request.destination, explicit: true } };
            const draft = addItems(initialTableCardDraft(explicit), ['g42-GROUP001']);
            expect(cardDestination(draft, explicit, libraryOf)).toEqual(explicit.destination);
        });

        it('moves from a group to the user library when the group source is removed', () => {
            const { request } = fixture('create-items');
            const group = {
                ...request,
                sources: [{ id: 's1', type: 'library' as const, scope: groupCollection }],
                destination: { library_ref: 'g42', library_name: 'Lab', collection_key: 'LABPAPR2', collection_name: 'Lab papers', explicit: false },
            };
            let draft = initialTableCardDraft(group);
            draft = addItems(draft, ['u-PAPER001']);
            draft = removeSource(draft, draft.sources[0].key);
            expect(cardDestination(draft, group, libraryOf)).toEqual({ library_ref: 'u', library_name: 'My Library', explicit: false });
        });

        it('files one group collection in the group, and a read-only library in the user library', () => {
            const { request } = fixture('create-items');
            let draft = removeSource(initialTableCardDraft(request), 'items');
            draft = addLibrarySource(draft, groupCollection).draft;
            expect(cardDestination(draft, request, libraryOf)).toEqual({
                library_ref: 'g42', library_name: 'Lab', collection_key: 'LABPAPR2', collection_name: 'Lab papers', explicit: false,
            });
            draft = addLibrarySource(removeSource(draft, draft.sources[0].key), { kind: 'tag', library_ref: 'g77', tag: 'old' }).draft;
            expect(cardDestination(draft, request, libraryOf)!.library_ref).toBe('u');
        });

        it('has nowhere to go, and blocks Create, when the user library cannot take the fallback', () => {
            const { request } = fixture('create-items');
            const noUser = (ref: string) => (ref === 'u' ? null : libraryOf(ref));
            let draft = initialTableCardDraft(request);
            draft = addLibrarySource(draft, groupCollection).draft;
            expect(cardDestination(draft, request, noUser)).toBeNull();
            expect(createBlocker(draft, request, noUser)).toContain('My Library cannot hold the table');
            // The proposal as sent keeps the backend's destination.
            expect(cardDestination(initialTableCardDraft(request), request, noUser)).toEqual(request.destination);
        });
    });
});

