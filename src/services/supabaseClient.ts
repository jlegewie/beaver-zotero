import { createClient } from '@supabase/supabase-js';

// Use Zotero's preference system to store auth data
const zoteroStorage = {
    getItem: (key: string) => {
        try {
            const data = Zotero.Prefs.get(`beaver.auth.${key}`);
            return data ? JSON.parse(data as string) : null;
        } catch (error) {
            console.error('Error getting auth from Zotero prefs:', error);
            return null;
        }
    },
    setItem: (key: string, value: string) => {
        try {
            Zotero.Prefs.set(`beaver.auth.${key}`, JSON.stringify(value));
        } catch (error) {
            console.error('Error setting auth in Zotero prefs:', error);
        }
    },
    removeItem: (key: string) => {
        try {
            Zotero.Prefs.clear(`beaver.auth.${key}`);
        } catch (error) {
            console.error('Error removing auth from Zotero prefs:', error);
        }
    }
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase URL or Anon Key');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: zoteroStorage,
        // Provide a no-op lock function
        lock: async <T>(name: string, acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
            // Simple implementation that just runs the function without locking
            try {
                return await fn();
            } catch (error) {
                console.error('Error in lock operation:', error);
                throw error;
            }
        }
    }
});