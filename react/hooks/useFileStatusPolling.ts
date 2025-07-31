import { useEffect, useRef, useState, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { fileStatusAtom } from '../atoms/files';
import { FileStatus } from '../types/fileStatus';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';
import { hasAuthorizedAccessAtom, isDeviceAuthorizedAtom } from '../atoms/profile';
import { fetchFileStatus, FileStatusConnection } from './useFileStatus';
import { isEqual } from 'lodash';

/**
 * Adaptive polling configuration based on data freshness
 * Reduces server load while maintaining responsiveness
 */
const POLLING_CONFIG = [
    { thresholdSeconds: 0, intervalSeconds: 4 },     // 0-60s: poll every 4s
    { thresholdSeconds: 60, intervalSeconds: 10 },    // 60-120s: poll every 10s  
    { thresholdSeconds: 120, intervalSeconds: 20 },   // 120s+: poll every 20s
];

/**
 * Connection status for the polling hook, including polling-specific details.
 */
export interface FileStatusPollingConnection extends FileStatusConnection {
    currentPollingInterval: number;
    lastDataChange?: Date;
}

/**
 * Determines the appropriate polling interval based on time since last data change
 * @param lastDataChange Date of last data change, or undefined if no change yet
 * @returns Polling interval in seconds
 */
const getPollingInterval = (lastDataChange?: Date): number => {
    if (!lastDataChange) {
        return POLLING_CONFIG[0].intervalSeconds;
    }

    const secondsSinceLastChange = (Date.now() - lastDataChange.getTime()) / 1000;
    
    // Find the appropriate config entry by iterating in reverse order
    for (let i = POLLING_CONFIG.length - 1; i >= 0; i--) {
        const config = POLLING_CONFIG[i];
        if (secondsSinceLastChange >= config.thresholdSeconds) {
            return config.intervalSeconds;
        }
    }
    
    return POLLING_CONFIG[0].intervalSeconds;
};

/**
 * Hook that polls file status updates at adaptive intervals based on data freshness.
 * 
 * Polling frequency adapts based on when data was last updated:
 * - 0-60s since last change: poll every 4s
 * - 60-120s since last change: poll every 10s  
 * - 120s+ since last change: poll every 20s
 * 
 * This provides real-time-like updates when data is actively changing while
 * reducing server load when data is stable.
 * @returns The connection status and polling details.
 */
export const useFileStatusPolling = (): FileStatusPollingConnection => {
    const setFileStatus = useSetAtom(fileStatusAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const user = useAtomValue(userAtom);

    const [connection, setConnection] = useState<FileStatusPollingConnection>({
        connectionStatus: 'idle',
        lastError: null,
        lastDataReceived: undefined,
        lastDataChange: undefined,
        currentPollingInterval: POLLING_CONFIG[0].intervalSeconds,
    });

    const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const userIdRef = useRef<string | null>(null);
    const lastFileStatusRef = useRef<FileStatus | null>(null);
    const isPollingRef = useRef(false);
    const lastDataChangeRef = useRef<Date | undefined>();
    const retryCountRef = useRef(0);
    const isRetryingRef = useRef(false);
    const MAX_RETRIES = 3;

    const cleanupPolling = useCallback(() => {
        if (pollingTimeoutRef.current) {
            clearTimeout(pollingTimeoutRef.current);
            pollingTimeoutRef.current = null;
        }
        isPollingRef.current = false;
        isRetryingRef.current = false;
    }, []);

    const scheduleNextPoll = useCallback(() => {
        if (!userIdRef.current) return;
        
        const nextIntervalSeconds = getPollingInterval(lastDataChangeRef.current);
        setConnection(prev => ({ ...prev, currentPollingInterval: nextIntervalSeconds }));

        const currentUserId = userIdRef.current;
        pollingTimeoutRef.current = setTimeout(() => {
            // Double-check the user hasn't changed
            if (userIdRef.current === currentUserId) {
                poll();
            }
        }, nextIntervalSeconds * 1000);
    }, []);

    const poll = useCallback(async () => {
        if (!userIdRef.current || isPollingRef.current) {
            return;
        }

        isPollingRef.current = true;
        
        // Only set polling status if we're not already connected
        setConnection(prev => ({ 
            ...prev, 
            connectionStatus: prev.connectionStatus === 'connected' ? 'connected' : 'polling' 
        }));

        try {
            const currentStatus = await fetchFileStatus(userIdRef.current);
            
            // Check if we got a null response, which could indicate an error
            // or legitimately no data. We need to distinguish between these cases.
            if (currentStatus === null && lastFileStatusRef.current === null) {
                // This might be an error case - we should check if this is the first poll
                // or if we previously had data
                const isFirstPoll = !connection.lastDataReceived;
                if (!isFirstPoll) {
                    // We previously had successful polls but now getting null - this might be an error
                    logger(`useFileStatusPolling: Received null response after previously successful polls for user ${userIdRef.current}`, 2);
                }
            }

            const now = new Date();
            const hasDataChanged = !isEqual(currentStatus, lastFileStatusRef.current);

            // Reset retry count and retry flag on successful poll
            retryCountRef.current = 0;
            isRetryingRef.current = false;

            if (hasDataChanged) {
                const changeTime = now;
                lastDataChangeRef.current = changeTime;
                lastFileStatusRef.current = currentStatus;
                setFileStatus(currentStatus);
                logger(`useFileStatusPolling: Data changed for user ${userIdRef.current}`, 1);
                
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'connected',
                    lastDataReceived: now,
                    lastDataChange: changeTime,
                    lastError: null,
                }));
            } else {
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'connected', 
                    lastDataReceived: now,
                    lastError: null,
                }));
            }

            // Schedule next poll after successful completion
            scheduleNextPoll();

        } catch (error) {
            retryCountRef.current++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger(`useFileStatusPolling: Polling failed for user ${userIdRef.current}: ${errorMessage}`, 3);
            
            // If we can retry, set status to 'reconnecting', otherwise 'error'
            if (retryCountRef.current <= MAX_RETRIES) {
                isRetryingRef.current = true;
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'reconnecting',
                    lastError: errorMessage,
                }));

                // Schedule retry with exponential backoff
                const backoffDelay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
                pollingTimeoutRef.current = setTimeout(() => {
                    if (userIdRef.current) {
                        poll();
                    }
                }, backoffDelay);
            } else {
                isRetryingRef.current = false;
                setConnection(prev => ({
                    ...prev,
                    connectionStatus: 'error',
                    lastError: errorMessage,
                }));
            }
        } finally {
            isPollingRef.current = false;
        }
    }, [setFileStatus, scheduleNextPoll, connection.lastDataReceived]);

    const setupPolling = useCallback(async (userId: string) => {
        logger(`useFileStatusPolling: Setting up polling for user ${userId}`, 1);
        cleanupPolling();
        userIdRef.current = userId;
        
        // Set connecting status before starting
        setConnection(prev => ({
            ...prev,
            connectionStatus: 'connecting',
            lastError: null,
        }));
        
        // Fetch initial data immediately
        try {
            const initialStatus = await fetchFileStatus(userId);
            setFileStatus(initialStatus);
            lastFileStatusRef.current = initialStatus;
            
            // Set connected status after successful initial fetch
            setConnection(prev => ({
                ...prev,
                connectionStatus: 'connected',
                lastDataReceived: new Date(),
                lastError: null,
            }));
            
            // Start regular polling
            scheduleNextPoll();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger(`useFileStatusPolling: Initial fetch failed: ${errorMessage}`, 3);
            setConnection(prev => ({
                ...prev,
                connectionStatus: 'error',
                lastError: errorMessage,
            }));
        }
    }, [cleanupPolling, setFileStatus, scheduleNextPoll]);
    
    const cleanupConnection = useCallback(() => {
        if (!userIdRef.current) return;
        logger(`useFileStatusPolling: Cleaning up polling for user ${userIdRef.current}`, 1);
        
        cleanupPolling();
        userIdRef.current = null;
        lastFileStatusRef.current = null;
        lastDataChangeRef.current = undefined;
        retryCountRef.current = 0;
        
        setConnection({
            connectionStatus: 'idle',
            lastError: null,
            lastDataReceived: undefined,
            lastDataChange: undefined,
            currentPollingInterval: POLLING_CONFIG[0].intervalSeconds,
        });
        setFileStatus(null);
    }, [cleanupPolling, setFileStatus]);

    useEffect(() => {
        const isEligible = isAuthenticated && user && hasAuthorizedAccess && isDeviceAuthorized;
        const currentUserId = user?.id;
        const shouldBePolling = isEligible && currentUserId;
        const isCurrentlyPolling = !!userIdRef.current;
        const userChanged = currentUserId !== userIdRef.current;

        if (shouldBePolling) {
            if (!isCurrentlyPolling || userChanged) {
                // Clean up existing connection if user changed
                if (isCurrentlyPolling && userChanged) {
                    setConnection(prev => ({ ...prev, connectionStatus: 'disconnected' }));
                    cleanupConnection();
                }
                setupPolling(currentUserId);
            }
        } else {
            if (isCurrentlyPolling) {
                setConnection(prev => ({ ...prev, connectionStatus: 'disconnected' }));
                cleanupConnection();
            }
        }

        return cleanupConnection;
    }, [isAuthenticated, user, hasAuthorizedAccess, isDeviceAuthorized, setupPolling, cleanupConnection]);

    return connection;
};