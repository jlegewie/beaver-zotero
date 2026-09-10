/**
 * Dev-only HTTP handler for the release notes popup.
 *
 * `/beaver/test/version-popup` shows a version's release note without an
 * upgrade: `{ version?: '0.25.0', inPanel?: boolean }` draws it (the newest
 * configured version by default, where its config says unless overridden),
 * and `{ clear: true }` takes it down. Wired to its path in
 * `useHttpEndpoints.ts`.
 */

import { store } from '../../store';
import { addPopupMessageAtom, removePopupMessageAtom } from '../../utils/popupMessageUtils';
import { addFloatingPopupMessageAtom, removeFloatingPopupMessageAtom } from '../../atoms/floatingPopup';
import { getAllVersionUpdateMessageVersions, getVersionUpdateMessageConfig } from '../../constants/versionUpdateMessages';
import { versionUpdatePopupMessage } from '../../utils/versionUpdatePopup';

const MESSAGE_ID = 'dev:version-popup';

export async function handleTestVersionPopupHttpRequest(request: any): Promise<any> {
    store.set(removePopupMessageAtom, MESSAGE_ID);
    store.set(removeFloatingPopupMessageAtom, MESSAGE_ID);
    if (request?.clear) return { shown: null };

    const versions = getAllVersionUpdateMessageVersions();
    const version = typeof request?.version === 'string' ? request.version : versions[versions.length - 1];
    const config = getVersionUpdateMessageConfig(version);
    if (!config) throw new Error(`No release note for version ${version} (known: ${versions.join(', ')})`);

    const inPanel = typeof request?.inPanel === 'boolean' ? request.inPanel : !!config.inPanel;
    store.set(inPanel ? addPopupMessageAtom : addFloatingPopupMessageAtom, {
        ...versionUpdatePopupMessage(config),
        id: MESSAGE_ID,
    });
    return { shown: { version, inPanel } };
}
