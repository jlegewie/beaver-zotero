// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { recentThreadsAtom } from '../atoms/threads';
import { Thread } from '../types/messages';
import { supabase } from '../../src/services/supabaseClient';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';

const MAX_THREADS = 6;

/**
 * Hook that subscribes to thread changes in Supabase and keeps
 * the most recent threads in the recentThreadsAtom
 */
export const useRecentThreads = (): void => {
    const setRecentThreads = useSetAtom(recentThreadsAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const user = useAtomValue(userAtom);

    useEffect(() => {
        // Skip if user is not authenticated
        if (!isAuthenticated || !user) return;

        // Format thread data from the database to match our Thread interface
        const formatThread = (thread: any): Thread => ({
            id: thread.id,
            name: thread.name,
            createdAt: thread.created_at,
            updatedAt: thread.updated_at,
        });

        // Initial fetch of recent threads
        const fetchRecentThreads = async () => {
            const { data, error } = await supabase
                .from('threads')
                .select('id, name, created_at, updated_at')
                .eq('user_id', user.id)
                .order('updated_at', { ascending: false })
                .limit(MAX_THREADS);

            if (error) {
                console.error('Error fetching recent threads:', error);
                return;
            }

            setRecentThreads(data.map(formatThread));
        };

        // Execute initial fetch
        fetchRecentThreads();

        // Set up realtime subscription
        const subscription = supabase
            .channel(`recent-threads-${user.id}`)
            .on('postgres_changes', 
                { 
                    event: '*', 
                    schema: 'public', 
                    table: 'threads',
                    filter: `user_id=eq.${user.id}`
                }, 
                (payload) => {
                    // Handle thread insertion or update
                    if (['INSERT', 'UPDATE'].includes(payload.eventType)) {
                        const updatedThread = formatThread(payload.new);
                        
                        setRecentThreads(current => {
                            // Remove the thread if it already exists in the list
                            const filteredThreads = current.filter(t => t.id !== updatedThread.id);
                            // Add the updated thread at the beginning
                            filteredThreads.unshift(updatedThread);
                            // Sort by updated_at (newest first) and limit to MAX_THREADS
                            return filteredThreads
                                .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                                .slice(0, MAX_THREADS);
                        });
                    }
                    
                    // Handle thread deletion
                    if (payload.eventType === 'DELETE') {
                        const deletedThreadId = payload.old.id;
                        setRecentThreads(current => current.filter(t => t.id !== deletedThreadId));
                    }
                }
            )
            .subscribe((status) => {
                console.log(`recent-threads: realtime subscription status: ${status}`);
            });

        // Clean up subscription on unmount
        return () => {
            subscription.unsubscribe();
        };
    }, [isAuthenticated, user, setRecentThreads]);
};