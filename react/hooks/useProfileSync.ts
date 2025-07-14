import { useEffect, useRef, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { fileUploader } from '../../src/services/FileUploader';
import { isProfileInvalidAtom, isProfileLoadedAtom, profileWithPlanAtom } from '../atoms/profile';
import { isAuthenticatedAtom, logoutAtom, userAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { logger } from '../../src/utils/logger';
import { ZoteroInstanceMismatchError, ServerError } from '../../react/types/apiErrors';
import { setModelsAtom } from '../atoms/models';
import { isSidebarVisibleAtom, isPreferencePageVisibleAtom } from '../atoms/ui';
import { getPref, setPref } from '../../src/utils/prefs';
import { planTransitionMessage } from '../utils/planTransitionMessage';

const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

/**
 * Hook to synchronize the user's profile and plan data (ProfileWithPlan)
 * with the backend. Provides periodic refresh when sidebar is open and
 * manual refresh capability.
 */
export const useProfileSync = () => {
    const setProfileWithPlan = useSetAtom(profileWithPlanAtom);
    const setIsProfileLoaded = useSetAtom(isProfileLoadedAtom);
    const setIsProfileInvalid = useSetAtom(isProfileInvalidAtom);
    const setModels = useSetAtom(setModelsAtom);
    const logout = useSetAtom(logoutAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const user = useAtomValue(userAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);
    const lastRefreshRef = useRef<Date | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);

    const syncProfileData = useCallback(async (userId: string) => {
        logger(`useProfileSync: Fetching profile and plan for ${userId}.`);
        try {
            const profileData = await accountService.getProfileWithPlan();
            setProfileWithPlan(profileData.profile);
            setIsProfileLoaded(true);
            setIsProfileInvalid(false);
            setModels(profileData.model_configs);
            lastRefreshRef.current = new Date();
            logger(`useProfileSync: Successfully fetched profile and plan for ${userId}.`);

            // Plan change handling
            const currentPlanId = getPref("currentPlanId");
            if (currentPlanId === "") {
                setPref("currentPlanId", profileData.profile.current_plan_id);
            } else if (currentPlanId !== profileData.profile.current_plan_id) {
                logger(`useProfileSync: Plan changed from ${currentPlanId} to ${profileData.profile.current_plan_id} (${profileData.profile.plan.display_name}).`);
                setPref("currentPlanId", profileData.profile.current_plan_id);
                planTransitionMessage(profileData.profile);
            }

            // If the plan allows file uploads, start the file uploader
            if (profileData.profile.plan.upload_files && profileData.profile.has_authorized_access) {
                await fileUploader.start();
            } else {
                await fileUploader.stop();
            }
        } catch (error: any) {
            if (error instanceof ZoteroInstanceMismatchError) {
                logger(`useProfileSync: Zotero instance mismatch for ${userId}. Signing out user.`, 2);
                setIsProfileInvalid(true);
                logout();
                return;
            } else if (error instanceof ServerError) {
                logger(`useProfileSync: Server error during fetch for ${userId}: ${error.message}`, 3);
                setProfileWithPlan(null);
                setIsProfileLoaded(false);
            } else {
                logger(`useProfileSync: Error during fetch for ${userId}: ${error?.message}`, 3);
                setProfileWithPlan(null);
                setIsProfileLoaded(false);
            }
        }
    }, [setProfileWithPlan, setIsProfileLoaded, setIsProfileInvalid, setModels, logout]);

    const refreshProfile = useCallback(async (force = false) => {
        if (!user) return;
        
        // Skip if recently refreshed and not forced
        if (!force && lastRefreshRef.current && 
            Date.now() - lastRefreshRef.current.getTime() < REFRESH_INTERVAL) {
            return;
        }
        
        await syncProfileData(user.id);
    }, [user, syncProfileData]);

    // Initial fetch on authentication
    useEffect(() => {
        if (isAuthenticated && user) {
            syncProfileData(user.id);
        } else {
            logger(`useProfileSync: User not authenticated or user data unavailable.`);
        }
    }, [isAuthenticated, user, syncProfileData]);

    // Periodic refresh when sidebar is visible
    useEffect(() => {
        if (!isAuthenticated || !user || !isSidebarVisible) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }

        // Refresh immediately if sidebar just opened and it's been a while
        if (lastRefreshRef.current && 
            Date.now() - lastRefreshRef.current.getTime() >= REFRESH_INTERVAL) {
            refreshProfile();
        }

        // Set up periodic refresh
        intervalRef.current = setInterval(() => {
            refreshProfile();
        }, REFRESH_INTERVAL);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [isAuthenticated, user, isSidebarVisible, refreshProfile]);

    // Refresh when preference page opens
    useEffect(() => {
        if (isAuthenticated && user && isPreferencePageVisible) {
            refreshProfile(true); // Force refresh when settings page opens
        }
    }, [isAuthenticated, user, isPreferencePageVisible, refreshProfile]);

    return { refreshProfile };
};