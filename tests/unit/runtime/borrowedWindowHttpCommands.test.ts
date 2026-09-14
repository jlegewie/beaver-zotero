import { beforeEach, expect, it, vi } from 'vitest';
import { handleTestOpenTableHttpRequest, handleTestCloseTableHttpRequest } from '../../../react/hooks/httpHandlers/testTableHandlers';
import { handleTestBeaverWindowHttpRequest } from '../../../react/hooks/httpHandlers/testApplicationStateHandlers';
import { store } from '../../../react/store';
import { BeaverUIFactory } from '../../../src/ui/ui';
import { openBeaverWindow } from '../../../react/ui/openBeaverWindow';

const state = vi.hoisted(() => ({ runtime: undefined as any, existing: undefined as any }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => state.runtime, getContextWindow: () => state.runtime.contextWindow }));
vi.mock('../../../src/ui/ui', () => ({
    BeaverUIFactory: {
        commandBeaverWindow: vi.fn().mockResolvedValue({ ok: true }),
        findBeaverWindow: () => state.existing,
        closeBeaverWindow: vi.fn(),
    },
}));
vi.mock('../../../react/ui/openBeaverWindow', () => ({ openBeaverWindow: vi.fn() }));
vi.mock('../../../react/store', () => ({ store: { set: vi.fn(), get: vi.fn() } }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({ getSearchableLibraryIds: vi.fn(() => []) }));
vi.mock('../../../react/atoms/applicationState', () => ({ getApplicationStateProvider: vi.fn() }));
vi.mock('../../../react/atoms/messageComposition', () => ({ currentReaderAttachmentAtom: {}, isReaderLibrarySearchable: vi.fn(), readerTextSelectionAtom: {} }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: {} }));
vi.mock('../../../react/atoms/ui', () => ({ isBeaverUIVisibleAtom: {}, isBeaverWindowOpenAtom: {}, isLibraryTabAtom: {}, isSidebarVisibleAtom: {} }));
vi.mock('../../../react/atoms/zoteroContext', () => ({ currentNoteItemAtom: {} }));
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: vi.fn() }));

beforeEach(() => {
    vi.clearAllMocks();
    state.runtime = {
        hostWindow: { closed: false },
        contextWindow: { closed: false },
    };
    state.existing = {
        closed: false,
        __beaverRuntime: { kind: "standalone", status: "ready" },
    };
});
it("dispatches a table to the independent renderer without writing its source store", async () => {
    const table = { id: "test", columns: [], rows: [] } as any;
    const result = await handleTestOpenTableHttpRequest({ table });
    expect(result.ok).toBe(true);
    expect(BeaverUIFactory.commandBeaverWindow).toHaveBeenCalledWith(
        "show-table",
        {
            surface: {
                variant: "search",
                table,
                title: undefined,
                subtitle: undefined,
            },
        },
    );
    expect(store.set).not.toHaveBeenCalled();
});
it("returns the standalone to its own preserved chat through a command", async () => {
    await handleTestCloseTableHttpRequest();
    expect(BeaverUIFactory.commandBeaverWindow).toHaveBeenCalledWith(
        "show-chat",
    );
    expect(store.set).not.toHaveBeenCalled();
});
it("propagates target closure instead of falling back to the source store", async () => {
    vi.mocked(BeaverUIFactory.commandBeaverWindow).mockRejectedValueOnce({
        code: "window_unavailable",
    });
    await expect(handleTestCloseTableHttpRequest()).rejects.toMatchObject({
        code: "window_unavailable",
    });
    expect(store.set).not.toHaveBeenCalled();
});
