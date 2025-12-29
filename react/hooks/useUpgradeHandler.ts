import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { isAuthenticatedAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { performConsistencyCheck } from '../../src/utils/syncConsistency';
import { syncCollectionsOnly } from '../../src/utils/sync';
import { version } from '../../package.json';
import { logger } from '../../src/utils/logger';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { getPendingVersionNotifications, removePendingVersionNotification } from '../../src/utils/versionNotificationPrefs';
import { getVersionUpdateMessageConfig } from '../constants/versionUpdateMessages';
import { syncLibraryIdsAtom, syncWithZoteroAtom } from '../atoms/profile';
import { getStorageModeForLibrary } from '../../src/utils/webAPI';
import { retryUploads } from '../../src/services/FileUploader';

/**
 * Hook to handle tasks that need to run after a plugin upgrade.
 * This runs in the React context, ensuring all APIs are available.
 */
export const useUpgradeHandler = () => {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasRunConsistencyCheckRef = useRef(false);
    const hasRunCollectionSyncRef = useRef(false);
    const hasRunWebDAVSyncRef = useRef(false);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    const syncWithZotero = useAtomValue(syncWithZoteroAtom);
    const processedVersionsRef = useRef<Set<string>>(new Set());
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    // Run consistency check after upgrade
    useEffect(() => {
        const runUpgradeTasks = async () => {
            if (!isAuthenticated || hasRunConsistencyCheckRef.current) return;

            const needsCheck = getPref('runConsistencyCheck');
            if (!needsCheck) return;
            
            // Mark as run to prevent re-execution in the same session
            hasRunConsistencyCheckRef.current = true;
            logger(`useUpgradeHandler: Running consistency check for synced libraries after upgrade to ${version}.`);

            try {
                const { profile } = await accountService.getProfileWithPlan();
                if (profile && profile.libraries) {
                    const promises = profile.libraries.map(library => 
                        performConsistencyCheck(library.library_id)
                    );
                    await Promise.all(promises);
                    logger("useUpgradeHandler: Consistency check completed for all synced libraries.");
                }
            } catch (error) {
                logger(`useUpgradeHandler: Could not run consistency check on upgrade: ${error}`, 1);
                Zotero.logError(error as Error);
            } finally {
                // Unset the flag regardless of success or failure to prevent re-running
                setPref('runConsistencyCheck', false);
            }
        };

        runUpgradeTasks();

    }, [isAuthenticated]);

    // Run collection sync after version upgrade and full consistency for non-Zotero synced libraries
    useEffect(() => {
        const runCollectionSync = async () => {
            if (!isAuthenticated || !syncLibraryIds || syncLibraryIds.length === 0 || hasRunCollectionSyncRef.current) return;

            const needsCollectionSync = getPref('runCollectionSync');
            if (!needsCollectionSync) return;
            
            // Mark as run to prevent re-execution in the same session
            hasRunCollectionSyncRef.current = true;
            logger(`useUpgradeHandler: Running collection sync after upgrade to ${version}.`);

            try {
                if (syncWithZotero) {
                    await syncCollectionsOnly(syncLibraryIds);
                    logger("useUpgradeHandler: Full collection sync completed for all synced libraries.");
                } else {
                    for (const libraryID of syncLibraryIds) {
                        await performConsistencyCheck(libraryID);
                    }
                    logger("useUpgradeHandler: Full collection sync and consistency check completed for all synced libraries.");
                }
            } catch (error) {
                logger(`useUpgradeHandler: Could not run collection sync on upgrade: ${error}`, 1);
                Zotero.logError(error as Error);
            } finally {
                // Unset the flag regardless of success or failure to prevent re-running
                setPref('runCollectionSync', false);
            }
        };

        runCollectionSync();

    }, [isAuthenticated, syncLibraryIds, syncWithZotero]);

    // Run retry uploads for WebDAV users after upgrade
    useEffect(() => {
        const runWebDAVRetryUploads = async () => {
            if (!isAuthenticated || !syncLibraryIds || syncLibraryIds.length === 0 || hasRunWebDAVSyncRef.current) return;

            const needsWebDAVSync = getPref('runWebDAVSync');
            if (!needsWebDAVSync) return;

            // Check if primary library (ID 1) is being synced
            if (!syncLibraryIds.includes(1)) {
                // Primary library not synced, clear the flag
                setPref('runWebDAVSync', false);
                return;
            }

            // Check if primary library uses WebDAV
            const storageMode = getStorageModeForLibrary(1);
            if (storageMode !== 'webdav') {
                // Not using WebDAV, clear the flag
                setPref('runWebDAVSync', false);
                return;
            }

            // Mark as run to prevent re-execution in the same session
            hasRunWebDAVSyncRef.current = true;
            logger(`useUpgradeHandler: Running retry uploads for WebDAV primary library after upgrade to ${version}.`);

            try {
                await retryUploads(true);
                logger("useUpgradeHandler: Retry uploads completed for WebDAV primary library.");
            } catch (error) {
                logger(`useUpgradeHandler: Could not run retry uploads for WebDAV on upgrade: ${error}`, 1);
                Zotero.logError(error as Error);
            } finally {
                // Unset the flag regardless of success or failure to prevent re-running
                setPref('runWebDAVSync', false);
            }
        };

        runWebDAVRetryUploads();

    }, [isAuthenticated, syncLibraryIds]);

    // Run version notification popup after upgrade
    useEffect(() => {
        if (!isAuthenticated) {
            return;
        }

        const pendingVersions = getPendingVersionNotifications();
        if (!pendingVersions.length) {
            return;
        }

        pendingVersions.forEach((pendingVersion) => {
            const config = getVersionUpdateMessageConfig(pendingVersion);
            if (!config) {
                logger(`useUpgradeHandler: No popup configuration found for version ${pendingVersion}. Removing pending entry.`, 2);
                removePendingVersionNotification(pendingVersion);
                return;
            }

            if (processedVersionsRef.current.has(config.version)) {
                removePendingVersionNotification(pendingVersion);
                return;
            }

            processedVersionsRef.current.add(config.version);
            logger(`useUpgradeHandler: Displaying release notes popup for version ${config.version}.`, 3);

            addPopupMessage({
                type: 'version_update',
                title: config.title,
                text: config.text,
                featureList: config.featureList,
                learnMoreUrl: config.learnMoreUrl,
                learnMoreLabel: config.learnMoreLabel,
                footer: config.footer,
                expire: false,
            });

            removePendingVersionNotification(pendingVersion);
        });

    }, [isAuthenticated, addPopupMessage]);
};
