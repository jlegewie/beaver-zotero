import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionTargetType } from '@beaver/agent-core/types/actions';

// Fake items carry their readable kind and trash state; the support
// predicates read those instead of real attachment metadata.
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: (item: any) => !!item && !item._trashed && (item._type !== 'attachment' || item._kind !== null),
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: (item: any) => item._kind ?? null,
}));

import {
    resolveItemTargets,
    summarizeItemSelection,
    actsOnSelection,
    bestReadableAttachment,
} from '../../../src/services/actions/actionItemTargets';

const registry = new Map<number, any>();
let nextId = 1;

function regular(attachments: any[] = [], trashed = false): Zotero.Item {
    const item: any = {
        id: nextId++, _type: 'regular', _trashed: trashed,
        isRegularItem: () => true, isAttachment: () => false, isNote: () => false,
        isInTrash: () => trashed,
        getAttachments: () => attachments.map(a => a.id),
    };
    for (const attachment of attachments) attachment.parentItem = item;
    registry.set(item.id, item);
    return item;
}

function file(kind: string | null = 'pdf', trashed = false): any {
    const item: any = {
        id: nextId++, _type: 'attachment', _kind: kind, _trashed: trashed, parentItem: null,
        isRegularItem: () => false, isAttachment: () => true, isNote: () => false,
        isInTrash: () => trashed,
    };
    registry.set(item.id, item);
    return item;
}

function note(): Zotero.Item {
    const item: any = {
        id: nextId++, _type: 'note',
        isRegularItem: () => false, isAttachment: () => false, isNote: () => true,
        isInTrash: () => false,
    };
    registry.set(item.id, item);
    return item;
}

const ids = (items: Zotero.Item[]) => items.map(i => i.id);
const actsOnItems = (targets: ActionTargetType[], items: Zotero.Item[]) => resolveItemTargets(targets, items).items.length > 0;

beforeEach(() => {
    registry.clear();
    (globalThis as any).Zotero.Items = { get: (id: number) => registry.get(id) ?? false };
});

describe('resolveItemTargets — a paper and its file stand in for each other', () => {
    it('runs a file-only action on the selected paper\'s PDF', () => {
        const pdf = file('pdf');
        const paper = regular([pdf]);
        const resolved = resolveItemTargets(['attachment'], [paper]);
        expect(ids(resolved.items)).toEqual([pdf.id]);
        expect(resolved.targetType).toBe('attachment');
    });

    it('runs an item-only action on the selected PDF\'s parent', () => {
        const pdf = file('pdf');
        const paper = regular([pdf]);
        const resolved = resolveItemTargets(['items'], [pdf]);
        expect(ids(resolved.items)).toEqual([paper.id]);
        expect(resolved.targetType).toBe('items');
    });

    it('keeps items an action takes directly, without swapping them', () => {
        const pdf = file('pdf');
        const paper = regular([pdf]);
        const resolved = resolveItemTargets(['items', 'attachment'], [paper, pdf]);
        expect(ids(resolved.items)).toEqual([paper.id, pdf.id]);
        expect(resolved.targetType).toBe('items');
    });

    it('does not attach the same paper twice when it and its file are selected', () => {
        const pdf = file('pdf');
        const paper = regular([pdf]);
        expect(ids(resolveItemTargets(['items'], [paper, pdf]).items)).toEqual([paper.id]);
    });

    it('drops a paper with no readable file for a file-only action', () => {
        const paper = regular([file(null)]);
        expect(resolveItemTargets(['attachment'], [paper])).toEqual({ items: [], targetType: null });
        expect(actsOnItems(['attachment'], [paper])).toBe(false);
    });

    it('drops a standalone file for an item-only action', () => {
        expect(actsOnItems(['items'], [file('pdf')])).toBe(false);
    });

    it('ignores trashed items and notes for item actions, but keeps notes for note actions', () => {
        const trashedPaper = regular([file('pdf')], true);
        const n = note();
        expect(actsOnItems(['items', 'attachment'], [trashedPaper, n])).toBe(false);
        expect(ids(resolveItemTargets(['note'], [trashedPaper, n]).items)).toEqual([n.id]);
    });

    it('offers nothing to actions without an item kind', () => {
        const targets: ActionTargetType[] = ['collection', 'global'];
        expect(actsOnItems(targets, [regular([file('pdf')])])).toBe(false);
    });
});

describe('bestReadableAttachment', () => {
    it('prefers a PDF, then an EPUB, over other readable files', () => {
        const snapshot = file('snapshot');
        const epub = file('epub');
        const pdf = file('pdf');
        expect(bestReadableAttachment(regular([snapshot, epub, pdf]))).toBe(pdf);
        expect(bestReadableAttachment(regular([snapshot, file('epub')]))?.['_kind']).toBe('epub');
    });

    it('skips trashed and unreadable files', () => {
        const paper = regular([file('pdf', true), file(null)]);
        expect(bestReadableAttachment(paper)).toBeNull();
    });

    it('reads as "no file" when the child list is not loaded', () => {
        const paper: any = regular();
        paper.getAttachments = () => { throw new Error('childItems not loaded'); };
        expect(bestReadableAttachment(paper)).toBeNull();
    });
});

describe('summarizeItemSelection + actsOnSelection', () => {
    it('matches resolveItemTargets on mixed selections', () => {
        const withFile = regular([file('pdf')]);
        const fileOnly = regular([]);
        const standalone = file('epub');
        const selections = [[withFile], [fileOnly], [standalone], [standalone.parentItem ?? standalone], [note()], [fileOnly, standalone]];
        const targetSets: ActionTargetType[][] = [['items'], ['attachment'], ['note'], ['items', 'attachment'], ['collection']];
        for (const selection of selections) {
            const kinds = summarizeItemSelection(selection);
            for (const targets of targetSets) {
                expect(actsOnSelection(targets, kinds)).toBe(actsOnItems(targets, selection));
            }
        }
    });
});
