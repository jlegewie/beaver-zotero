import { logger } from '../../../src/utils/logger';
import { store } from '../../store';
import { addPopupMessageAtom } from '../../utils/popupMessageUtils';

/** Surface a transient warning when an external file can't be opened here. */
function notifyExternalFileUnavailable(): void {
    try {
        store.set(addPopupMessageAtom, {
            id: 'external-file-unavailable',
            type: 'warning',
            title: 'File Not Available',
            text: 'This file is not available on this computer. It was removed or attached on another device.',
        });
    } catch (e) {
        logger(`notifyExternalFileUnavailable: failed to surface popup: ${e}`, 2);
    }
}

/**
 * A navigation target (item, collection, annotation) that was rendered from
 * persisted run history but is no longer in the Zotero library.
 */
export type UnavailableReferenceKind = 'item' | 'collection' | 'annotation';

const UNAVAILABLE_REFERENCE_COPY: Record<UnavailableReferenceKind, { title: string; text: string }> = {
    item: {
        title: 'Item Not Available',
        text: 'This item is no longer in your Zotero library. It may have been deleted.',
    },
    collection: {
        title: 'Collection Not Available',
        text: 'This collection is no longer in your Zotero library. It may have been deleted.',
    },
    annotation: {
        title: 'Annotation Not Available',
        text: 'This annotation is no longer in your Zotero library. It may have been deleted.',
    },
};

/**
 * Surface a transient warning when a reveal/open target no longer exists.
 *
 * Request chips and other history-rendered surfaces are built from persisted
 * data, so their targets can be deleted between when a run was saved and when
 * the user clicks. Mirrors {@link notifyExternalFileUnavailable}.
 */
export function notifyReferenceUnavailable(kind: UnavailableReferenceKind): void {
    const { title, text } = UNAVAILABLE_REFERENCE_COPY[kind];
    try {
        store.set(addPopupMessageAtom, {
            id: `reference-unavailable-${kind}`,
            type: 'warning',
            title,
            text,
        });
    } catch (e) {
        logger(`notifyReferenceUnavailable: failed to surface popup: ${e}`, 2);
    }
}

/**
 * Open a locally stored external-file copy by its ext key.
 *
 * Warns the user when the file was attached on another computer (no local copy
 * on this machine). Shared by citation activation and the cited-sources list.
 */
export async function launchExternalFile(extKey: string): Promise<void> {
    try {
        const record = await Zotero.Beaver?.db?.getExternalFileByKey(extKey);
        const path = record?.storedPath ?? null;
        if (path && (await IOUtils.exists(path).catch(() => false))) {
            Zotero.launchFile(path);
        } else {
            logger(`launchExternalFile: ext-${extKey} has no local copy`);
            notifyExternalFileUnavailable();
        }
    } catch (e) {
        logger(`launchExternalFile: failed to open external file: ${e}`, 2);
        notifyExternalFileUnavailable();
    }
}
