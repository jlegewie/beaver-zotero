import { useEffect, useRef, useState, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { RealtimeChannel } from "@supabase/supabase-js";
import { fileStatusAtom } from '../atoms/files';
import { FileStatus } from '../types/fileStatus';
import { supabase } from '../../src/services/supabaseClient';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';
import { planFeaturesAtom, hasAuthorizedAccessAtom } from '../atoms/profile';

export interface FileStatusConnection {
    connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'retrying' | 'failed';
    retryCount: number;
    lastError: string | null;
}

/**
 * Hook that fetches the user's file status, keeps the fileStatusAtom updated,
 * and subscribes to realtime changes with retry logic
 */
export const useFileStatus = (): FileStatusConnection => {
    const setFileStatus = useSetAtom(fileStatusAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const user = useAtomValue(userAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    
    // Connection status state
    const [connectionStatus, setConnectionStatus] = useState<FileStatusConnection['connectionStatus']>('idle');
    const [retryCount, setRetryCount] = useState(0);
    const [lastError, setLastError] = useState<string | null>(null);
    
    // Refs for managing instances and timers
    const channelRef = useRef<RealtimeChannel | null>(null);
    const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const maxRetries = 6;
    const baseRetryDelay = 1000; // 1 second

    // Helper to format data
    const formatStatus = (statusData: any): FileStatus => ({
        ...statusData,
        total_files: Number(statusData.total_files || 0),
        upload_pending: Number(statusData.upload_pending || 0),
        upload_completed: Number(statusData.upload_completed || 0),
        upload_failed: Number(statusData.upload_failed || 0),
        upload_skipped: Number(statusData.upload_skipped || 0),
        md_unavailable: Number(statusData.md_unavailable || 0),
        md_queued: Number(statusData.md_queued || 0),
        md_processing: Number(statusData.md_processing || 0),
        md_embedded: Number(statusData.md_embedded || 0),
        md_failed: Number(statusData.md_failed || 0),
        md_skipped: Number(statusData.md_skipped || 0),
        docling_unavailable: Number(statusData.docling_unavailable || 0),
        docling_queued: Number(statusData.docling_queued || 0),
        docling_processing: Number(statusData.docling_processing || 0),
        docling_embedded: Number(statusData.docling_embedded || 0),
        docling_failed: Number(statusData.docling_failed || 0),
        docling_skipped: Number(statusData.docling_skipped || 0),
    });

    // Calculate retry delay with exponential backoff (max 30 seconds)
    const getRetryDelay = useCallback((attempt: number): number => {
        return Math.min(baseRetryDelay * Math.pow(2, attempt), 30000);
    }, []);

    // Clear retry timeout
    const clearRetryTimeout = useCallback(() => {
        if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
        }
    }, []);

    // Reset connection state
    const resetConnectionState = useCallback(() => {
        setConnectionStatus('idle');
        setRetryCount(0);
        setLastError(null);
        clearRetryTimeout();
    }, [clearRetryTimeout]);

    useEffect(() => {
        // --- Guard Clause ---
        // Only proceed if user is authenticated, user data exists, AND plan supports file processing
        if (!isAuthenticated || !user || !hasAuthorizedAccess) {
            logger(`useFileStatus: Skipping setup. Auth: ${isAuthenticated}, User: ${!!user}, HasAuthorizedAccess: ${hasAuthorizedAccess}`);
            setFileStatus(null); // Clear status if conditions not met
            resetConnectionState();
            
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

        const setupFileStatusSync = async (isRetry: boolean = false, currentRetryCount: number = 0) => {
            try {
                if (!isMounted) return;

                setConnectionStatus(isRetry ? 'retrying' : 'connecting');
                if (isRetry) {
                    setRetryCount(currentRetryCount);
                    logger(`useFileStatus: Retry attempt ${currentRetryCount + 1}/${maxRetries} for user: ${userId}`);
                }

                // 1. Initial Fetch
                logger(`useFileStatus: Fetching initial file status for user: ${userId}`);
                const { data, error } = await supabase
                    .from('files_status')
                    .select('*')
                    .eq('user_id', userId)
                    .maybeSingle();

                if (!isMounted) return; // Check if component unmounted during async fetch

                if (error) {
                    throw new Error(`Initial fetch failed: ${error.message}`);
                }

                logger(`useFileStatus: Initial fetch result for ${userId}: ${data ? 'Data received' : 'No record'}`);
                setFileStatus(data ? formatStatus(data) : null);

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
                    throw new Error('No access token found for realtime auth');
                }
                supabase.realtime.setAuth(sessionData.session.access_token);

                // 4. Create and Subscribe to the channel
                logger(`useFileStatus: Creating and subscribing to channel 'file-status-${userId}'.`);
                const newChannel = supabase
                    .channel(`public:file-status:${userId}`)
                    .on<FileStatus>(
                        'postgres_changes',
                        {
                            event: '*',
                            schema: 'public',
                            table: 'files_status',
                            filter: `user_id=eq.${userId}`
                        },
                        (payload) => {
                            if (!isMounted) return;
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
                        if (!isMounted) return;

                        if (err) {
                            logger(`useFileStatus: Realtime subscription error for ${userId}: ${JSON.stringify(err)}`, 3);
                            console.error(`useFileStatus: realtime subscription error:`, err);
                            setConnectionStatus('disconnected');
                            setLastError(`Subscription error: ${err.message || 'Unknown error'}`);
                            
                            // Trigger retry for subscription errors
                            scheduleRetry(currentRetryCount);
                        } else {
                            logger(`useFileStatus: Realtime subscription status for ${userId}: ${status}`);
                            if (status === 'SUBSCRIBED') {
                                setConnectionStatus('connected');
                                setRetryCount(0);
                                setLastError(null);
                                clearRetryTimeout();
                            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                                setConnectionStatus('disconnected');
                                setLastError(`Connection ${status.toLowerCase()}`);
                                scheduleRetry(currentRetryCount);
                            }
                        }
                    });

                channelRef.current = newChannel;

            } catch (err: any) {
                if (!isMounted) return;
                
                const errorMessage = err?.message || 'Unknown error';
                logger(`useFileStatus: Setup failed for ${userId}: ${errorMessage}`, 3);
                console.error('useFileStatus setup error:', err);
                
                setConnectionStatus('disconnected');
                setLastError(errorMessage);
                scheduleRetry(currentRetryCount);
            }
        };

        const scheduleRetry = (currentRetryCount: number) => {
            if (!isMounted || currentRetryCount >= maxRetries) {
                if (currentRetryCount >= maxRetries) {
                    logger(`useFileStatus: Max retries (${maxRetries}) exceeded for user ${userId}`, 3);
                    setConnectionStatus('failed');
                }
                return;
            }

            const nextRetryCount = currentRetryCount + 1;
            const delay = getRetryDelay(currentRetryCount);
            
            logger(`useFileStatus: Scheduling retry ${nextRetryCount} in ${delay}ms for user ${userId}`);
            
            clearRetryTimeout();
            retryTimeoutRef.current = setTimeout(() => {
                if (isMounted) {
                    setupFileStatusSync(true, nextRetryCount);
                }
            }, delay);
        };

        // Execute the initial setup
        setupFileStatusSync();

        // --- Cleanup Function ---
        return () => {
            isMounted = false; // Set flag on unmount/cleanup
            logger(`useFileStatus: Cleanup triggered for user ${userId}.`);
            
            clearRetryTimeout();
            
            if (channelRef.current) {
                logger(`useFileStatus: Unsubscribing and removing channel 'file-status-${userId}'.`);
                channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            } else {
                logger(`useFileStatus: Cleanup called, no active channel to remove for user ${userId}.`);
            }
        };
    }, [isAuthenticated, user, setFileStatus, hasAuthorizedAccess, resetConnectionState, clearRetryTimeout, getRetryDelay]);

    return {
        connectionStatus,
        retryCount,
        lastError
    };
};