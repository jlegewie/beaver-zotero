import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { isAuthenticatedAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { performConsistencyCheck } from '../../src/utils/syncConsistency';
import { syncCollectionsOnly } from '../../src/utils/sync';
import { version } from '../../package.json';
import { logger } from '../../src/utils/logger';
import { addFloatingPopupMessageAtom } from '../atoms/floatingPopup';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { getPendingVersionNotifications, clearPendingVersionNotifications } from '../../src/utils/versionNotificationPrefs';
import { getVersionUpdateMessageConfig } from '../constants/versionUpdateMessages';
import { isDatabaseSyncSupportedAtom, profileWithPlanAtom, syncedLibraryIdsAtom, syncWithZoteroAtom } from '../atoms/profile';
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
    const syncedLibraryIds = useAtomValue(syncedLibraryIdsAtom);
    const syncWithZotero = useAtomValue(syncWithZoteroAtom);
    const processedVersionsRef = useRef<Set<string>>(new Set());
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const profile = useAtomValue(profileWithPlanAtom);
    const addFloatingPopupMessage = useSetAtom(addFloatingPopupMessageAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    // Run consistency check after upgrade
    useEffect(() => {
        const runUpgradeTasks = async () => {
            if (!isAuthenticated || hasRunConsistencyCheckRef.current || profile === null) return;
            
            const needsCheck = getPref('runConsistencyCheck');
            if (!needsCheck) return;

            // If database sync is not supported, clear the flag and return
            if (!isDatabaseSyncSupported) {
                if (needsCheck) {
                    setPref('runConsistencyCheck', false);
                }
                return;
            }
            
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

    }, [isAuthenticated, profile, isDatabaseSyncSupported]);

    // Run collection sync after version upgrade and full consistency for non-Zotero synced libraries
    useEffect(() => {
        const runCollectionSync = async () => {
            if (!isAuthenticated || profile === null || !syncedLibraryIds || syncedLibraryIds.length === 0 || hasRunCollectionSyncRef.current) return;

            const needsCollectionSync = getPref('runCollectionSync');
            if (!needsCollectionSync) return;

            // If database sync is not supported, clear the flag and return
            if (!isDatabaseSyncSupported) {
                if (needsCollectionSync) {
                    setPref('runCollectionSync', false);
                }
                return;
            }
            
            // Mark as run to prevent re-execution in the same session
            hasRunCollectionSyncRef.current = true;
            logger(`useUpgradeHandler: Running collection sync after upgrade to ${version}.`);

            try {
                if (syncWithZotero) {
                    await syncCollectionsOnly(syncedLibraryIds);
                    logger("useUpgradeHandler: Full collection sync completed for all synced libraries.");
                } else {
                    for (const libraryID of syncedLibraryIds) {
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

    }, [isAuthenticated, profile, syncedLibraryIds, syncWithZotero, isDatabaseSyncSupported]);

    // Run retry uploads for WebDAV users after upgrade
    useEffect(() => {
        const runWebDAVRetryUploads = async () => {
            if (!isAuthenticated || profile === null || !syncedLibraryIds || syncedLibraryIds.length === 0 || hasRunWebDAVSyncRef.current) return;

            const needsWebDAVSync = getPref('runWebDAVSync');
            if (!needsWebDAVSync) return;

            // If database sync is not supported, clear the flag and return
            if (!isDatabaseSyncSupported) {
                if (needsWebDAVSync) {
                    setPref('runWebDAVSync', false);
                }
                return;
            }

            // Check if primary library (ID 1) is being synced
            if (!syncedLibraryIds.includes(1)) {
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

    }, [isAuthenticated, profile, syncedLibraryIds, isDatabaseSyncSupported]);

    // Run version notification popup after upgrade — show the most recent floating
    // and the most recent in-panel version separately.
    // No auth guard: floating popups are used to re-engage lapsed/unauthenticated users too.
    useEffect(() => {
        const pendingVersions = getPendingVersionNotifications();
        if (!pendingVersions.length) {
            return;
        }

        // Sort descending to find the most recent version
        const sorted = [...pendingVersions].sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
                if (diff !== 0) return diff;
            }
            return 0;
        });

        // Clear all pending notifications regardless
        clearPendingVersionNotifications();

        // Resolve configs and split by display mode
        const configs = sorted
            .map(v => getVersionUpdateMessageConfig(v))
            .filter((c): c is NonNullable<typeof c> => !!c)
            .filter(c => !processedVersionsRef.current.has(c.version));

        const latestFloating = configs.find(c => !c.inPanel);
        const latestInPanel = configs.find(c => c.inPanel);

        if (latestFloating) {
            processedVersionsRef.current.add(latestFloating.version);
            logger(`useUpgradeHandler: Displaying floating release notes popup for version ${latestFloating.version}.`, 3);

            addFloatingPopupMessage({
                type: 'version_update',
                title: latestFloating.title,
                text: latestFloating.text,
                featureList: latestFloating.featureList,
                learnMoreUrl: latestFloating.learnMoreUrl,
                learnMoreLabel: latestFloating.learnMoreLabel,
                footer: latestFloating.footer,
                steps: latestFloating.steps,
                subtitle: latestFloating.subtitle,
                expire: false,
            });
        }

        if (latestInPanel) {
            processedVersionsRef.current.add(latestInPanel.version);
            logger(`useUpgradeHandler: Displaying in-panel release notes for version ${latestInPanel.version}.`, 3);

            addPopupMessage({
                type: 'version_update',
                title: latestInPanel.title,
                text: latestInPanel.text,
                featureList: latestInPanel.featureList,
                learnMoreUrl: latestInPanel.learnMoreUrl,
                learnMoreLabel: latestInPanel.learnMoreLabel,
                footer: latestInPanel.footer,
                steps: latestInPanel.steps,
                subtitle: latestInPanel.subtitle,
                expire: false,
            });
        }

        if (!latestFloating && !latestInPanel && sorted.length > 0) {
            logger(`useUpgradeHandler: No popup configuration found for pending versions. Skipping.`, 2);
        }

    }, [addFloatingPopupMessage, addPopupMessage]);
};
