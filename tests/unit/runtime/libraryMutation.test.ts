import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ runtime: { id: 'A', status: 'attached' } }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => state.runtime }));
import { runWindowOperation } from '../../../react/runtime/libraryMutation';
import { LibraryMutations } from '../../../src/services/libraryMutations';
import { LibraryOperations } from '../../../src/services/libraryOperations';
const work = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/services/savePreparedNote', () => ({ savePreparedNote: work }));

beforeEach(() => {
    state.runtime = { id: 'A', status: 'attached' };
    (Zotero as any).Beaver = { mutations: new LibraryMutations(), libraryOperations: new LibraryOperations() };
});

it('pins waiting manual work to the origin and cancels it when that window closes', async () => {
    let release!: () => void;
    const first = Zotero.Beaver.mutations.run(() => new Promise<void>(resolve => { release = resolve; }));
    work.mockClear();
    const waiting = runWindowOperation('savePreparedNote', [{ libraryId: 1, html: 'note' }]);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'operation_cancelled' });
    state.runtime.status = 'closing';
    state.runtime = { id: 'B', status: 'attached' };
    release();
    await Promise.all([first, rejected]);
    expect(work).not.toHaveBeenCalled();
    await runWindowOperation('savePreparedNote', [{ libraryId: 1, html: 'note' }]);
    expect(work).toHaveBeenCalledTimes(1);
});
