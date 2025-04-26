// auth/atoms.ts
import { atom } from 'jotai';
import { supabase } from '../../src/services/supabaseClient';
import { Session } from '@supabase/supabase-js';
import { logger } from '../../src/utils/logger';

// Properly typed session atom
export const sessionAtom = atom<Session | null>(null);

// Derived atom to check if user is authenticated
export const isAuthenticatedAtom = atom(
    (get) => {
        const session = get(sessionAtom);
        return !!session?.access_token;
    }
);

// Type and atom for user data
type AuthUser = {
    id: string;
    email?: string;
    last_sign_in_at?: string;
}
export const userAtom = atom<AuthUser | null>(null);

// Initialize session on app start
export const initializeSessionAtom = atom(
    null,
    async (get, set) => {
        const { data } = await supabase.auth.getSession();
        set(sessionAtom, data.session);

        logger(`auth: initializeSessionAtom ${data.session ? 'success' : 'failure'}`);
        // Set up listener for auth changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
            logger(`auth: state changed ${event}`);
            set(sessionAtom, newSession);
            set(userAtom, newSession?.user ? { id: newSession.user.id, email: newSession.user.email, last_sign_in_at: newSession.user.last_sign_in_at } : null);
        });

        // Return cleanup function
        return () => {
            logger(`auth: unsubscribing from auth state changes`);
            subscription.unsubscribe();
        };
    }
);