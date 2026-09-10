import { beforeEach, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { initializeWindowRuntime } from '../../../react/runtime/windowRuntime';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/agentItemSupport', () => ({ agentItemFilter: () => true }));
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: vi.fn() }));
vi.mock('../../../react/components/ui/popup/InvalidItemsMessageContent', () => ({ InvalidItemsMessageContent: () => null }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { searchableLibraryIdsAtom: atom([1]), excludedLibraryIdsAtom: atom([2]) };
});
const { validate, popup } = vi.hoisted(() => ({ validate: vi.fn(), popup: vi.fn() }));
vi.mock('../../../react/atoms/itemValidation', async () => {
    const { atom } = await import('jotai');
    return {
        getItemValidationAtom: atom(() => () => undefined),
        isHardBlockedValidation: () => false, isRejectedItemValidation: () => false,
        validateItemsAtom: atom(null, (_get, _set, items) => { validate(items); return Promise.resolve(); }),
        validateRegularItemAtom: atom(null, () => Promise.resolve()),
    };
});
vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    const notice = atom(null, (_get, _set, value) => popup(value));
    return {
        addPopupMessageAtom: notice, addRegularItemPopupAtom: notice, addRegularItemsSummaryPopupAtom: notice,
        removePopupMessageAtom: notice, addExcludedLibraryPopupAtom: notice,
        EXCLUDED_LIBRARY_READER_POPUP_ID: 'reader', EXCLUDED_LIBRARY_SELECTION_POPUP_ID: 'selection',
        safeChildAttachments: () => [],
    };
});

const { currentMessageItemsAtom, updateMessageItemsFromZoteroSelectionAtom } = await import('../../../react/atoms/messageComposition');
const selected = vi.fn();
const owner = { closed: false, ZoteroPane: { getSelectedItems: selected } } as any;
const runtime = { id: 'owner', status: 'ready', hostWindow: owner, contextWindow: owner, events: new EventTarget() } as any;
initializeWindowRuntime(runtime);

function note(key: string, libraryID = 1): any {
    return { key, libraryID, isRegularItem: () => false, isAttachment: () => false, isNote: () => true, isAnnotation: () => false };
}
beforeEach(() => {
    vi.clearAllMocks();
    owner.closed = false;
    runtime.status = 'ready';
    selected.mockReturnValue([]);
    vi.stubGlobal('Zotero', { getMainWindow: vi.fn(() => ({ ZoteroPane: { getSelectedItems: () => [note('FOREIGN')] } })), Libraries: { userLibraryID: 1 } });
});

it.each(['closing', 'closed'])('ignores a late selection update when its owner is %s', async state => {
    const store = createStore();
    const draft = [note('EXISTING')];
    store.set(currentMessageItemsAtom, draft);
    if (state === 'closing') runtime.status = 'closing';
    else owner.closed = true;
    await expect(store.set(updateMessageItemsFromZoteroSelectionAtom)).resolves.toBeUndefined();
    expect(selected).not.toHaveBeenCalled();
    expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    expect(store.get(currentMessageItemsAtom)).toEqual(draft);
    expect(validate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
});

it('stages only the live owner selection and preserves exclusions and existing draft sources', async () => {
    const store = createStore();
    const included = note('INCLUDED');
    const existing = note('EXISTING');
    selected.mockReturnValue([included, note('EXCLUDED', 2), existing]);
    store.set(currentMessageItemsAtom, [existing]);
    await store.set(updateMessageItemsFromZoteroSelectionAtom);
    expect(store.get(currentMessageItemsAtom)).toEqual([existing, included]);
    expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ libraryIDs: [2] }));
});
