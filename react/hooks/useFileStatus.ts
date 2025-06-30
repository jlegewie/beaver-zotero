import { useEffect, useRef } from 'react';
import { useSetAtom, useAtom, useAtomValue } from 'jotai';
import { atom } from 'jotai';
import { RealtimeChannel } from "@supabase/supabase-js";
import { fileStatusAtom } from '../atoms/files';
import { FileStatus } from '../types/fileStatus';
import { supabase } from '../../src/services/supabaseClient';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';
import { hasAuthorizedAccessAtom } from '../atoms/profile';

const maxRetries = 6;
const baseRetryDelay = 1000; // 1 second

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'retrying' | 'failed';

export interface FileStatusConnection {
    connectionStatus: ConnectionStatus;
    retryCount: number;
    lastError: string | null;
}

// --- Centralized state ---
const fileStatusConnectionAtom = atom<FileStatusConnection>({
    connectionStatus: 'idle',
    retryCount: 0,
    lastError: null,
});

// --- Module-level subscription management ---
let subscriberCount = 0;
let channelRef: RealtimeChannel | null = null;
let retryTimeoutRef: ReturnType<typeof setTimeout> | null = null;
let stopTimeoutRef: ReturnType<typeof setTimeout> | null = null;
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

const getRetryDelay = (attempt: number): number => {
    return Math.min(baseRetryDelay * Math.pow(2, attempt), 30000);
};

// These manager functions operate on the module-level state and Jotai atoms.
const stopSubscription = async (
    setConnection: (update: FileStatusConnection | ((prev: FileStatusConnection) => FileStatusConnection)) => void,
    setFileStatus: (update: FileStatus | null) => void
) => {
    logger(`useFileStatus Manager: Stopping subscription for user ${currentUserId}.`);
    isConnecting = false;
    if (retryTimeoutRef) {
        clearTimeout(retryTimeoutRef);
        retryTimeoutRef = null;
    }
    if (channelRef) {
        await channelRef.unsubscribe();
        supabase.realtime.removeChannel(channelRef);
        channelRef = null;
    }
    currentUserId = null;
    setConnection({ connectionStatus: 'idle', retryCount: 0, lastError: null });
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

    const setup = async (isRetry: boolean = false) => {
        if (isConnecting) {
            logger("useFileStatus Manager: Setup already in progress, skipping.");
            return;
        }
        isConnecting = true;

        // Clean up any previous attempt before trying to establish a new one.
        // This is crucial for the retry logic, as retries call setup() directly.
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
            const { data, error } = await supabase.from('files_status').select('*').eq('user_id', userId).maybeSingle();
            if (error) throw new Error(`Initial fetch failed: ${error.message}`);
            setFileStatus(data ? formatStatus(data) : null);

            logger(`useFileStatus Manager: Setting up realtime for ${userId}.`);
            const { data: sessionData } = await supabase.auth.getSession();
            if (!sessionData.session?.access_token) throw new Error('No access token for realtime.');
            supabase.realtime.setAuth(sessionData.session.access_token);

            channelRef = supabase
                .channel(`public:file-status:${userId}`)
                .on<FileStatus>('postgres_changes', { event: '*', schema: 'public', table: 'files_status', filter: `user_id=eq.${userId}` },
                    (payload) => {
                        // logger(`useFileStatus Manager: Received event: ${payload.eventType}`);
                        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                            setFileStatus(formatStatus(payload.new));
                        } else if (payload.eventType === 'DELETE') {
                            setFileStatus(null);
                        }
                    }
                )
                .subscribe((status, err) => {
                    if (err) {
                        logger(`useFileStatus Manager: Subscription error: ${err.message}`, 3);
                        setConnection({ connectionStatus: 'disconnected', retryCount, lastError: err.message });
                        scheduleRetry();
                    } else if (status === 'SUBSCRIBED') {
                        logger(`useFileStatus Manager: Subscription successful for ${userId}.`);
                        retryCount = 0;
                        setConnection({ connectionStatus: 'connected', retryCount: 0, lastError: null });
                        isConnecting = false; // Release lock on success
                    }
                });
        } catch (err: any) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger(`useFileStatus Manager: Setup failed: ${errorMessage}`, 3);
            setConnection({ connectionStatus: 'disconnected', retryCount, lastError: errorMessage });
            isConnecting = false; // Release lock on failure
            scheduleRetry();
        }
    };

    const scheduleRetry = () => {
        if (retryCount >= maxRetries) {
            logger(`useFileStatus Manager: Max retries exceeded for ${userId}.`, 3);
            setConnection({ connectionStatus: 'failed', retryCount, lastError: "Max retries exceeded." });
            isConnecting = false; // Release lock on max retries
            return;
        }
        const delay = getRetryDelay(retryCount);
        retryCount++;
        logger(`useFileStatus Manager: Scheduling retry ${retryCount} in ${delay}ms.`);
        if (retryTimeoutRef) clearTimeout(retryTimeoutRef);
        retryTimeoutRef = setTimeout(() => setup(true), delay);
    };

    setup();
};


/**
 * Hook that fetches the user's file status, keeps the fileStatusAtom updated,
 * and subscribes to realtime changes with retry logic. This hook can be used
 * by multiple components simultaneously without conflicts.
 */
export const useFileStatus = (): FileStatusConnection => {
    const setFileStatus = useSetAtom(fileStatusAtom);
    const [connection, setConnection] = useAtom(fileStatusConnectionAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const user = useAtomValue(userAtom);

    // This ref tracks if the current component instance is "active"
    // and should be counted as a subscriber.
    const isActiveSubscriber = useRef(false);

    const lastUserId = useRef<string | null>(null);
    useEffect(() => {
        const isEligible = isAuthenticated && user && hasAuthorizedAccess;

        if (isEligible && !isActiveSubscriber.current) {
            if (stopTimeoutRef) {
                clearTimeout(stopTimeoutRef);
                stopTimeoutRef = null;
            }
            // This component is becoming an active subscriber
            subscriberCount++;
            isActiveSubscriber.current = true;
            logger(`useFileStatus Hook: Subscriber added. Count: ${subscriberCount}.`);
            if (subscriberCount === 1) {
                startSubscription(user.id, setConnection, setFileStatus);
            }
        } else if (!isEligible && isActiveSubscriber.current) {
            // This component is no longer an active subscriber
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

        // The cleanup function is now robust and always runs on unmount.
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
    }, [isAuthenticated, user, hasAuthorizedAccess, setConnection, setFileStatus]);

    return connection;
};