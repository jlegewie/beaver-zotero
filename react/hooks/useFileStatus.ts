import { useEffect, useRef, useState, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { RealtimeChannel, REALTIME_SUBSCRIBE_STATES, REALTIME_CHANNEL_STATES } from "@supabase/supabase-js";
import { fileStatusAtom } from '../atoms/files';
import { FileStatus } from '../types/fileStatus';
import { supabase } from '../../src/services/supabaseClient';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';
import { hasAuthorizedAccessAtom, isDeviceAuthorizedAtom } from '../atoms/profile';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

export interface FileStatusConnection {
    connectionStatus: ConnectionStatus;
    lastError: string | null;
    lastDataReceived?: Date;
}

const formatStatus = (statusData: any): FileStatus => ({
    ...statusData,
    total_files: Number(statusData.total_files || 0),
    // Upload status
    upload_pending: Number(statusData.upload_pending || 0),
    upload_completed: Number(statusData.upload_completed || 0),
    upload_failed: Number(statusData.upload_failed || 0),
    upload_plan_limit: Number(statusData.upload_plan_limit || 0),
    // Text status
    text_queued: Number(statusData.text_queued || 0),
    text_processing: Number(statusData.text_processing || 0),
    text_completed: Number(statusData.text_completed || 0),
    text_failed_system: Number(statusData.text_failed_system || 0),
    text_failed_user: Number(statusData.text_failed_user || 0),
    text_plan_limit: Number(statusData.text_plan_limit || 0),
    text_unsupported_file: Number(statusData.text_unsupported_file || 0),
    // Markdown status
    md_queued: Number(statusData.md_queued || 0),
    md_processing: Number(statusData.md_processing || 0),
    md_completed: Number(statusData.md_completed || 0),
    md_failed_system: Number(statusData.md_failed_system || 0),
    md_failed_user: Number(statusData.md_failed_user || 0),
    md_plan_limit: Number(statusData.md_plan_limit || 0),
    md_unsupported_file: Number(statusData.md_unsupported_file || 0),
    // Docling status
    docling_queued: Number(statusData.docling_queued || 0),
    docling_processing: Number(statusData.docling_processing || 0),
    docling_completed: Number(statusData.docling_completed || 0),
    docling_failed_system: Number(statusData.docling_failed_system || 0),
    docling_failed_user: Number(statusData.docling_failed_user || 0),
    docling_plan_limit: Number(statusData.docling_plan_limit || 0),
    docling_unsupported_file: Number(statusData.docling_unsupported_file || 0),
});

/**
 * Fetches and formats the file status for a given user
 * @param userId The ID of the user
 * @returns The formatted file status, or null if not found or an error occurs
 */
export const fetchFileStatus = async (userId: string): Promise<FileStatus | null> => {
    try {
        const { data, error } = await supabase
            .from('files_status')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            logger(`useFileStatus: Error fetching file status for user ${userId}: ${error.message}`, 3);
            return null;
        }

        return data ? formatStatus(data) : null;
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger(`useFileStatus: Exception fetching file status for user ${userId}: ${errorMessage}`, 3);
        return null;
    }
};

/**
 * Hook that establishes and maintains a Supabase realtime connection for file status updates.
 * Follows Supabase best practices:
 * - Leverages built-in automatic reconnection
 * - Monitors WebSocket state through channel events
 * - Handles authentication state changes properly
 * - Implements proper cleanup to prevent memory leaks
 * - Detects reconnections and re-establishes subscriptions
 */
