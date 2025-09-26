import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { isAuthenticatedAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { performConsistencyCheck } from '../../src/utils/syncConsistency';
import { version } from '../../package.json';
import { logger } from '../../src/utils/logger';

/**
 * Hook to handle tasks that need to run after a plugin upgrade.
 * This runs in the React context, ensuring all APIs are available.
 */
export const useUpgradeHandler = () => {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasRunCheckRef = useRef(false);

    useEffect(() => {
        const runUpgradeTasks = async () => {
            if (!isAuthenticated || hasRunCheckRef.current) return;

            const needsCheck = getPref('runConsistencyCheck');
            if (!needsCheck) return;
            
            // Mark as run to prevent re-execution in the same session
            hasRunCheckRef.current = true;
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
};
