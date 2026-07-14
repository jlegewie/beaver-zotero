import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { setPref } from '../../src/utils/prefs';
import { logger } from '../../src/utils/logger';
import { addFloatingPopupMessageAtom } from '../atoms/floatingPopup';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { getPendingVersionNotifications, clearPendingVersionNotifications } from '../../src/utils/versionNotificationPrefs';
import { compareVersions } from '../../src/utils/compareVersions';
import { getVersionUpdateMessageConfig } from '../constants/versionUpdateMessages';

/**
 * Hook to handle tasks that need to run after a plugin upgrade.
 * This runs in the React context, ensuring all APIs are available.
 */
export const useUpgradeHandler = () => {
    const processedVersionsRef = useRef<Set<string>>(new Set());
    const addFloatingPopupMessage = useSetAtom(addFloatingPopupMessageAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    // Run version notification popup after upgrade — show the most recent floating
    // and the most recent in-panel version separately.
    // No auth guard: floating popups are used to re-engage lapsed/unauthenticated users too.
    useEffect(() => {
        const pendingVersions = getPendingVersionNotifications();
        if (!pendingVersions.length) {
            return;
        }

        // Sort descending to find the most recent version
        const sorted = [...pendingVersions].sort((a, b) => compareVersions(b, a));

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

            // Record when the version popup is shown so onboarding tips can enforce a gap after it
            setPref('versionUpdatePopupShownAt', new Date().toISOString());

            addFloatingPopupMessage({
                type: 'version_update',
                version: latestFloating.version,
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
                version: latestInPanel.version,
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
