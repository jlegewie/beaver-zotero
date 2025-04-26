/**
* Custom hook for handling authentication with Supabase and Jotai
* 
* This hook handles:
* - Initial session loading
* - Setting up auth state change listeners
* - Properly cleaning up listeners
* - Updating Jotai atoms with auth state
* 
* @returns {Object} Auth methods and loading state
*/
import { useEffect, useState, useRef } from 'react';
import { useAtom } from 'jotai';
import { sessionAtom, userAtom } from '../atoms/auth';
import { supabase } from '../../src/services/supabaseClient';
import { logger } from '../../src/utils/logger';

// Track if auth listener has been initialized globally
// This prevents multiple listeners when the hook is used in multiple components
let authListenerInitialized = false;

export function useAuth() {
    const [session, setSession] = useAtom(sessionAtom);
    const [user, setUser] = useAtom(userAtom);
    const [loading, setLoading] = useState(true);
    const lastTokenRef = useRef<string | null>(null);
    
    useEffect(() => {
        // Skip initialization if already done
        if (authListenerInitialized) {
            setLoading(false);
            return;
        }
        
        // Mark initialization as in progress
        authListenerInitialized = true;
        
        // Initialize auth session
        const initAuth = async () => {
            try {
                const { data, error } = await supabase.auth.getSession();
                
                if (error) {
                    logger(`auth: initialization error: ${error.message}`);
                    return;
                }
                
                // Set session atom
                setSession(data.session);
                
                // Set user atom if session exists
                if (data.session?.user) {
                    const { id, email, last_sign_in_at } = data.session.user;
                    setUser({ id, email, last_sign_in_at });
                }
                
                logger(`auth: initialization ${data.session ? 'success' : 'not signed in'}`);
            } catch (error) {
                logger(`auth: unexpected error during initialization: ${error}`);
            } finally {
                setLoading(false);
            }
        };

        // Set up auth state change listener
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (event, newSession) => {
                const token = newSession?.access_token ?? null;
                const isNew = event === 'TOKEN_REFRESHED' || (event === 'SIGNED_IN' && token !== lastTokenRef.current);

                // Only update session if token has changed
                if (isNew) {
                    logger(`auth: state changed ${event}`);

                    // Update last token
                    lastTokenRef.current = token;
                    
                    // Update session atom
                    setSession(newSession);
                    
                    // Update user atom
                    if (newSession?.user) {
                        const { id, email, last_sign_in_at } = newSession.user;
                        setUser({ id, email, last_sign_in_at });
                    } else {
                        setUser(null);
                    }
                }
            }
        );
        
        // Initialize auth
        initAuth();
        
        // Clean up subscription when component unmounts
        return () => {
            logger(`auth: unsubscribing from auth state changes`);
            subscription.unsubscribe();
            authListenerInitialized = false;
        };
    }, []); // Empty dependency array ensures this only runs once
    
    const signOut = async () => {
        const { error } = await supabase.auth.signOut();
        if (error) {
            logger(`auth: sign out error: ${error.message}`);
            return { error };
        }
        return { error: null };
    };
    
    return {
        loading,
        signOut
    };
}