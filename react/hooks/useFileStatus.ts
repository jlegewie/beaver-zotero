// @ts-ignore no idea why this needed
import { useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { RealtimeChannel } from "@supabase/supabase-js";
import { fileStatusAtom } from '../atoms/ui';
import { profileWithPlanAtom } from '../atoms/profile';
import { FileStatus } from '../types/fileStatus';
import { supabase } from '../../src/services/supabaseClient';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';

/**
 * Hook that fetches the user's file status, keeps the fileStatusAtom updated,
 * and subscribes to realtime changes *only* if the user is authenticated
 * and their profile data has been loaded.
 */
export const useFileStatus = (): void => {
    const setFileStatus = useSetAtom(fileStatusAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const user = useAtomValue(userAtom);
    // Read the profile state to ensure it's loaded before subscribing
    const profileWithPlan = useAtomValue(profileWithPlanAtom);
    // Ref to manage the realtime channel instance
    const channelRef = useRef<RealtimeChannel | null>(null);

    // Helper to format data
    const formatStatus = (statusData: any): FileStatus => ({
        ...statusData,
        total_files: Number(statusData.total_files || 0),
        upload_pending: Number(statusData.upload_pending || 0),
        upload_completed: Number(statusData.upload_completed || 0),
        upload_failed: Number(statusData.upload_failed || 0),
        md_unavailable: Number(statusData.md_unavailable || 0),
        md_queued: Number(statusData.md_queued || 0),
        md_processing: Number(statusData.md_processing || 0),
        md_converted: Number(statusData.md_converted || 0),
        md_chunked: Number(statusData.md_chunked || 0),
        md_embedded: Number(statusData.md_embedded || 0),
        md_failed: Number(statusData.md_failed || 0),
        docling_unavailable: Number(statusData.docling_unavailable || 0),
        docling_queued: Number(statusData.docling_queued || 0),
        docling_processing: Number(statusData.docling_processing || 0),
        docling_converted: Number(statusData.docling_converted || 0),
        docling_chunked: Number(statusData.docling_chunked || 0),
        docling_embedded: Number(statusData.docling_embedded || 0),
        docling_failed: Number(statusData.docling_failed || 0),
    });

    useEffect(() => {
        // --- Guard Clause ---
        // Only proceed if user is authenticated, user data exists, AND profile is loaded.
        if (!isAuthenticated || !user || !profileWithPlan) {
            logger(`useFileStatus: Skipping setup. Auth: ${isAuthenticated}, User: ${!!user}, Profile: ${!!profileWithPlan}`);
            setFileStatus(null); // Clear status if conditions not met
            // Ensure any existing channel is cleaned up if dependencies change mid-subscription
            if (channelRef.current) {
                logger(`useFileStatus: Cleaning up existing channel due to unmet conditions.`);
                channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            }
            return; // Stop the effect here
        }

        // Store userId locally for easier use and logging
        const userId = user.id;
        logger(`useFileStatus: Conditions met for user ${userId}. Proceeding with setup.`);

        // --- Main Logic (Runs only if guard clause passes) ---
        let isMounted = true; // Flag to prevent state updates after unmount

        const setupFileStatusSync = async () => {
            // 1. Initial Fetch
            logger(`useFileStatus: Fetching initial file status for user: ${userId}`);
            try {
                const { data, error } = await supabase
                    .from('files_status')
                    .select('*')
                    .eq('user_id', userId)
                    .maybeSingle();

                if (!isMounted) return; // Check if component unmounted during async fetch

                if (error) {
                    logger(`useFileStatus: Error fetching initial file status for ${userId}: ${error.message}`, 3);
                    console.error('Error fetching initial file status:', error);
                    setFileStatus(null);
                    // Do not proceed to subscribe if initial fetch fails
                    return;
                }

                logger(`useFileStatus: Initial fetch result for ${userId}: ${data ? 'Data received' : 'No record'}`);
                setFileStatus(data ? formatStatus(data) : null);

            } catch (err: any) {
                if (!isMounted) return;
                logger(`useFileStatus: Exception during initial fetch for ${userId}: ${err?.message}`, 3);
                console.error('Exception fetching initial file status:', err);
                setFileStatus(null);
                // Do not proceed to subscribe if initial fetch fails critically
                return;
            }

            // --- Realtime Setup ---

            // 2. Clean up previous channel (safety check)
            if (channelRef.current) {
                logger(`useFileStatus: Removing existing channel before creating new one for ${userId}.`);
                await channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            }

            // 3. Explicitly set auth token for Realtime
            logger(`useFileStatus: Setting realtime auth token for ${userId}.`);
            const { data: sessionData } = await supabase.auth.getSession();
            if (!sessionData.session?.access_token) {
                logger(`useFileStatus: No access token found for realtime auth for ${userId}. Aborting subscription.`, 2);
                return; // Cannot subscribe securely
            }
            supabase.realtime.setAuth(sessionData.session.access_token);

            // 4. Create and Subscribe to the channel
            logger(`useFileStatus: Creating and subscribing to channel 'file-status-${userId}'.`);
            const newChannel = supabase
                .channel(`public:file-status:${userId}`)
                .on<FileStatus>(
                    'postgres_changes',
                    {
                        event: '*', // Listen for INSERT, UPDATE, DELETE
                        schema: 'public',
                        table: 'files_status',
                        filter: `user_id=eq.${userId}`
                    },
                    (payload) => {
                        if (!isMounted) return; // Check mount status on receiving event
                        logger(`useFileStatus: Received event: ${payload.eventType} for ${userId}`);
                        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                            logger(`useFileStatus: Updated data for ${userId}: ${JSON.stringify(payload.new)}`);
                            setFileStatus(formatStatus(payload.new));
                        } else if (payload.eventType === 'DELETE') {
                            logger(`useFileStatus: Record deleted for ${userId}.`);
                            setFileStatus(null);
                        }
                    }
                )
                .subscribe((status, err) => {
                    if (!isMounted && status !== 'SUBSCRIBED') { // Don't log errors if unmounted unless it's a failure during setup
                       return;
                    }
                    if (err) {
                        logger(`useFileStatus: Realtime subscription error for ${userId}: ${JSON.stringify(err)}`, 3);
                        console.error(`useFileStatus: realtime subscription error:`, err);
                    } else {
                        logger(`useFileStatus: Realtime subscription status for ${userId}: ${status}`);
                    }
                });

            // Store the channel instance
            channelRef.current = newChannel;
        };

        // Execute the setup function
        setupFileStatusSync();

        // --- Cleanup Function ---
        return () => {
            isMounted = false; // Set flag on unmount/cleanup
            logger(`useFileStatus: Cleanup triggered for user ${userId}.`);
            if (channelRef.current) {
                logger(`useFileStatus: Unsubscribing and removing channel 'file-status-${userId}'.`);
                channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            } else {
                logger(`useFileStatus: Cleanup called, no active channel to remove for user ${userId}.`);
            }
        };
    }, [isAuthenticated, user, profileWithPlan, setFileStatus]);
};