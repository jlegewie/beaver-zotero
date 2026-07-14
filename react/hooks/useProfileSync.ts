import { useEffect, useRef, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { fileUploader } from '../../src/services/FileUploader';
import { isAuthenticatedAtom, logoutAtom, userAtom, isWaitingForProfileAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { logger } from '../../src/utils/logger';
import { SessionExpiredError, ZoteroInstanceMismatchError } from '../../react/types/apiErrors';
import { setModelsAtom } from '../atoms/models';
import { isSidebarVisibleAtom, isPreferencePageVisibleAtom } from '../atoms/ui';
import { serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import { getPref, setPref } from '../../src/utils/prefs';
import {
    isProfileInvalidAtom,
    isProfileLoadedAtom,
    profileWithPlanAtom,
    isMigratingDataAtom,
    requiredDataVersionAtom,
    localZoteroLibrariesAtom,
    minimumFrontendVersionAtom,
    syncDeniedForPlanAtom,
    prefWindowFocusRefreshAtom,
    errorCreditCheckAtom,
    profileSyncStatusAtom,
} from '../atoms/profile';
import { isTransientNetworkError } from '../utils/isTransientNetworkError';
import { store } from '../store';

// Adaptive refresh intervals based on sidebar visibility
const ACTIVE_REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes when sidebar is visible
const BACKGROUND_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours when sidebar is closed

// Capped exponential backoff for transient errors. Delay caps at 60s; attempt count is unbounded.
const RETRY_BACKOFF_BASE_MS = 2000;
const RETRY_BACKOFF_FACTOR = 3;
const RETRY_BACKOFF_MAX_MS = 60 * 1000;

const computeRetryDelay = (attempts: number) =>
    Math.min(RETRY_BACKOFF_BASE_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempts), RETRY_BACKOFF_MAX_MS);

// Module-level singleton for cross-React-root retry-button calls. The singleton useProfileSync
// hook in GlobalContextInitializer assigns this; ProfileLoadingPage (which mounts in a different
// React root than the hook) reads it. Cleared on hook unmount.
let externalRefresh: (() => Promise<void>) | null = null;
export const triggerProfileRefresh = (): Promise<void> | undefined => externalRefresh?.();

/**
 * Hook to synchronize the user's profile and plan data (ProfileWithPlan)
 * with the backend. Uses adaptive refresh intervals:
 * - 15 minutes when sidebar is visible (user is active)
 * - 4 hours when sidebar is closed (background check for plan changes)
 *
 * On transient errors (network, 5xx, offline) the previously-loaded profile is preserved
 * and a retry is scheduled with capped exponential backoff. A successful refresh clears
 * the error state.
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
    const setProfileSyncStatus = useSetAtom(profileSyncStatusAtom);
    const logout = useSetAtom(logoutAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const user = useAtomValue(userAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);

    const lastRefreshRef = useRef<Date | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const isRefreshingRef = useRef<boolean>(false);
    const forcedRefreshPendingRef = useRef<boolean>(false);
    const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const retryAttemptsRef = useRef<number>(0);

    const syncProfileData = useCallback(async (userId: string) => {
        if (isRefreshingRef.current) {
            logger(`useProfileSync: Refresh already in progress, skipping.`);
            return;
        }
        if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
        }
        isRefreshingRef.current = true;
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
                    const updatedProfileData = await accountService.getProfileWithPlan();
                    setProfileWithPlan(updatedProfileData.profile);
                    setModels(updatedProfileData.model_configs);
                } catch (migrationError: any) {
                    if (migrationError instanceof SessionExpiredError || migrationError instanceof ZoteroInstanceMismatchError) {
                        throw migrationError;
                    }
                    logger(`useProfileSync: Migration failed: ${migrationError?.message}`, 3);
                    setProfileWithPlan(profileData.profile);
                    setModels(profileData.model_configs);
                } finally {
                    setIsMigratingData(false);
                }
            } else {
                setProfileWithPlan(profileData.profile);
                setModels(profileData.model_configs);
            }

            // Back-fill: mark sign-in privacy notice as shown for users who already completed onboarding,
            // so it only appears for genuinely new users on the LoginPage.
            const isAuthorized = profileData.profile.has_authorized_access || profileData.profile.has_authorized_free_access;
            if (isAuthorized && !getPref("onboardingSignInTextShown")) {
                setPref("onboardingSignInTextShown", true);
            }

            // Persist the authenticated email as the install's account sentinel.
            // Onboarding pages also write this, but already-authorized users
            // skip onboarding — without this, the SignInForm mismatch prompt
            // wouldn't fire on later switches. Deferred until profile validates
            // so a 403 ZoteroInstanceMismatchError doesn't stick a rejected
            // email into the pref.
            //
            // Re-read the userAtom from the store (rather than the closed-over
            // `user`) and confirm it still matches the userId this fetch was
            // started for. A stale refresh that began before sign-out + account
            // switch could otherwise resume here and write the previous user's
            // email back over the freshly cleared sentinel.
            const currentUser = store.get(userAtom);
            if (currentUser?.id === userId && currentUser.email && getPref("userEmail") !== currentUser.email) {
                setPref("userEmail", currentUser.email);
            }

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

            setIsProfileLoaded(true);
            setIsProfileInvalid(false);
            setIsWaitingForProfile(false);
            setProfileSyncStatus({ kind: 'ok' });
            retryAttemptsRef.current = 0;
            lastRefreshRef.current = new Date();
            logger(`useProfileSync: Successfully fetched profile and plan for ${userId}.`, profileData.profile);

        } catch (error: any) {
            if (error instanceof ZoteroInstanceMismatchError) {
                logger(`useProfileSync: Zotero instance mismatch for ${userId}. Signing out user.`, 2);
                setIsProfileInvalid(true);
                await logout();
                return;
            }
            if (error instanceof SessionExpiredError) {
                logger(`useProfileSync: Session expired during profile fetch for ${userId}. Signing out user.`, 2);
                await logout();
                return;
            }

            const message = error?.message ?? String(error);
            if (isTransientNetworkError(error)) {
                retryAttemptsRef.current += 1;
                const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
                logger(`useProfileSync: Transient error during fetch for ${userId}: ${message}. Scheduling retry ${retryAttemptsRef.current}.`, 2);
                setProfileSyncStatus({ kind: 'transient', message, attempt: retryAttemptsRef.current, offline });
                const delay = computeRetryDelay(retryAttemptsRef.current - 1);
                retryTimeoutRef.current = setTimeout(() => {
                    retryTimeoutRef.current = null;
                    // If another refresh is already running (e.g. periodic interval fired),
                    // queue the retry to run after it finishes. The in-flight finally block
                    // will see forcedRefreshPendingRef and re-invoke syncProfileData.
                    if (isRefreshingRef.current) {
                        forcedRefreshPendingRef.current = true;
                    } else {
                        syncProfileData(userId);
                    }
                }, delay);
            } else {
                logger(`useProfileSync: Non-transient error during fetch for ${userId}: ${message}`, 3);
                setProfileSyncStatus({ kind: 'fatal', message });
            }
        } finally {
            isRefreshingRef.current = false;
            if (forcedRefreshPendingRef.current) {
                forcedRefreshPendingRef.current = false;
                setTimeout(() => syncProfileData(userId), 0);
            }
        }
    }, [user, setProfileWithPlan, setIsProfileLoaded, setIsProfileInvalid, setIsWaitingForProfile, setModels, setIsMigratingData, setRequiredDataVersion, setMinimumFrontendVersion, setLocalZoteroLibraries, setProfileSyncStatus, logout]);

    const refreshProfile = useCallback(async (force = false) => {
        if (!user) return;

        if (force && isRefreshingRef.current) {
            logger(`useProfileSync: Refresh in progress, queuing forced refresh.`);
            forcedRefreshPendingRef.current = true;
            return;
        }

        if (!force && lastRefreshRef.current &&
            Date.now() - lastRefreshRef.current.getTime() < ACTIVE_REFRESH_INTERVAL) {
            return;
        }

        await syncProfileData(user.id);
    }, [user, syncProfileData]);

    // Initial fetch on authentication. Cleanup runs when isAuthenticated changes or
    // user.id changes (sign-out, account switch) — cancel any pending retry from the
    // prior session so syncProfileData(oldUserId) doesn't fire post-logout.
    useEffect(() => {
        if (isAuthenticated && user) {
            syncProfileData(user.id);
        } else {
            logger(`useProfileSync: User not authenticated or user data unavailable.`);
        }
        return () => {
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
            retryAttemptsRef.current = 0;
        };
    }, [isAuthenticated, user, syncProfileData]);

    // Adaptive periodic refresh based on sidebar visibility.
    // Critical for security: ensures plan downgrades are detected.
    useEffect(() => {
        if (!isAuthenticated || !user) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }

        const interval = isSidebarVisible ? ACTIVE_REFRESH_INTERVAL : BACKGROUND_REFRESH_INTERVAL;

        if (isSidebarVisible && lastRefreshRef.current &&
            Date.now() - lastRefreshRef.current.getTime() >= ACTIVE_REFRESH_INTERVAL) {
            refreshProfile();
        }

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
            refreshProfile(true);
        }
    }, [isAuthenticated, user, isPreferencePageVisible, refreshProfile]);

    // Refresh profile when preferences window regains focus (e.g., returning from Stripe checkout)
    const prefWindowFocusRefresh = useAtomValue(prefWindowFocusRefreshAtom);
    const setPrefWindowFocusRefresh = useSetAtom(prefWindowFocusRefreshAtom);

    useEffect(() => {
        if (prefWindowFocusRefresh && isAuthenticated && user) {
            logger(`useProfileSync: Preferences window focus - refreshing profile`);
            setPrefWindowFocusRefresh(false);
            syncProfileData(user.id);
        }
    }, [prefWindowFocusRefresh, isAuthenticated, user, setPrefWindowFocusRefresh, syncProfileData]);

    // Listen for sync denied signal and force refresh
    const syncDenied = useAtomValue(syncDeniedForPlanAtom);
    const setSyncDenied = useSetAtom(syncDeniedForPlanAtom);

    useEffect(() => {
        if (syncDenied && isAuthenticated && user) {
            logger(`useProfileSync: Sync denied by backend - forcing profile refresh`);
            setSyncDenied(false);
            refreshProfile(true);
        }
    }, [syncDenied, isAuthenticated, user, setSyncDenied, refreshProfile]);

    // Refresh profile when error with credit button is displayed so credit state is fresh.
    const errorCreditCheck = useAtomValue(errorCreditCheckAtom);
    const setErrorCreditCheck = useSetAtom(errorCreditCheckAtom);
    useEffect(() => {
        if (errorCreditCheck && isAuthenticated && user) {
            setErrorCreditCheck(false);
            refreshProfile(true);
        }
    }, [errorCreditCheck, isAuthenticated, user, setErrorCreditCheck, refreshProfile]);

    // Online/offline listeners + module-level singleton for cross-root retry triggers.
    useEffect(() => {
        externalRefresh = () => refreshProfile(true);
        const win = Zotero.getMainWindow();
        if (!win) {
            return () => { externalRefresh = null; };
        }

        const handleOnline = () => {
            logger(`useProfileSync: Online — resuming sync.`);
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
            if (isAuthenticated && user) refreshProfile(true);
        };
        const handleOffline = () => {
            logger(`useProfileSync: Offline.`);
            // Cancel any pending retry — there's no point waking up the backoff schedule
            // while we know the network is down. The online listener restarts the cycle
            // from a clean slate.
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
            retryAttemptsRef.current = 0;
            // Offline is its own UI state, not a continuation of the retry chain — show
            // attempt: 0 so the user doesn't see "Trying again (attempt 6)" while idle.
            setProfileSyncStatus({
                kind: 'transient',
                message: 'Offline',
                attempt: 0,
                offline: true,
            });
        };

        win.addEventListener('online', handleOnline);
        win.addEventListener('offline', handleOffline);
        return () => {
            win.removeEventListener('online', handleOnline);
            win.removeEventListener('offline', handleOffline);
            externalRefresh = null;
        };
    }, [isAuthenticated, user, refreshProfile, setProfileSyncStatus]);

    return { refreshProfile };
};
