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
        // Update session if:
        // - It's the initial load or sign out/in from null state
        // - Token was refreshed, user updated, password recovery, MFA verified
        // - The session object reference *actually* changes (covers most cases including token changes)
        const shouldUpdateSession =
        event === 'INITIAL_SESSION' ||
        event === 'SIGNED_OUT' ||
        event === 'TOKEN_REFRESHED' ||
        event === 'USER_UPDATED' ||
        event === 'PASSWORD_RECOVERY' ||
        event === 'MFA_CHALLENGE_VERIFIED' ||
        (event === 'SIGNED_IN' && currentSession === null) || // Actual sign-in from logged out state
        (newSession !== currentSession); // Catch-all for session object changes
        
        if (shouldUpdateSession) {
            logger(`auth: condition 'shouldUpdateSession' met for ${event}. Updating session atom.`);
            setSession(newSession);
        } else {
            logger(`auth: condition 'shouldUpdateSession' NOT met for ${event}. Skipping session atom update.`);
        }
        
        
        // --- Determine if User Atom should be updated ---
        // Update user if:
        // - User logs out (SIGNED_OUT)
        // - User data is explicitly updated (USER_UPDATED)
        // - A new user logs in (different ID or login from null state)
        // - Initial load with a user
        const shouldUpdateUser =
        event === 'SIGNED_OUT' ||
        event === 'USER_UPDATED' ||
        (newSession?.user && newUserId !== currentUserId) || // User ID changed or logged in from null
        (event === 'INITIAL_SESSION' && newSession?.user); // Initial load with a user
        
        if (shouldUpdateUser) {
            logger(`auth: condition 'shouldUpdateUser' met for ${event}. Updating user atom.`);
            if (newSession?.user) {
                const { id, email, last_sign_in_at } = newSession.user;
                // Avoid unnecessary updates if key data hasn't changed
                const newAuthUser: AuthUser = { id, email, last_sign_in_at };
                if (newAuthUser.id !== currentUser?.id || newAuthUser.email !== currentUser?.email/* || newAuthUser.last_sign_in_at !== currentUser?.last_sign_in_at */) {
                    logger(`auth: user data changed for ${event}. Setting new user state.`);
                    setUser(newAuthUser);
                } else {
                    logger(`auth: user data seems unchanged for ${event}. Skipping user atom update.`);
                }
            } else {
                logger(`auth: setting user atom to null for ${event}.`);
                setUser(null);
            }
        } else {
            logger(`auth: condition 'shouldUpdateUser' NOT met for ${event}. Skipping user atom update.`);
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
                // Decrement reference count and cleanup if needed
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
        
        // Initialize auth session
        const initAuth = async () => {
            setLoading(true);
            try {
                // Use getSession for initial state, but rely on onAuthStateChange for INITIAL_SESSION event
                const { data, error } = await supabase.auth.getSession();
                
                if (error) {
                    logger(`auth: getSession error during init: ${error.message}`);
                } else {
                    logger(`auth: getSession success during init ${data.session ? ' (session found)' : ' (no session)'}`);
                    // Initial state might be set here briefly, but INITIAL_SESSION event will refine it
                    sessionRef.current = data.session;
                    userRef.current = data.session?.user ? { id: data.session.user.id, email: data.session.user.email, last_sign_in_at: data.session.user.last_sign_in_at } : null;
                }
                
            } catch (error) {
                logger(`auth: unexpected error during initAuth: ${error}`);
            }
        };
        
        // Set up auth state change listener
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (event, session) => {
                // Use the stable handler
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
            authListenerInitialized = false; // Reset global flag
            authListenerCleanup = null;
        };
        
        // Initialize auth
        initAuth();
        
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