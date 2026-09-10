import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handler: undefined as any, current: true, begin: vi.fn(), items: vi.fn(), collections: vi.fn(), stage: vi.fn() }));
vi.mock('jotai', () => ({ useSetAtom: (atom: any) => atom, useAtomValue: (atom: any) => atom }));
vi.mock('../../../react/atoms/auth', () => ({ userAtom: { id: 'user' } }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: [1] }));
vi.mock('../../../react/atoms/threads', () => ({ newThreadAtom: vi.fn() }));
vi.mock('../../../react/atoms/messageComposition', () => ({ currentMessageItemsAtom: mocks.items, currentMessageCollectionsAtom: mocks.collections }));
vi.mock('../../../react/atoms/actions', () => ({ stageActionPillAtom: mocks.stage }));
vi.mock('../../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: vi.fn() }));
vi.mock('../../../react/utils/zoteroReferences', () => ({ collectionToReference: vi.fn() }));
vi.mock('../../../react/utils/beginReaderActionThread', () => ({ beginReaderActionThread: mocks.begin }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: () => ({}) }));
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: vi.fn() } }));
vi.mock('../../../react/hooks/useEventSubscription', () => ({ useEventSubscription: (_name: any, handler: any) => { mocks.handler = handler; } }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { useContextMenuActionHandler } from '../../../react/hooks/useContextMenuActionHandler';
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
