import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    connect: vi.fn(async () => {}), close: vi.fn(), httpRelease: vi.fn(), mcpRelease: vi.fn(),
    http: vi.fn(), mcp: vi.fn(), wakeRelease: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/providerConnection', () => ({ ProviderConnection: class {
    connect = mocks.connect; close = mocks.close;
} }));
vi.mock('../../../src/services/zoteroDataProvider', () => ({ createZoteroDataProvider: vi.fn() }));
vi.mock('../../../src/services/localEndpoints/operation', () => ({ captureInstanceOperation: vi.fn() }));
vi.mock('../../../src/services/localEndpoints/http', () => ({ registerEndpoints: mocks.http }));
vi.mock('../../../src/services/localEndpoints/mcp', () => ({ registerMcpServer: mocks.mcp }));
const prefs: Record<string, boolean> = {};
vi.mock('../../../src/utils/prefs', () => ({ getPref: (key: string) => prefs[key] }));
import { InstanceLocalEndpoints } from '../../../src/services/instanceLocalEndpoints';

function fixture() {
    let snapshot = { generation: 1, session: { user: { id: 'a' } }, data: {}, scopeReady: true } as any;
    let accountListener!: () => void, prefListener!: () => void, wake!: (message: any) => void;
    const releaseAccount = vi.fn(), releasePrefs = vi.fn();
    const account = {
        getSnapshot: () => snapshot, getGeneration: () => snapshot.generation,
        subscribe: vi.fn(fn => { accountListener = fn; fn(); return releaseAccount; }),
        realtime: { subscribe: vi.fn((_topic, _id, fn) => { wake = fn; return mocks.wakeRelease; }) },
    };
    const preferences = { subscribe: vi.fn(fn => { prefListener = fn; return releasePrefs; }) };
    const service = new InstanceLocalEndpoints();
    service.start(account as any, preferences as any);
    return { service, account, preferences, wake: () => wake, change: (next: any) => { snapshot = { ...snapshot, ...next }; accountListener(); }, pref: () => prefListener() };
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.http.mockReturnValue(mocks.httpRelease); mocks.mcp.mockReturnValue(mocks.mcpRelease);
    Object.assign(prefs, { dataProviderEnabled: true, mcpServerEnabled: true, mcpCreateNoteToolEnabled: false });
    (Zotero as any).Beaver = { searchableLibraryIds: [1, 2] };
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('BUILD_ENV', '');
});

describe('instance local ingress', () => {
    it('subscribes once and preserves registrations on same-user updates without any windows', () => {
        const f = fixture();
        f.service.start(f.account as any, f.preferences as any);
        f.change({}); f.pref();
        expect(mocks.http).toHaveBeenCalledTimes(1);
        expect(mocks.mcp).toHaveBeenCalledExactlyOnceWith(false);
        expect(f.account.realtime.subscribe).toHaveBeenCalledTimes(1);
        f.wake()({ payload: { wake_id: 'wake', instance_id: 'backend' } });
        expect(mocks.connect).toHaveBeenCalledWith({ wakeId: 'wake', wakeInstanceId: 'backend' });
        f.service.dispose(); f.service.dispose();
        expect(mocks.httpRelease).toHaveBeenCalledTimes(1);
        expect(mocks.mcpRelease).toHaveBeenCalledTimes(1);
        expect(mocks.wakeRelease).toHaveBeenCalledTimes(1);
    });
    it('revokes wake callbacks on account change, scope removal, preference disable and disposal', () => {
        const f = fixture(), oldWake = f.wake();
        f.change({ generation: 2, session: { user: { id: 'b' } } });
        oldWake({ payload: {} }); expect(mocks.connect).not.toHaveBeenCalled();
        mocks.close.mockClear();
        Zotero.Beaver.searchableLibraryIds = [1]; f.change({});
        expect(mocks.close).toHaveBeenCalled();
        const currentWake = f.wake(); prefs.dataProviderEnabled = false; f.pref();
        currentWake({ payload: {} }); expect(mocks.connect).not.toHaveBeenCalled();
        f.change({ session: null }); expect(mocks.httpRelease).toHaveBeenCalledTimes(1);
        expect(mocks.mcpRelease).not.toHaveBeenCalled();
        f.service.dispose(); currentWake({ payload: {} }); expect(mocks.connect).not.toHaveBeenCalled();
    });
    it('preserves production/staging and MCP preference gates', () => {
        vi.stubEnv('NODE_ENV', 'production'); prefs.mcpServerEnabled = false;
        const f = fixture(); expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.mcp).not.toHaveBeenCalled();
        vi.stubEnv('BUILD_ENV', 'staging'); f.pref(); expect(mocks.http).toHaveBeenCalledTimes(1);
        prefs.mcpServerEnabled = true; prefs.mcpCreateNoteToolEnabled = true; f.pref();
        expect(mocks.mcp).toHaveBeenCalledWith(true);
        prefs.mcpCreateNoteToolEnabled = false; f.pref();
        expect(mocks.mcpRelease).toHaveBeenCalledTimes(1);
        expect(mocks.mcp).toHaveBeenLastCalledWith(false);
        f.service.dispose();
    });
});
