import { atom } from 'jotai';
import { Session } from '@supabase/supabase-js';

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

/**
 * Loading state atom to track auth initialization status
 */
export const authLoadingAtom = atom<boolean>(true);