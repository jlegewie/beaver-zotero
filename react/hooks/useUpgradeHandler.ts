import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { isAuthenticatedAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { performConsistencyCheck } from '../../src/utils/syncConsistency';
import { version } from '../../package.json';
import { logger } from '../../src/utils/logger';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { getPendingVersionNotifications, removePendingVersionNotification } from '../../src/utils/versionNotificationPrefs';
import { getVersionUpdateMessageConfig } from '../constants/versionUpdateMessages';

/**
 * Hook to handle tasks that need to run after a plugin upgrade.
 * This runs in the React context, ensuring all APIs are available.
 */
export const useUpgradeHandler = () => {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasRunConsistencyCheckRef = useRef(false);
    const processedVersionsRef = useRef<Set<string>>(new Set());
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

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
                expire: false,
            });

            removePendingVersionNotification(pendingVersion);
        });

    }, [isAuthenticated, addPopupMessage]);
};
