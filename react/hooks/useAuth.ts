/**
 * Custom hook for handling authentication state with Supabase and Jotai.
 *
 * Manages:
 * - Initial session loading and setting loading state.
 * - Establishing a single global listener for Supabase auth events.
 * - Filtering auth events to prevent excessive updates to `sessionAtom`.
 * - Updating `sessionAtom` (Jotai) based on relevant auth events (sign in, sign out, token refresh, user update, etc.).
 *   `userAtom` is a derived atom of `sessionAtom`, so it follows automatically and never drifts out of sync.
 * - Clearing profile state on account switch and external sign-out.
 * - Providing a `signOut` method.
 * - Ensuring proper cleanup of the global listener.
 *
 * @returns {{ loading: boolean, signOut: () => Promise<{ error: AuthError | null }> }} An object containing the authentication loading state and the signOut function. Session and user data should be accessed directly via their respective Jotai atoms (`sessionAtom`, `userAtom`).
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import {
    sessionAtom,
    resetLoginFormState,
} from '../atoms/auth';
import { supabase } from '../../src/services/supabaseClient';
import { logger } from '../../src/utils/logger';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import {
    profileWithPlanAtom,
    isProfileLoadedAtom,
    profileSyncStatusAtom,
} from '../atoms/profile';
import { store } from '../store';

// Track if auth listener has been initialized globally
let authListenerInitialized = false;
let authListenerCleanup: (() => void) | null = null;
let authListenerRefCount = 0; // Reference counting

// Helper function to compare session content instead of object reference
function hasSessionChanged(oldSession: Session | null, newSession: Session | null): boolean {
    // Both null/undefined
    if (!oldSession && !newSession) return false;
    
    // One is null, other isn't
    if (!oldSession || !newSession) return true;
    
    // Compare meaningful session properties
    return (
        oldSession.access_token !== newSession.access_token ||
        oldSession.user?.id !== newSession.user?.id ||
        oldSession.expires_at !== newSession.expires_at
    );
}

export function useAuth() {
    const [session, setSession] = useAtom(sessionAtom);
    const [loading, setLoading] = useState(true);

    // useRef for current session value to avoid re-rendering
    const sessionRef = useRef(session);
    const setProfileWithPlan = useSetAtom(profileWithPlanAtom);
    const setIsProfileLoaded = useSetAtom(isProfileLoadedAtom);
    const setProfileSyncStatus = useSetAtom(profileSyncStatusAtom);

    // Keep ref updated with the latest session value
    useEffect(() => {
        sessionRef.current = session;
    }, [session]);

    // Stable callback for the auth listener
    const handleAuthStateChange = useCallback((event: AuthChangeEvent, newSession: Session | null) => {
        const currentSession = sessionRef.current;
        logger(`auth: received event=${event}, hasSession=${!!newSession}, hasCurrentSession=${!!currentSession}`);

        const newUserId = newSession?.user?.id ?? null;
        const currentUserId = currentSession?.user?.id ?? null;

        // --- Deduplicate SIGNED_OUT events ---
        // userAtom derives from sessionAtom, so a null session already means no user.
        if (event === 'SIGNED_OUT' && currentSession === null) {
            return;
        }

        // --- Determine if Session Atom should be updated ---
        // userAtom is derived from sessionAtom, so updating the session keeps the
        // user identity in sync automatically — no separate user update needed.
        const shouldUpdateSession =
            event === 'INITIAL_SESSION' ||
            event === 'SIGNED_OUT' ||
            event === 'TOKEN_REFRESHED' ||
            event === 'USER_UPDATED' ||
            event === 'PASSWORD_RECOVERY' ||
            event === 'MFA_CHALLENGE_VERIFIED' ||
            (event === 'SIGNED_IN' && currentSession === null) || // Actual sign-in from logged out state
            hasSessionChanged(currentSession, newSession); // Compare session content, not object reference

        if (shouldUpdateSession) {
            logger(`auth: updating session atom for ${event}`);
            setSession(newSession);
        }
        // else {
            // logger(`auth: skipping session update for ${event} - no meaningful changes`);
        // }

        // Account switch: if the user.id actually changed (and there was a prior user),
        // clear the previous profile so the new user's fetch in useProfileSync starts clean.
        // Without this, the prior profile briefly renders before the new fetch lands.
        if (currentUserId && newUserId && currentUserId !== newUserId) {
            logger(`auth: user changed (${currentUserId} -> ${newUserId}); clearing previous profile state`);
            setProfileWithPlan(null);
            setIsProfileLoaded(false);
            setProfileSyncStatus({ kind: 'ok' });
        }

        // Reset transient login form state when there's no active session:
        // - SIGNED_OUT: session expired externally (e.g., "Invalid Refresh Token: Already Used")
        // - INITIAL_SESSION with no session: window reopened after interrupted login flow
        //   (macOS window close preserves Jotai store but kills in-flight requests,
        //   leaving isLoading/step stuck in stale state)
        // Note: authMethod (user's login method preference) is intentionally untouched.
        if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !newSession)) {
            resetLoginFormState(store.set);
            // Clear profile state on external sign-out / cold start with no session.
            // Pairs with useProfileSync's invariant of not flipping isProfileLoaded false on
            // refresh failures — these supabase events are the authoritative reset signal.
            setProfileWithPlan(null);
            setIsProfileLoaded(false);
            setProfileSyncStatus({ kind: 'ok' });
        }
    }, [setSession, setProfileWithPlan, setIsProfileLoaded, setProfileSyncStatus]);
    
    useEffect(() => {
        // Increment reference count
        authListenerRefCount++;
        logger(`auth: component mounted, ref count: ${authListenerRefCount}`);
        
        // Skip initialization if already done by another instance
        if (authListenerInitialized && authListenerCleanup) {
            logger('auth: listener already initialized globally, skipping setup.');
            setLoading(false);
            return () => {
                authListenerRefCount--;
                logger(`auth: component unmounting, ref count: ${authListenerRefCount}`);
                
                if (authListenerRefCount <= 0 && authListenerCleanup) {
                    logger('auth: last component unmounting, performing global cleanup.');
                    authListenerCleanup();
                }
            };
        }
        
        // Mark initialization globally
        authListenerInitialized = true;
        logger('auth: initializing listener...');
        
        // Set up auth state change listener
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (event, session) => {
                handleAuthStateChange(event, session);
                // Set loading to false after the first event (INITIAL_SESSION) is processed
                if (event === 'INITIAL_SESSION') {
                    setLoading(false);
                    logger('auth: INITIAL_SESSION processed, setting loading to false.');
                }
            }
        );
        
        // Store the global cleanup function
        authListenerCleanup = () => {
            logger(`auth: global unsubscribing from auth state changes`);
            subscription.unsubscribe();
            authListenerInitialized = false;
            authListenerCleanup = null;
        };
        
        // Clean up subscription when the component unmounts
        return () => {
            authListenerRefCount--;
            logger(`auth: component unmounting, ref count: ${authListenerRefCount}`);
            
            if (authListenerRefCount <= 0 && authListenerCleanup) {
                logger('auth: last component unmounting, performing global cleanup.');
                authListenerCleanup();
            }
        };
    }, [handleAuthStateChange]);
    
    const signOut = async () => {
        setLoading(true);
        const { error } = await supabase.auth.signOut();
        setProfileWithPlan(null);
        setIsProfileLoaded(false);
        if (error) {
            logger(`auth: sign out error: ${error.message}`);
            setLoading(false);
            return { error };
        }
        // State updates (session/user null) will be handled by the SIGNED_OUT event
        return { error: null };
    };
    
    return {
        loading,
        signOut
        // session and user are available via useAtom(sessionAtom) / useAtom(userAtom) directly
    };
}