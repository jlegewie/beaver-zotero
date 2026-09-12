import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('../../../react/store', () => ({ store: { set: mocks.set } }));
vi.mock('../../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: {} }));
import { notifyWorkerStartFailure } from '../../../react/utils/workerUnavailableNotice';

beforeEach(() => {
    mocks.set.mockReset();
    const claims = new Set<string>();
    (Zotero as any).Beaver = { background: { claimNotification: vi.fn((key: string) => {
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
    }) } };
});

it('claims an eligible failure once when multiple renderers receive it', () => {
    notifyWorkerStartFailure({ slotName: 'background', consecutiveFailures: 3, reason: 'failed' });
    notifyWorkerStartFailure({ slotName: 'hot', consecutiveFailures: 2, reason: 'failed' });
    expect(Zotero.Beaver.background!.claimNotification).not.toHaveBeenCalled();
    const failure = { slotName: 'hot' as const, consecutiveFailures: 3, reason: 'failed' };
    notifyWorkerStartFailure(failure);
    notifyWorkerStartFailure(failure);
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(Zotero.Beaver.background!.claimNotification).toHaveBeenCalledWith('worker-unavailable', 600_000);
});
