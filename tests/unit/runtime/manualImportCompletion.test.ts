import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ runtime: { id: 'A', status: 'attached' }, imports: vi.fn(), emit: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => state.runtime }));
vi.mock('../../../react/utils/attachmentResolvedEvent', () => ({ emitAttachmentResolved: state.emit }));
vi.mock('../../../src/services/itemImport', async importOriginal => ({ ...await importOriginal<any>(), applyCreateItemData: state.imports }));
import { executeCreateItemAction, executeCreateItemActions } from '../../../react/utils/createItemActions';
import { installMutationInstance } from '../../helpers/mutationInstance';

beforeEach(() => {
    vi.clearAllMocks();
    state.runtime = { id: 'A', status: 'attached' };
    (Zotero as any).Beaver = { account: { getGeneration: () => 1 } };
    installMutationInstance();
    state.imports.mockResolvedValue({ library_id: 1, zotero_key: 'ITEMAAAA' });
});

it.each(['single', 'batch'])('passes identified, guarded background completion through %s manual imports', async mode => {
    const actions = ['action-A', 'action-B'].map(id => ({ id, proposed_data: { library_id: 1, item: { title: id } } } as any));
    const options = { runId: 'run-A', threadId: 'thread-A' };
    if (mode === 'single') await executeCreateItemAction(actions[0], options);
    else await executeCreateItemActions(actions, options);
    expect(state.imports).toHaveBeenCalledTimes(mode === 'single' ? 1 : 2);
    for (const [index, call] of state.imports.mock.calls.entries()) {
        const supplied = call[1];
        expect(supplied).toMatchObject({ ...options, actionId: actions[index].id });
        const payload = { threadId: supplied.threadId, actionId: supplied.actionId, libraryId: 1, zoteroKey: 'ITEMAAAA', attachmentStatus: 'available' };
        supplied.onAttachmentResolved(payload);
        expect(state.emit).toHaveBeenLastCalledWith(payload);
    }
    state.emit.mockClear();
    state.runtime.status = 'closing';
    state.imports.mock.calls[0][1].onAttachmentResolved({});
    expect(state.emit).not.toHaveBeenCalled();
    state.runtime.status = 'attached';
    (Zotero as any).Beaver.account.getGeneration = () => 2;
    state.imports.mock.calls[0][1].onAttachmentResolved({});
    expect(state.emit).not.toHaveBeenCalled();
});
