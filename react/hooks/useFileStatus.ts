import { useEffect, useRef } from 'react';
import { useSetAtom, useAtom, useAtomValue } from 'jotai';
import { atom } from 'jotai';
import { RealtimeChannel } from "@supabase/supabase-js";
import { fileStatusAtom } from '../atoms/files';
import { FileStatus } from '../types/fileStatus';
import { supabase } from '../../src/services/supabaseClient';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';
import { hasAuthorizedAccessAtom, isDeviceAuthorizedAtom } from '../atoms/profile';

const maxRetries = 6;
const baseRetryDelay = 1000; // 1 second

// Reduced monitoring - focus on connection health, not data activity
const TOKEN_REFRESH_CHECK_INTERVAL = 300000; // 5 minutes - only check token expiration
const CONNECTION_TIMEOUT = 15000; // 15 seconds - initial connection timeout

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'retrying' | 'failed';

export interface FileStatusConnection {
    connectionStatus: ConnectionStatus;
    retryCount: number;
    lastError: string | null;
    lastDataReceived?: Date;
}

// --- Centralized state ---
const fileStatusConnectionAtom = atom<FileStatusConnection>({
    connectionStatus: 'idle',
    retryCount: 0,
    lastError: null,
    lastDataReceived: undefined,
});

// --- Module-level subscription management ---
let subscriberCount = 0;
let channelRef: RealtimeChannel | null = null;
let retryTimeoutRef: ReturnType<typeof setTimeout> | null = null;
let stopTimeoutRef: ReturnType<typeof setTimeout> | null = null;
let tokenCheckIntervalRef: ReturnType<typeof setInterval> | null = null;
let currentUserId: string | null = null;
let isConnecting = false;

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

    // Markdown status,
    md_queued: Number(statusData.md_queued || 0),
    md_processing: Number(statusData.md_processing || 0),
    md_completed: Number(statusData.md_completed || 0),
    md_failed_system: Number(statusData.md_failed_system || 0),
    md_failed_user: Number(statusData.md_failed_user || 0),
    md_plan_limit: Number(statusData.md_plan_limit || 0),
    md_unsupported_file: Number(statusData.md_unsupported_file || 0),

    docling_queued: Number(statusData.docling_queued || 0),
    docling_processing: Number(statusData.docling_processing || 0),
    docling_completed: Number(statusData.docling_completed || 0),
    docling_failed_system: Number(statusData.docling_failed_system || 0),
    docling_failed_user: Number(statusData.docling_failed_user || 0),
    docling_plan_limit: Number(statusData.docling_plan_limit || 0),
    docling_unsupported_file: Number(statusData.docling_unsupported_file || 0),
});

/**
 * Fetches and formats the file status for a given user.
 * @param userId The ID of the user.
 * @returns The formatted file status, or null if not found or an error occurs.
 */
export const fetchFileStatus = async (userId: string): Promise<FileStatus | null> => {
    try {
        const { data, error } = await supabase
            .from('files_status')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            logger(`useFileStatus fetch: Error fetching file status for user ${userId}: ${error.message}`, 3);
            return null;
        }

        return data ? formatStatus(data) : null;
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger(`useFileStatus fetch: Exception fetching file status for user ${userId}: ${errorMessage}`, 3);
        return null;
    }
};

const getRetryDelay = (attempt: number): number => {
    return Math.min(baseRetryDelay * Math.pow(2, attempt), 30000);
};

/**
 * Refreshes the auth token if it's expiring soon and updates the realtime connection
 */
const refreshTokenIfNeeded = async (): Promise<boolean> => {
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error || !session) {
            logger('useFileStatus refreshTokenIfNeeded: No valid session during token refresh check', 2);
            return false;
        }
        
        // Check if token expires within 5 minutes
        const expiresAt = session.expires_at! * 1000;
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;
        
        if (expiresAt - now < fiveMinutes) {
            logger('useFileStatus refreshTokenIfNeeded: Token expiring soon, refreshing...', 1);
            const { error: refreshError } = await supabase.auth.refreshSession();
            
            if (refreshError) {
                logger(`useFileStatus refreshTokenIfNeeded: Token refresh failed: ${refreshError.message}`, 3);
                return false;
            }
            
            // Update realtime auth with new token
            const { data: newSession } = await supabase.auth.getSession();
            if (newSession.session?.access_token) {
                supabase.realtime.setAuth(newSession.session.access_token);
                logger('useFileStatus refreshTokenIfNeeded: Token refreshed and realtime auth updated', 1);
            }
        }
        
        return true;
    } catch (err) {
        logger(`useFileStatus refreshTokenIfNeeded: Token refresh exception: ${err instanceof Error ? err.message : String(err)}`, 3);
        return false;
    }
};

