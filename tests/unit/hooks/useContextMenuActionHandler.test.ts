import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handler: undefined as any, current: true, begin: vi.fn(), items: vi.fn(), collections: vi.fn(), views: vi.fn(), stage: vi.fn() }));
vi.mock('jotai', () => ({ useSetAtom: (atom: any) => atom, useAtomValue: (atom: any) => atom }));
vi.mock('../../../react/atoms/auth', () => ({ userAtom: { id: 'user' } }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: [1] }));
vi.mock('../../../react/atoms/threads', () => ({ newThreadAtom: vi.fn() }));
vi.mock('../../../react/atoms/messageComposition', () => ({ currentMessageItemsAtom: mocks.items, currentMessageCollectionsAtom: mocks.collections, currentMessageViewsAtom: mocks.views }));
vi.mock('../../../react/atoms/actions', () => ({ stageActionPillAtom: mocks.stage }));
vi.mock('../../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: vi.fn() }));
vi.mock('../../../react/utils/zoteroReferences', () => ({
    collectionToReference: vi.fn(),
    viewToAttachment: (view: any) => ({ type: 'special_collection', special_collection: view.type, library_id: view.libraryId, name: view.name }),
}));
vi.mock('../../../react/utils/beginReaderActionThread', () => ({ beginReaderActionThread: mocks.begin }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: () => ({}) }));
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: vi.fn() } }));
vi.mock('../../../react/hooks/useEventSubscription', () => ({ useEventSubscription: (_name: any, handler: any) => { mocks.handler = handler; } }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { useContextMenuActionHandler } from '../../../react/hooks/useContextMenuActionHandler';
import { addPopupMessageAtom } from '../../../react/utils/popupMessageUtils';
const detail = { actionId: 'action', actionTitle: 'Action', targetType: 'item', itemIds: [42], collections: [] };
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); mocks.current = true;
    mocks.begin.mockResolvedValue(() => mocks.current);
    vi.stubGlobal('Zotero', { Items: {
        getAsync: vi.fn(async () => [{ id: 42, isNote: () => false }]),
        loadDataTypes: vi.fn(async () => {}),
    } });
    useContextMenuActionHandler();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('leaves the composer alone after cancelling new-thread confirmation', async () => {
    mocks.begin.mockResolvedValue(null);
    await mocks.handler(detail); await vi.runAllTimersAsync();
    expect(Zotero.Items.getAsync).not.toHaveBeenCalled();
    expect(mocks.items).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
});
it('does not stage an action after navigation during item hydration', async () => {
    vi.mocked(Zotero.Items.loadDataTypes).mockImplementation(async () => { mocks.current = false; });
    await mocks.handler(detail); await vi.runAllTimersAsync();
    expect(mocks.items).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
});
it('stages the action when its navigation remains current', async () => {
    await mocks.handler(detail); await vi.runAllTimersAsync();
    expect(mocks.items).toHaveBeenCalledOnce();
    expect(mocks.stage).toHaveBeenCalledOnce();
});
it('attaches the right-clicked special view and binds the action to it', async () => {
    await mocks.handler({
        ...detail, targetType: 'collection', itemIds: [],
        views: [{ libraryId: 1, type: 'unfiled', name: 'Unfiled Items' }],
    });
    await vi.runAllTimersAsync();
    const view = { type: 'special_collection', special_collection: 'unfiled', library_id: 1, name: 'Unfiled Items' };
    expect(addPopupMessageAtom).not.toHaveBeenCalled();
    expect(mocks.collections).not.toHaveBeenCalled();
    expect(mocks.views).toHaveBeenCalledWith([view]);
    expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({
        targetType: 'collection',
        contextOverride: { items: [], collections: [], views: [view] },
    }));
});
it('refuses a collection action over a view in an excluded library', async () => {
    await mocks.handler({ ...detail, targetType: 'collection', itemIds: [], views: [{ libraryId: 3, type: 'unfiled', name: 'Unfiled Items' }] });
    await vi.runAllTimersAsync();
    expect(addPopupMessageAtom).toHaveBeenCalledOnce();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
});
