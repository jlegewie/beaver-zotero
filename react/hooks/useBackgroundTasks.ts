/**
 * React hooks for subscribing to background task state.
 * 
 * These hooks allow UI components to react to background task progress,
 * such as PDF fetching or syncing operations.
 */

import { useState, useEffect, useMemo } from 'react';
import {
    BackgroundTaskState,
    BackgroundTaskType,
    subscribeToTasks,
    getTasksForItem,
    getTasksByType,
    getActiveTasks,
    getAllTasks,
} from '../../src/utils/backgroundTasks';

/**
 * Subscribe to all background tasks and get updates when any task changes.
 * @returns Array of all active and recent tasks
 */
export function useBackgroundTasks(): BackgroundTaskState[] {
    const [tasks, setTasks] = useState<BackgroundTaskState[]>(() => getActiveTasks());

    useEffect(() => {
        const unsubscribe = subscribeToTasks(() => {
            // Re-fetch all active tasks on any change
            setTasks(getActiveTasks());
        });
        return unsubscribe;
    }, []);

    return tasks;
}

/**
 * Subscribe to background tasks for a specific item.
 * @param libraryId - Library ID
 * @param itemKey - Zotero item key
 * @returns Array of tasks for this item
 */
export function useItemBackgroundTasks(
    libraryId: number | undefined,
    itemKey: string | undefined
): BackgroundTaskState[] {
    const [tasks, setTasks] = useState<BackgroundTaskState[]>([]);

    useEffect(() => {
        if (libraryId === undefined || !itemKey) {
            setTasks([]);
            return;
        }

        // Initial fetch
        setTasks(getTasksForItem(libraryId, itemKey));

        // Subscribe to updates
        const unsubscribe = subscribeToTasks((updatedTask) => {
            if (updatedTask.libraryId === libraryId && updatedTask.itemKey === itemKey) {
                setTasks(getTasksForItem(libraryId, itemKey));
            }
        });

        return unsubscribe;
    }, [libraryId, itemKey]);

    return tasks;
}

/**
 * Subscribe to background tasks of a specific type.
 * @param type - Task type to filter by
 * @returns Array of tasks of this type
 */
export function useTasksByType(type: BackgroundTaskType): BackgroundTaskState[] {
    const [tasks, setTasks] = useState<BackgroundTaskState[]>(() => getTasksByType(type));

    useEffect(() => {
        const unsubscribe = subscribeToTasks((updatedTask) => {
            if (updatedTask.type === type) {
                setTasks(getTasksByType(type));
            }
        });
        return unsubscribe;
    }, [type]);

    return tasks;
}

/**
 * Check if a PDF fetch is in progress for an item.
 * @param libraryId - Library ID
 * @param itemKey - Zotero item key
 * @returns Status including isLoading and any error
 */
export function usePdfFetchStatus(
    libraryId: number | undefined,
    itemKey: string | undefined
): { isLoading: boolean; error?: string } {
    const tasks = useItemBackgroundTasks(libraryId, itemKey);

    return useMemo(() => {
        const pdfTasks = tasks.filter(t => t.type === 'pdf_fetch');
        if (pdfTasks.length === 0) {
            return { isLoading: false };
        }

        // Prefer active tasks (pending/running) over completed/failed
        const activeTask = pdfTasks.find(
            t => t.status === 'pending' || t.status === 'running'
        );
        if (activeTask) {
            return { isLoading: true };
        }

        // No active task - find the most recent completed/failed task
        const sortedTasks = pdfTasks
            .filter(t => t.startedAt !== undefined)
            .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
        
        const latestTask = sortedTasks[0] || pdfTasks[0];
        
        return {
            isLoading: false,
            error: latestTask.status === 'failed' ? latestTask.error : undefined,
        };
    }, [tasks]);
}

/**
 * Subscribe to all background tasks (including completed and failed).
 * Tasks are kept for 60 seconds after completion.
 * @returns Array of all tasks
 */
export function useAllBackgroundTasks(): BackgroundTaskState[] {
    const [tasks, setTasks] = useState<BackgroundTaskState[]>(() => getAllTasks());

    useEffect(() => {
        const unsubscribe = subscribeToTasks(() => {
            // Re-fetch all tasks on any change
            setTasks(getAllTasks());
        });
        return unsubscribe;
    }, []);

    return tasks;
}

/**
 * Get summary statistics for all background tasks.
 * Includes active tasks count and failure detection.
 * Useful for showing a global progress indicator.
 */
export function useBackgroundTaskSummary(): {
    activeCount: number;
    pdfFetchCount: number;
    syncCount: number;
    hasFailures: boolean;
    failedCount: number;
} {
    // Use all tasks (not just active) to detect failures
    const allTasks = useAllBackgroundTasks();

    return useMemo(() => {
        const activeTasks = allTasks.filter(
            t => t.status === 'pending' || t.status === 'running'
        );
        const failedTasks = allTasks.filter(t => t.status === 'failed');
        
        return {
            activeCount: activeTasks.length,
            pdfFetchCount: activeTasks.filter(t => t.type === 'pdf_fetch').length,
            syncCount: activeTasks.filter(t => t.type === 'sync').length,
            hasFailures: failedTasks.length > 0,
            failedCount: failedTasks.length,
        };
    }, [allTasks]);
}