/**
 * Starts periodic token checking (much less aggressive than before)
 */
const startTokenMonitoring = (
    setConnection: (update: FileStatusConnection | ((prev: FileStatusConnection) => FileStatusConnection)) => void,
    scheduleRetry: () => void
) => {
    if (tokenCheckIntervalRef) {
        clearInterval(tokenCheckIntervalRef);
    }
    
    tokenCheckIntervalRef = setInterval(async () => {
        if (!channelRef || !currentUserId) return;
        
        // Only check token expiration - don't check data staleness
        const tokenValid = await refreshTokenIfNeeded();
        if (!tokenValid) {
            logger('useFileStatus startHealthMonitoring: Token refresh failed, triggering reconnection', 2);
            setConnection((prev) => ({
                ...prev,
                connectionStatus: 'disconnected',
                lastError: 'Token refresh failed'
            }));
            scheduleRetry();
        }
    }, TOKEN_REFRESH_CHECK_INTERVAL);
};

/**
 * Stops token monitoring
 */
const stopTokenMonitoring = () => {
    if (tokenCheckIntervalRef) {
        clearInterval(tokenCheckIntervalRef);
        tokenCheckIntervalRef = null;
    }
};

const stopSubscription = async (
    setConnection: (update: FileStatusConnection | ((prev: FileStatusConnection) => FileStatusConnection)) => void,
    setFileStatus: (update: FileStatus | null) => void
) => {
    logger(`useFileStatus Manager: Stopping subscription for user ${currentUserId}.`);
    isConnecting = false;
    
    // Clear all timers and intervals
    if (retryTimeoutRef) {
        clearTimeout(retryTimeoutRef);
        retryTimeoutRef = null;
    }
    stopTokenMonitoring();
    
    if (channelRef) {
        await channelRef.unsubscribe();
        supabase.realtime.removeChannel(channelRef);
        channelRef = null;
    }
    
    currentUserId = null;
    setConnection({ 
        connectionStatus: 'idle', 
        retryCount: 0, 
        lastError: null,
        lastDataReceived: undefined
    });
    setFileStatus(null);
};

const startSubscription = async (
    userId: string,
    setConnection: (update: FileStatusConnection | ((prev: FileStatusConnection) => FileStatusConnection)) => void,
    setFileStatus: (update: FileStatus | null) => void
) => {
    if (channelRef && currentUserId === userId) {
        logger("useFileStatus Manager: Subscription already active.");
        return;
    }

    if (channelRef) {
        await stopSubscription(setConnection, setFileStatus);
    }
    
    currentUserId = userId;
    let retryCount = 0;

    const scheduleRetry = () => {
        if (retryCount >= maxRetries) {
            logger(`useFileStatus Manager: Max retries exceeded for ${userId}.`, 3);
            setConnection({ 
                connectionStatus: 'failed', 
                retryCount, 
                lastError: "Max retries exceeded."
            });
            isConnecting = false;
            return;
        }
        
        const delay = getRetryDelay(retryCount);
        retryCount++;
        logger(`useFileStatus Manager: Scheduling retry ${retryCount} in ${delay}ms.`);
        
        if (retryTimeoutRef) clearTimeout(retryTimeoutRef);
        retryTimeoutRef = setTimeout(() => setup(true), delay);
    };

    const setup = async (isRetry: boolean = false) => {
        if (isConnecting) {
            logger("useFileStatus Manager: Setup already in progress, skipping.");
            return;
        }
        isConnecting = true;

        // Clean up any previous attempt
        if (channelRef) {
            try {
                await channelRef.unsubscribe();
            } catch (e) {
                logger(`useFileStatus Manager: Unsubscribe in retry failed: ${(e as Error).message}`, 3);
            }
            supabase.realtime.removeChannel(channelRef);
            channelRef = null;
        }

        try {
            setConnection({
                connectionStatus: isRetry ? 'retrying' : 'connecting',
                retryCount: retryCount,
                lastError: null
            });
            
            logger(`useFileStatus Manager: Fetching initial status for ${userId}.`);
            const initialStatus = await fetchFileStatus(userId);
            setFileStatus(initialStatus);

            logger(`useFileStatus Manager: Setting up realtime for ${userId}.`);
            
            // Ensure we have a valid token
            const tokenValid = await refreshTokenIfNeeded();
            if (!tokenValid) {
                throw new Error('Unable to establish valid auth token');
            }

            const { data: sessionData } = await supabase.auth.getSession();
            if (!sessionData.session?.access_token) {
                throw new Error('No access token for realtime.');
            }
            
            supabase.realtime.setAuth(sessionData.session.access_token);

            // Add connection timeout for initial setup only
            const connectionTimeout = setTimeout(() => {
                if (isConnecting) {
                    logger('useFileStatus: Connection timeout during setup', 2);
                    setConnection({
                        connectionStatus: 'disconnected',
                        retryCount,
                        lastError: 'Connection timeout during setup'
                    });
                    isConnecting = false;
                    scheduleRetry();
                }
            }, CONNECTION_TIMEOUT);

            channelRef = supabase
                .channel(`public:file-status:${userId}`)
                .on<FileStatus>('postgres_changes', { 
                    event: '*', 
                    schema: 'public', 
                    table: 'files_status', 
                    filter: `user_id=eq.${userId}` 
                }, (payload) => {
                    // Simply track when we receive data (for informational purposes)
                    // but don't use this for connection health decisions
                    const now = new Date();
                    setConnection((prev) => ({
                        ...prev,
                        lastDataReceived: now
                    }));
                    
                    // Process the payload
                    if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                        setFileStatus(formatStatus(payload.new));
                    } else if (payload.eventType === 'DELETE') {
                        setFileStatus(null);
                    }
                })
                .subscribe((status, err) => {
                    clearTimeout(connectionTimeout);
                    
                    if (err) {
                        logger(`useFileStatus Manager: Subscription error: ${err.message}`, 3);
                        setConnection({ 
                            connectionStatus: 'disconnected', 
                            retryCount, 
                            lastError: err.message
                        });
                        isConnecting = false;
                        scheduleRetry();
                    } else if (status === 'SUBSCRIBED') {
                        logger(`useFileStatus Manager: Subscription successful for ${userId}.`);
                        retryCount = 0;
                        const now = new Date();
                        setConnection({ 
                            connectionStatus: 'connected', 
                            retryCount: 0, 
                            lastError: null,
                            lastDataReceived: now
                        });
                        isConnecting = false;
                        
                        // Start token monitoring (much less aggressive than before)
                        startTokenMonitoring(setConnection, scheduleRetry);
                    }
                });
        } catch (err: any) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger(`useFileStatus Manager: Setup failed: ${errorMessage}`, 3);
            setConnection({ 
                connectionStatus: 'disconnected', 
                retryCount, 
                lastError: errorMessage
            });
            isConnecting = false;
            scheduleRetry();
        }
    };

    setup();
};