export const useFileStatus = (): FileStatusConnection => {
    const setFileStatus = useSetAtom(fileStatusAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const user = useAtomValue(userAtom);

    const [connection, setConnection] = useState<FileStatusConnection>({
        connectionStatus: 'idle',
        lastError: null,
        lastDataReceived: undefined,
    });

    const channelRef = useRef<RealtimeChannel | null>(null);
    const userIdRef = useRef<string | null>(null);
    const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isReconnectingRef = useRef(false);

    // Handle data changes from realtime subscription
    const handleDataChange = useCallback((payload: any) => {
        const now = new Date();
        setConnection(prev => ({
            ...prev,
            lastDataReceived: now
        }));

        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            setFileStatus(formatStatus(payload.new));
        } else if (payload.eventType === 'DELETE') {
            setFileStatus(null);
        }
    }, [setFileStatus]);

    // Re-establish subscription (used for reconnection)
    const reestablishSubscription = useCallback(async (userId: string) => {
        if (isReconnectingRef.current) {
            logger('useFileStatus: Reestablish already in progress, skipping', 1);
            return;
        }

        isReconnectingRef.current = true;
        logger(`useFileStatus: Re-establishing subscription for user ${userId}`, 1);

        try {
            // Clean up existing channel
            if (channelRef.current) {
                await channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            }

            // Refresh auth token if needed
            const { data: sessionData } = await supabase.auth.getSession();
            if (sessionData.session?.access_token) {
                supabase.realtime.setAuth(sessionData.session.access_token);
            }

            // Re-fetch initial data
            const initialStatus = await fetchFileStatus(userId);
            setFileStatus(initialStatus);

            // Create new subscription
            const channel = supabase
                .channel(`file-status:${userId}`)
                .on<FileStatus>('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'files_status',
                    filter: `user_id=eq.${userId}`
                }, handleDataChange)
                .subscribe(handleSubscriptionStatus);

            channelRef.current = channel;
            
            setConnection(prev => ({
                ...prev,
                connectionStatus: 'reconnecting'
            }));

        } catch (error) {
            logger(`useFileStatus: Reestablish failed: ${error instanceof Error ? error.message : String(error)}`, 3);
            setConnection(prev => ({
                ...prev,
                connectionStatus: 'error',
                lastError: 'Reconnection failed'
            }));
        } finally {
            isReconnectingRef.current = false;
        }
    }, [handleDataChange, setFileStatus]);

    // Handle subscription status changes
    const handleSubscriptionStatus = useCallback((status: string, err?: Error) => {
        logger(`useFileStatus: Subscription status changed to ${status}${err ? ` with error: ${err.message}` : ''}`, err ? 3 : 1);

        switch (status) {
            case REALTIME_SUBSCRIBE_STATES.SUBSCRIBED:
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'connected',
                    lastError: null
                }));
                isReconnectingRef.current = false;
                break;
            case REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR:
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'error',
                    lastError: err?.message || 'Channel error'
                }));
                
                // Schedule reconnection attempt if we have a user
                if (userIdRef.current && !isReconnectingRef.current) {
                    if (reconnectTimeoutRef.current) {
                        clearTimeout(reconnectTimeoutRef.current);
                    }
                    reconnectTimeoutRef.current = setTimeout(() => {
                        if (userIdRef.current) {
                            reestablishSubscription(userIdRef.current);
                        }
                    }, 5000); // Wait 5 seconds before attempting reconnection
                }
                break;
            case REALTIME_SUBSCRIBE_STATES.TIMED_OUT:
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'error',
                    lastError: 'Connection timed out'
                }));
                break;
            case REALTIME_SUBSCRIBE_STATES.CLOSED:
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'disconnected',
                    lastError: err?.message || null
                }));
                break;
        }
    }, [reestablishSubscription]);

    // Setup realtime connection
    const setupConnection = useCallback(async (userId: string) => {
        try {
            logger(`useFileStatus: Setting up connection for user ${userId}`, 1);

            // Clear any pending reconnection attempts
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }

            // Fetch initial data
            const initialStatus = await fetchFileStatus(userId);
            setFileStatus(initialStatus);

            // Set auth for private channels (if needed)
            const { data: sessionData } = await supabase.auth.getSession();
            if (sessionData.session?.access_token) {
                supabase.realtime.setAuth(sessionData.session.access_token);
            }

            // Create and configure channel
            const channel = supabase
                .channel(`file-status:${userId}`)
                .on<FileStatus>('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'files_status',
                    filter: `user_id=eq.${userId}`
                }, handleDataChange)
                .subscribe(handleSubscriptionStatus);

            channelRef.current = channel;
            userIdRef.current = userId;

            setConnection(prev => ({
                ...prev,
                connectionStatus: 'connecting',
                lastError: null
            }));

            return channel;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger(`useFileStatus: Setup failed: ${errorMessage}`, 3);
            setConnection(prev => ({
                ...prev,
                connectionStatus: 'error',
                lastError: errorMessage
            }));
            throw error;
        }
    }, [handleDataChange, handleSubscriptionStatus, setFileStatus]);

    // Cleanup connection
    const cleanupConnection = useCallback(async () => {
        // Clear any pending reconnection attempts
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        
        isReconnectingRef.current = false;

        if (channelRef.current) {
            logger(`useFileStatus: Cleaning up connection for user ${userIdRef.current}`, 1);
            
            await channelRef.current.unsubscribe();
            supabase.realtime.removeChannel(channelRef.current);
            channelRef.current = null;
            userIdRef.current = null;
            
            setConnection({
                connectionStatus: 'idle',
                lastError: null,
                lastDataReceived: undefined
            });
            setFileStatus(null);
        }
    }, [setFileStatus]);

    // Main effect for managing connection lifecycle
    useEffect(() => {
        const isEligible = isAuthenticated && user && hasAuthorizedAccess && isDeviceAuthorized;
        const currentUserId = user?.id;
        const shouldConnect = isEligible && currentUserId;
        const userChanged = currentUserId !== userIdRef.current;

        if (shouldConnect) {
            if (!channelRef.current || userChanged) {
                // Clean up existing connection if user changed
                if (channelRef.current && userChanged) {
                    cleanupConnection();
                }
                
                // Setup new connection
                setupConnection(currentUserId);
            }
        } else {
            // Clean up connection when no longer eligible
            if (channelRef.current) {
                cleanupConnection();
            }
        }

        // Cleanup on unmount
        return () => {
            cleanupConnection();
        };
    }, [isAuthenticated, user, hasAuthorizedAccess, isDeviceAuthorized, setupConnection, cleanupConnection]);

    // Handle auth state changes for token refresh
    useEffect(() => {
        const handleAuthStateChange = (event: string, session: any) => {
            if (event === 'TOKEN_REFRESHED' && channelRef.current && session?.access_token) {
                logger('useFileStatus: Token refreshed, updating realtime auth', 1);
                supabase.realtime.setAuth(session.access_token);
            }
        };

        const { data: { subscription } } = supabase.auth.onAuthStateChange(handleAuthStateChange);

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    return connection;
};