import { beforeEach, expect, it, vi } from 'vitest';
import { registerEndpoint } from '../../../src/services/localEndpoints/registration';
beforeEach(() => { (Zotero as any).Server = { Endpoints: {} }; });
it('revokes an in-flight response and rejects retained constructors after disposal', async () => {
    let finish!: (value: any) => void;
    const handler = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    class Endpoint { supportedMethods = ['POST']; init = handler; }
    // Zotero endpoint methods are prototype properties.
    Endpoint.prototype.init = handler;
    const release = registerEndpoint('/test', Endpoint);
    const ctor = Zotero.Server.Endpoints['/test'];
    const request = new ctor().init({});
    release();
    finish([200, 'application/json', '{}']);
    expect((await request)[0]).toBe(503);
    expect((await new ctor().init({}))[0]).toBe(503);
    expect(handler).toHaveBeenCalledTimes(1);
});
it('never removes a newer registration during obsolete cleanup', () => {
    class Endpoint { async init() { return [200, 'application/json', '{}']; } }
    const oldRelease = registerEndpoint('/test', Endpoint);
    const release = registerEndpoint('/test', Endpoint);
    const current = Zotero.Server.Endpoints['/test'];
    oldRelease(); expect(Zotero.Server.Endpoints['/test']).toBe(current);
    release(); release(); expect(Zotero.Server.Endpoints['/test']).toBeUndefined();
});

it('rejects late reads after account or library access changes but allows the exclusion command to change scope', async () => {
    const { createEndpoint } = await import('../../../src/services/localEndpoints/registration');
    let generation = 1;
    (Zotero as any).Beaver = { searchableLibraryIds: [1], account: {
        getGeneration: () => generation, getSnapshot: () => ({ session: { user: { id: 'user' } } }),
    } };
    const changedAccount = createEndpoint(async () => { generation++; return { secret: true }; });
    expect(JSON.parse((await new changedAccount().init({ data: {} } as any))[2])).toEqual({ error_code: 'account_changed' });
    const changeScope = async () => { Zotero.Beaver.searchableLibraryIds = []; return { ok: true }; };
    const read = createEndpoint(changeScope);
    expect(JSON.parse((await new read().init({ data: {} } as any))[2])).toEqual({ error_code: 'library_access_changed' });
    Zotero.Beaver.searchableLibraryIds = [1];
    const command = createEndpoint(changeScope, { allowScopeChange: true });
    expect(JSON.parse((await new command().init({ data: {} } as any))[2])).toEqual({ ok: true });
});