/**
 * Hook that fetches the user's file status, keeps the fileStatusAtom updated,
 * and subscribes to realtime changes with retry logic and token management.
 * This hook can be used by multiple components simultaneously without conflicts.
 */
export const useFileStatus = (): FileStatusConnection => {
    const setFileStatus = useSetAtom(fileStatusAtom);
    const [connection, setConnection] = useAtom(fileStatusConnectionAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const user = useAtomValue(userAtom);

    const isActiveSubscriber = useRef(false);
    const lastUserId = useRef<string | null>(null);

    useEffect(() => {
        const isEligible = isAuthenticated && user && hasAuthorizedAccess && isDeviceAuthorized;

        if (isEligible && !isActiveSubscriber.current) {
            if (stopTimeoutRef) {
                clearTimeout(stopTimeoutRef);
                stopTimeoutRef = null;
            }
            subscriberCount++;
            isActiveSubscriber.current = true;
            logger(`useFileStatus Hook: Subscriber added. Count: ${subscriberCount}.`);
            if (subscriberCount === 1) {
                startSubscription(user.id, setConnection, setFileStatus);
            }
        } else if (!isEligible && isActiveSubscriber.current) {
            subscriberCount--;
            isActiveSubscriber.current = false;
            logger(`useFileStatus Hook: Subscriber removed. Count: ${subscriberCount}.`);
            if (subscriberCount === 0) {
                stopTimeoutRef = setTimeout(() => {
                    stopSubscription(setConnection, setFileStatus);
                }, 100);
            }
        }

        // User switched while still subscribed
        if (isEligible && isActiveSubscriber.current && user!.id !== lastUserId.current) {
            lastUserId.current = user!.id;
            startSubscription(user!.id, setConnection, setFileStatus);
        }

        return () => {
            if (isActiveSubscriber.current) {
                subscriberCount--;
                isActiveSubscriber.current = false;
                logger(`useFileStatus Hook: Subscriber removed on unmount. Count: ${subscriberCount}.`);
                if (subscriberCount === 0) {
                    stopTimeoutRef = setTimeout(() => {
                        stopSubscription(setConnection, setFileStatus);
                    }, 100);
                }
            }
        };
    }, [isAuthenticated, user, hasAuthorizedAccess, isDeviceAuthorized, setConnection, setFileStatus]);

    return connection;
};