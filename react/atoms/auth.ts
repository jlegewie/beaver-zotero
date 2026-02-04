import { atom } from 'jotai';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../../src/services/supabaseClient';
import { isProfileLoadedAtom, profileWithPlanAtom } from './profile';
import { getPref, setPref } from '../../src/utils/prefs';
import { logger } from '../../src/utils/logger';

/**
 * Atom representing the current authentication session
 * Null when no active session exists
 */
export const sessionAtom = atom<Session | null>(null);

// =============================================================================
// Login Form State Atoms
// These atoms manage shared state for the login form across all windows
// =============================================================================

export type AuthMethod = 'initial' | 'code' | 'password';
export type LoginStep = 'method-selection' | 'otp' | 'forgot-password';

/**
 * Determines the authentication method shown in the login form
 * Synced with preferences for persistence. 
 * Note: 'code' is a transient state and defaults to 'initial' on restart.
 */
const getInitialAuthMethod = (): AuthMethod => {
    const stored = getPref("authMethod");
    return (stored === 'password') ? stored : 'initial';
};

export const authMethodAtom = atom<AuthMethod>(getInitialAuthMethod());

/**
 * Write atom to update authMethod and persist to preferences
 */
export const setAuthMethodAtom = atom(
    null,
    (get, set, method: AuthMethod) => {
        set(authMethodAtom, method);
        setPref("authMethod", method);
    }
);

/**
 * Current step in the login flow
 */
export const loginStepAtom = atom<LoginStep>('method-selection');

/**
 * Email input value for login form (shared across windows)
 */
const getInitialEmail = (): string => {
    return getPref("userEmail") || '';
};

export const loginEmailAtom = atom<string>(getInitialEmail());

/**
 * Password input value for login form
 */
export const loginPasswordAtom = atom<string>('');

/**
 * Error message for authentication forms
 */
export const loginErrorAtom = atom<string | null>(null);

/**
 * Loading state for authentication operations
 */
export const loginLoadingAtom = atom<boolean>(false);

/**
 * Countdown timer for OTP resend (in seconds)
 */
export const otpResendCountdownAtom = atom<number>(0);

/**
 * Whether we're waiting for profile to load after successful auth
 */
export const isWaitingForProfileAtom = atom<boolean>(false);

/**
 * Reset all login form state to initial values.
 * Accepts any setter with the signature (atom, value) => void,
 * so it works with both Jotai atom write `set` and `store.set`.
 *
 * @param preserveAuthMethod - If true, keeps the stored authMethod preference
 *   intact. Use this for automatic cleanup paths (e.g., stale session reset)
 *   where the user's login method preference should be preserved.
 */
export function resetLoginFormState(
    set: (atom: any, value: any) => void,
    { preserveAuthMethod = false }: { preserveAuthMethod?: boolean } = {}
): void {
    logger('resetLoginFormState: resetting login form state');
    if (preserveAuthMethod) {
        // Restore the persisted authMethod rather than resetting to 'initial'
        set(authMethodAtom, getInitialAuthMethod());
    } else {
        set(authMethodAtom, 'initial');
        setPref("authMethod", "initial");
    }
    set(loginStepAtom, 'method-selection');
    set(loginLoadingAtom, false);
    set(loginPasswordAtom, '');
    set(loginErrorAtom, null);
    set(otpResendCountdownAtom, 0);
    set(isWaitingForProfileAtom, false);
}

/**
 * Reset login form to initial state
 */
export const resetLoginFormAtom = atom(
    null,
    (get, set) => {
        resetLoginFormState(set);
    }
);

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
 * Also resets all login form state (except email for convenience)
 */
export const logoutAtom = atom(
    null,
    async (_, set) => {
        await supabase.auth.signOut();
        set(profileWithPlanAtom, null);
        set(isProfileLoadedAtom, false);

        // Reset login form state (keep email for convenience)
        resetLoginFormState(set);
    }
);
