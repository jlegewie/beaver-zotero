import { logger } from '../../../src/utils/logger';

/**
 * Open a locally stored external-file copy by its ext key.
 *
 * Quiet no-op when the file was attached on another computer (no local copy on
 * this machine). Shared by citation activation and the cited-sources list.
 */
export async function launchExternalFile(extKey: string): Promise<void> {
    try {
        const record = await Zotero.Beaver?.db?.getExternalFileByKey(extKey);
        const path = record?.storedPath ?? null;
        if (path && (await IOUtils.exists(path).catch(() => false))) {
            Zotero.launchFile(path);
        } else {
            logger(`launchExternalFile: ext-${extKey} has no local copy`);
        }
    } catch (e) {
        logger(`launchExternalFile: failed to open external file: ${e}`, 2);
    }
}
