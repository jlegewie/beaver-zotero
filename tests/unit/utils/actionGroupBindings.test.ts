import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Action, ActionTargetType } from '@beaver/agent-core/types/actions';

vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: (item: any) => !!item && (item._type !== 'attachment' || item._kind !== null),
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: (item: any) => item._kind ?? null,
}));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => 'Smith 2020' }));

import {
    computeActionGroups,
    primaryActionGroup,
    bindingForAction,
    type ActionContext,
} from '../../../react/utils/actionVisibility';

const registry = new Map<number, any>();
let nextId = 1;

function paper(attachments: any[] = []): Zotero.Item {
    const item: any = {
        id: nextId++, libraryID: 1, key: `R${nextId}`, _type: 'regular',
        isRegularItem: () => true, isAttachment: () => false, isNote: () => false, isInTrash: () => false,
        getAttachments: () => attachments.map(a => a.id),
        getItemTypeIconName: () => 'journalArticle',
    };
    for (const a of attachments) a.parentItem = item;
    registry.set(item.id, item);
    return item;
}

function pdf(): any {
    const item: any = {
        id: nextId++, libraryID: 1, key: `A${nextId}`, _type: 'attachment', _kind: 'pdf', parentItem: null,
        isRegularItem: () => false, isAttachment: () => true, isNote: () => false, isInTrash: () => false,
        getItemTypeIconName: () => 'attachmentPDF',
        getDisplayTitle: () => 'Full Text PDF',
    };
    registry.set(item.id, item);
    return item;
}

const action = (id: string, targets: ActionTargetType[]): Action => ({ id, title: id, text: `prompt ${id}`, targets });

const SKIM = action('skim', ['attachment']);
const TAG = action('tag', ['items', 'collection']);
const SUMMARIZE = action('summarize', ['items', 'attachment']);
const NOTE_ACTION = action('note', ['note']);
const TABLE = action('table', ['items', 'collection', 'global']);
const DISCOVER = action('discover', ['global']);
const ALL = [SKIM, TAG, SUMMARIZE, NOTE_ACTION, TABLE, DISCOVER];

function context(zotero: Partial<ActionContext['zotero']>, manualItems: Zotero.Item[] = []): ActionContext {
    return {
        zotero: {
            type: 'library',
            readerAttachment: null,
            noteItem: null,
            selectedItems: [],
            libraryView: { selectedCollections: [], selectedViews: [], selectedRowCount: 0 },
            ...zotero,
        } as unknown as ActionContext['zotero'],
        manualItems,
    };
}

beforeEach(() => {
    registry.clear();
    (globalThis as any).Zotero.Items = { get: (id: number) => registry.get(id) ?? false };
});

describe('selected items — one rule for papers and their files', () => {
    it('offers file actions on a selected paper and binds them to its PDF', () => {
        const file = pdf();
        const item = paper([file]);
        const group = primaryActionGroup(computeActionGroups(ALL, context({ type: 'items_selected', selectedItems: [item] })));
        expect(group?.id).toBe('selected');
        expect(group?.actions).toEqual([SKIM, TAG, SUMMARIZE, TABLE]);
        expect(group?.bind(SKIM)).toEqual({ targetType: 'attachment', items: [file] });
        expect(group?.bind(TAG)).toEqual({ targetType: 'items', items: [item] });
    });

    it('offers item actions on a selected PDF and binds them to its parent', () => {
        const file = pdf();
        const item = paper([file]);
        const group = primaryActionGroup(computeActionGroups(ALL, context({ type: 'items_selected', selectedItems: [file] })));
        expect(group?.actions).toEqual([SKIM, TAG, SUMMARIZE, TABLE]);
        expect(group?.bind(TAG)).toEqual({ targetType: 'items', items: [item] });
        expect(group?.bind(SUMMARIZE)).toEqual({ targetType: 'attachment', items: [file] });
    });

    it('hides file actions for a paper without a readable file', () => {
        const group = primaryActionGroup(computeActionGroups(ALL, context({ type: 'items_selected', selectedItems: [paper()] })));
        expect(group?.actions).toEqual([TAG, SUMMARIZE, TABLE]);
    });

    it('lists an action that also works anywhere under the selection, not under Anywhere', () => {
        const groups = computeActionGroups(ALL, context({ type: 'items_selected', selectedItems: [paper()] }));
        expect(groups.find(g => g.id === 'global')?.actions).toEqual([DISCOVER]);
        expect(bindingForAction(TABLE, groups)).toMatchObject({ targetType: 'items' });
        expect(bindingForAction(DISCOVER, groups)).toEqual({ targetType: 'global' });
    });
});

describe('reader — the open file and its parent paper', () => {
    it('offers item actions in the reader and binds by kind', () => {
        const file = pdf();
        paper([file]);
        const group = primaryActionGroup(computeActionGroups(ALL, context({ type: 'reader', readerAttachment: file })));
        expect(group?.id).toBe('reader');
        expect(group?.actions).toEqual([SKIM, TAG, SUMMARIZE, TABLE]);
        expect(group?.bind(SKIM)).toEqual({ targetType: 'attachment' });
        expect(group?.bind(TAG)).toEqual({ targetType: 'items' });
    });

    it('does not offer item actions for a standalone file', () => {
        const group = primaryActionGroup(computeActionGroups(ALL, context({ type: 'reader', readerAttachment: pdf() })));
        expect(group?.actions).toEqual([SKIM, SUMMARIZE]);
    });
});

describe('attached items', () => {
    it('adds nothing for an action that takes the attached items as they are', () => {
        const item = paper([pdf()]);
        const group = primaryActionGroup(computeActionGroups(ALL, context({}, [item])));
        expect(group?.id).toBe('manual');
        expect(group?.bind(TAG)).toEqual({});
    });

    it('attaches the paper\'s file for a file-only action', () => {
        const file = pdf();
        const item = paper([file]);
        const group = primaryActionGroup(computeActionGroups(ALL, context({}, [item])));
        expect(group?.bind(SKIM)).toEqual({ targetType: 'attachment', items: [file] });
    });

    it('comes before the selection, which is skipped when it is the same set', () => {
        const item = paper();
        const groups = computeActionGroups(ALL, context({ type: 'items_selected', selectedItems: [item] }, [item]));
        expect(groups.map(g => g.id)).toEqual(['manual', 'global']);
    });
});

describe('no context', () => {
    it('has no context group, so the homepage bar shows only the project', () => {
        const groups = computeActionGroups(ALL, context({}));
        expect(primaryActionGroup(groups)).toBeNull();
        expect(groups.map(g => g.id)).toEqual(['global']);
    });
});
