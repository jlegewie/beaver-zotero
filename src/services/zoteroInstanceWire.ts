import type { ZoteroInstanceWire } from './agentProtocol';
import { getInstanceLibraryRefs, getZoteroUserIdentifier } from '../utils/zoteroUtils';

/**
 * Build the snake_case Zotero instance identity sent in auth handshakes.
 * `libraries` is always present; an empty array means no libraries are searchable.
 */
export function buildZoteroInstanceWire(searchableLibraryIds: number[]): ZoteroInstanceWire {
    const zid = getZoteroUserIdentifier();
    const libraries = getInstanceLibraryRefs(searchableLibraryIds);
    return {
        local_user_key: zid.localUserKey,
        ...(zid.userID ? { user_id: zid.userID } : {}),
        ...(zid.accountName ? { account_name: zid.accountName } : {}),
        ...(zid.deviceName ? { device_name: zid.deviceName } : {}),
        libraries,
    };
}
