import { atom } from 'jotai';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../../src/services/supabaseClient';
import { isProfileLoadedAtom, profileWithPlanAtom } from './profile';

/**
 * Atom representing the current authentication session
 * Null when no active session exists
 */
export const sessionAtom = atom<Session | null>(null);

/**
 * Derived atom that determines if the user is authenticated
 * Uses the session's access token to verify authentication status
 */
export const isAuthenticatedAtom = atom(
    (get) => {
        const session = get(sessionAtom);
        return !!session?.access_token;
    }
);

/**
 * User information extracted from the authentication session
 */
export type AuthUser = {
    id: string;
    email?: string;
    last_sign_in_at?: string;
}

/**
 * Atom containing the current user's information
 * Null when no user is authenticated
 */
export const userAtom = atom<AuthUser | null>(null);
export const userIdAtom = atom<string | null>((get) => get(userAtom)?.id || null);

/**
 * Loading state atom to track auth initialization status
 */
export const authLoadingAtom = atom<boolean>(true);

/**
 * Atom setter for logging out, setting session and user atoms to null
 */
export const logoutAtom = atom(
    null,
    (_, set) => {
        supabase.auth.signOut();
        set(profileWithPlanAtom, null);
        set(isProfileLoadedAtom, false);
    }
);
