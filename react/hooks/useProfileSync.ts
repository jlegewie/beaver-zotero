import { useEffect, useRef, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { fileUploader } from '../../src/services/FileUploader';
import { isAuthenticatedAtom, logoutAtom, userAtom, isWaitingForProfileAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { logger } from '../../src/utils/logger';
import { ZoteroInstanceMismatchError, ServerError } from '../../react/types/apiErrors';
import { setModelsAtom } from '../atoms/models';
import { isSidebarVisibleAtom, isPreferencePageVisibleAtom } from '../atoms/ui';
import { serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import {
    isProfileInvalidAtom,
    isProfileLoadedAtom,
    profileWithPlanAtom,
    isMigratingDataAtom,
    requiredDataVersionAtom,
    localZoteroLibrariesAtom,
    minimumFrontendVersionAtom,
    syncDeniedForPlanAtom
} from '../atoms/profile';

// Adaptive refresh intervals based on sidebar visibility
const ACTIVE_REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes when sidebar is visible
const BACKGROUND_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours when sidebar is closed

/**
 * Hook to synchronize the user's profile and plan data (ProfileWithPlan)
 * with the backend. Uses adaptive refresh intervals:
 * - 15 minutes when sidebar is visible (user is active)
 * - 4 hours when sidebar is closed (background check for plan changes)
 */
export const useProfileSync = () => {
    const setProfileWithPlan = useSetAtom(profileWithPlanAtom);
    const setIsProfileLoaded = useSetAtom(isProfileLoadedAtom);
    const setIsProfileInvalid = useSetAtom(isProfileInvalidAtom);
    const setIsWaitingForProfile = useSetAtom(isWaitingForProfileAtom);
    const setModels = useSetAtom(setModelsAtom);
    const setIsMigratingData = useSetAtom(isMigratingDataAtom);
    const setRequiredDataVersion = useSetAtom(requiredDataVersionAtom);
    const setMinimumFrontendVersion = useSetAtom(minimumFrontendVersionAtom);
    const setLocalZoteroLibraries = useSetAtom(localZoteroLibrariesAtom);
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
            
            // Store required data version and minimum frontend version
            setRequiredDataVersion(profileData.required_data_version);
            setMinimumFrontendVersion(profileData.minimum_frontend_version);

            // Check if data migration is needed
            if (profileData.profile.data_version < profileData.required_data_version) {
                logger(`useProfileSync: Data migration required (current: ${profileData.profile.data_version}, required: ${profileData.required_data_version})`);
                setIsMigratingData(true);
                
                try {
                    const migrationResult = await accountService.migrateData();
                    logger(`useProfileSync: Migration completed - ${migrationResult.threads_migrated} threads migrated, ${migrationResult.runs_created} runs created`);
                    
                    if (migrationResult.errors.length > 0) {
                        logger(`useProfileSync: Migration had errors: ${migrationResult.errors.join(', ')}`, 2);
                    }
                    
                    // Re-fetch profile to get updated data_version
                    const updatedProfileData = await accountService.getProfileWithPlan();
                    setProfileWithPlan(updatedProfileData.profile);
                    setModels(updatedProfileData.model_configs);
                } catch (migrationError: any) {
                    logger(`useProfileSync: Migration failed: ${migrationError?.message}`, 3);
                    // Continue with original profile data even if migration fails
                    setProfileWithPlan(profileData.profile);
                    setModels(profileData.model_configs);
                } finally {
                    setIsMigratingData(false);
                }
            } else {
                setProfileWithPlan(profileData.profile);
                setModels(profileData.model_configs);
            }

            setIsProfileLoaded(true);
            setIsProfileInvalid(false);
            setIsWaitingForProfile(false);
            lastRefreshRef.current = new Date();
            logger(`useProfileSync: Successfully fetched profile and plan for ${userId}.`);

            // Populate local Zotero libraries
            try {
                const allLibraries = Zotero.Libraries.getAll();
                const localLibraries = allLibraries
                    .filter(lib => lib.libraryType === 'user' || lib.libraryType === 'group')
                    .map(lib => serializeZoteroLibrary(lib))
                    .filter(lib => lib !== null);
                setLocalZoteroLibraries(localLibraries);
                logger(`useProfileSync: Populated ${localLibraries.length} local libraries.`);
            } catch (libError) {
                logger(`useProfileSync: Failed to populate local libraries: ${libError}`, 2);
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
    }, [setProfileWithPlan, setIsProfileLoaded, setIsProfileInvalid, setIsWaitingForProfile, setModels, setIsMigratingData, setRequiredDataVersion, setMinimumFrontendVersion, setLocalZoteroLibraries, logout]);

    const refreshProfile = useCallback(async (force = false) => {
        if (!user) return;
        
        // Skip if recently refreshed and not forced
        // Use shorter interval check since we want to be responsive when forced
        if (!force && lastRefreshRef.current && 
            Date.now() - lastRefreshRef.current.getTime() < ACTIVE_REFRESH_INTERVAL) {
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

    // Adaptive periodic refresh based on sidebar visibility
    // - 15 minutes when sidebar is visible (user is active)
    // - 4 hours when sidebar is closed (background check for plan changes)
    // Critical for security: ensures plan downgrades are detected
    useEffect(() => {
        if (!isAuthenticated || !user) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }

        // Determine interval based on sidebar visibility
        const interval = isSidebarVisible ? ACTIVE_REFRESH_INTERVAL : BACKGROUND_REFRESH_INTERVAL;

        // If sidebar just became visible and it's been a while, refresh immediately
        if (isSidebarVisible && lastRefreshRef.current && 
            Date.now() - lastRefreshRef.current.getTime() >= ACTIVE_REFRESH_INTERVAL) {
            refreshProfile();
        }

        // Set up adaptive periodic refresh
        intervalRef.current = setInterval(() => {
            logger(`useProfileSync: Periodic refresh triggered (sidebar ${isSidebarVisible ? 'visible' : 'hidden'})`);
            syncProfileData(user.id);
        }, interval);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [isAuthenticated, user, isSidebarVisible, refreshProfile, syncProfileData]);

    // Refresh when preference page opens
    useEffect(() => {
        if (isAuthenticated && user && isPreferencePageVisible) {
            refreshProfile(true); // Force refresh when settings page opens
        }
    }, [isAuthenticated, user, isPreferencePageVisible, refreshProfile]);

    // Listen for sync denied signal and force refresh
    const syncDenied = useAtomValue(syncDeniedForPlanAtom);
    const setSyncDenied = useSetAtom(syncDeniedForPlanAtom);
    
    useEffect(() => {
        if (syncDenied && isAuthenticated && user) {
            logger(`useProfileSync: Sync denied by backend - forcing profile refresh`);
            // Reset the signal immediately to prevent repeated refreshes
            setSyncDenied(false);
            // Force a profile refresh to get updated plan data
            syncProfileData(user.id);
        }
    }, [syncDenied, isAuthenticated, user, setSyncDenied, syncProfileData]);

    return { refreshProfile };
};