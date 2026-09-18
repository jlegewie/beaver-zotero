import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/services/zoteroInstanceWire', () => ({ buildZoteroInstanceWire: () => ({ local_user_key: 'test', index_scope_refs: [] }) }));
import { registerZoteroClientIdentity } from '../../../src/services/zoteroClientIdentity';
import { resolveClientIdentity } from '@beaver/agent-core/transport/clientIdentity';
import { CLIENT_FEATURES } from '@beaver/agent-core/protocol/agentProtocol';

beforeEach(() => {
    vi.stubGlobal('Zotero', { Beaver: { pluginVersion: 'test', searchableLibraryIds: [] } });
});
it('advertises collection support through the identity shared by chat and provider authentication', () => {
    registerZoteroClientIdentity();
    expect(resolveClientIdentity().clientFeatures).toContain(CLIENT_FEATURES.COLLECTION_IDS);
    expect(CLIENT_FEATURES.COLLECTION_IDS).not.toBe(CLIENT_FEATURES.PORTABLE_IDS);
});
