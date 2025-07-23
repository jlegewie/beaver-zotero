/**
 * Custom hook for handling authentication state with Supabase and Jotai.
 *
 * Manages:
 * - Initial session loading and setting loading state.
 * - Establishing a single global listener for Supabase auth events.
 * - Filtering auth events to prevent excessive updates, especially for `userAtom` on focus/visibility changes.
 * - Updating `sessionAtom` and `userAtom` (Jotai) based on relevant auth events (sign in, sign out, token refresh, user update, etc.).
 * - Providing a `signOut` method.
 * - Ensuring proper cleanup of the global listener.
 *
 * @returns {{ loading: boolean, signOut: () => Promise<{ error: AuthError | null }> }} An object containing the authentication loading state and the signOut function. Session and user data should be accessed directly via their respective Jotai atoms (`sessionAtom`, `userAtom`).
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { sessionAtom, userAtom, AuthUser } from '../atoms/auth';
import { supabase } from '../../src/services/supabaseClient';
import { logger } from '../../src/utils/logger';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { profileWithPlanAtom, isProfileLoadedAtom } from '../atoms/profile';

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
    const [user, setUser] = useAtom(userAtom);
    const [loading, setLoading] = useState(true);
    
    // useRef for current atom values to avoid re-rendering
    const sessionRef = useRef(session);
    const userRef = useRef(user);
    const setProfileWithPlan = useSetAtom(profileWithPlanAtom);
    const setIsProfileLoaded = useSetAtom(isProfileLoadedAtom);
    
    // Keep refs updated with the latest atom values
    useEffect(() => {
        sessionRef.current = session;
    }, [session]);
    
    useEffect(() => {
        userRef.current = user;
    }, [user]);
    
    // Stable callback for the auth listener
    const handleAuthStateChange = useCallback((event: AuthChangeEvent, newSession: Session | null) => {
        logger(`auth: received event ${event}`, newSession ? 1 : 0);
        
        const currentSession = sessionRef.current;
        const currentUser = userRef.current;
        const newUserId = newSession?.user?.id ?? null;
        const currentUserId = currentUser?.id ?? null;
        
        // --- Determine if Session Atom should be updated ---
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
        } else {
            logger(`auth: skipping session update for ${event} - no meaningful changes`);
        }
        
        // --- Determine if User Atom should be updated ---
        const shouldUpdateUser =
            event === 'SIGNED_OUT' ||
            event === 'USER_UPDATED' ||
            (newUserId && newUserId !== currentUserId) || // User ID changed or logged in from null
            (event === 'INITIAL_SESSION' && newSession?.user); // Initial load with a user
        
        if (shouldUpdateUser) {
            logger(`auth: updating user atom for ${event}`);
            if (newSession?.user) {
                const { id, email, last_sign_in_at } = newSession.user;
                const newAuthUser: AuthUser = { id, email, last_sign_in_at };
                // Only update if user data actually changed
                if (newAuthUser.id !== currentUser?.id || newAuthUser.email !== currentUser?.email) {
                    setUser(newAuthUser);
                } else {
                    logger(`auth: user data unchanged for ${event}, skipping update`);
                }
            } else {
                setUser(null);
            }
        } else {
            logger(`auth: skipping user update for ${event}`);
        }
    }, [setSession, setUser]);
    
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