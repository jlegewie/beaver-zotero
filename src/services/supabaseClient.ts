import { createClient, AuthApiError } from '@supabase/supabase-js';
import { EncryptedStorage } from './EncryptedStorage';

// Create encrypted storage instance
const encryptedStorage = new EncryptedStorage();

// Adapter to make EncryptedStorage compatible with Supabase's expected storage interface
const zoteroStorage = {
    getItem: async (key: string) => {
        try {
            const data = await encryptedStorage.getItem(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('Error getting auth from encrypted storage:', error);
            return null;
        }
    },
    setItem: async (key: string, value: string) => {
        try {
            await encryptedStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.error('Error setting auth in encrypted storage:', error);
        }
    },
    removeItem: async (key: string) => {
        try {
            encryptedStorage.removeItem(key);
        } catch (error) {
            console.error('Error removing auth from encrypted storage:', error);
        }
    }
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase URL or Anon Key');
}

const supabaseAuthStorageKey = `sb-${new URL(supabaseUrl).hostname.replace(
    /\./g,
    '-'
)}-auth-token`;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: zoteroStorage,
        // Provide a no-op lock function
        lock: async <T>(
            name: string,
            acquireTimeout: number,
            fn: () => Promise<T>
        ): Promise<T> => {
            // Simple implementation that just runs the function without locking
            try {
                return await fn();
            } catch (error) {
                if (
                    error instanceof AuthApiError &&
                    error.message.includes('Invalid Refresh Token')
                ) {
                    console.log(
                        'Invalid refresh token found. Clearing session and retrying.'
                    );
                    await zoteroStorage.removeItem(supabaseAuthStorageKey);
                    return fn();
                }
                console.error('Error in lock operation:', error);
                throw error;
            }
        }
    }
});