/**
 * Background Task Queue
 *
 * Provides fire-and-forget task execution with state tracking for UI updates.
 * Used for slow operations like PDF fetching and syncing that shouldn't block
 * the main request/response cycle.
 */

import { logger } from './logger';

/** Status of a background task */
export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Type of background task */
export type BackgroundTaskType = 'pdf_fetch' | 'sync' | 'metadata_enrich';

/** State of a background task */
export interface BackgroundTaskState {
    id: string;
    type: BackgroundTaskType;
    status: BackgroundTaskStatus;
    /** Associated Zotero item key (for UI binding) */
    itemKey?: string;
    /** Associated library ID */
    libraryId?: number;
    /** Error message if failed */
    error?: string;
    /** Timestamp when task started */
    startedAt?: number;
    /** Timestamp when task completed */
    completedAt?: number;
    /** Progress message for UI */
    progressMessage?: string;
}

/** Internal task state with cancellation support */
interface InternalTaskState extends BackgroundTaskState {
    abortController: AbortController;
}

/** Registry of active and recent tasks */
const tasks: Map<string, InternalTaskState> = new Map();

/** Listeners for task state changes */
type TaskListener = (task: BackgroundTaskState) => void;
const listeners: Set<TaskListener> = new Set();

/** How long to keep completed tasks in registry (ms) */
const TASK_CLEANUP_DELAY = 60000;

/** Pending sync promises for deduplication, keyed by `libraryId-itemKey` */
const pendingSyncs: Map<string, Promise<void>> = new Map();
/** Queued follow-up syncs when a sync is already in flight */
const queuedSyncs: Map<string, Promise<void>> = new Map();

/** Return a snapshot copy of internal state (without abortController) */
function toPublicState(state: InternalTaskState): BackgroundTaskState {
    return {
        id: state.id,
        type: state.type,
        status: state.status,
        itemKey: state.itemKey,
        libraryId: state.libraryId,
        error: state.error,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        progressMessage: state.progressMessage,
    };
}

/**
 * Schedule a background task for execution.
 * The task runs immediately but doesn't block - returns void synchronously.
 *
 * The task function receives an AbortSignal that is triggered if the task is cancelled.
 * Tasks should check `signal.aborted` at async boundaries and bail out early.
 *
 * @param id - Unique task identifier
 * @param type - Type of task (for filtering/display)
 * @param task - Async function to execute, receives an AbortSignal for cancellation
 * @param options - Optional metadata for the task
 */
export function scheduleBackgroundTask(
    id: string,
    type: BackgroundTaskType,
    task: (signal: AbortSignal) => Promise<void>,
    options?: {
        itemKey?: string;
        libraryId?: number;
        progressMessage?: string;
    }
): void {
    const abortController = new AbortController();

    const state: InternalTaskState = {
        id,
        type,
        status: 'pending',
        itemKey: options?.itemKey,
        libraryId: options?.libraryId,
        progressMessage: options?.progressMessage,
        abortController,
    };

    tasks.set(id, state);
    notifyListeners(toPublicState(state));

    logger(`backgroundTasks: Scheduled task ${id} (${type})`, 2);

    // Execute task asynchronously (fire and forget)
    (async () => {
        // Check if already cancelled before starting
        // If cancelTask already set terminal state and handled cleanup, bail out
        if (abortController.signal.aborted) {
            if (state.status === 'cancelled') {
                return;
            }
            state.status = 'cancelled';
            state.completedAt = Date.now();
            notifyListeners(toPublicState(state));
            scheduleCleanup(id);
            return;
        }

        // Update to running
        state.status = 'running';
        state.startedAt = Date.now();
        notifyListeners(toPublicState(state));

        try {
            await task(abortController.signal);

            // If cancelTask already handled this task while we were awaiting, bail out
            // to avoid double notification and double cleanup scheduling.
            // Note: TS narrows state.status to 'running' here, but cancelTask() can
            // mutate it to 'cancelled' during the await above — hence the cast.
            if ((state.status as BackgroundTaskStatus) === 'cancelled') {
                return;
            }

            if (abortController.signal.aborted) {
                state.status = 'cancelled';
                state.completedAt = Date.now();
                logger(`backgroundTasks: Task ${id} was cancelled during execution`, 2);
            } else {
                state.status = 'completed';
                state.completedAt = Date.now();
                state.progressMessage = undefined;
                logger(`backgroundTasks: Task ${id} completed in ${state.completedAt - state.startedAt!}ms`, 2);
            }
        } catch (error: any) {
            // If cancelTask already handled this task, bail out (see cast note above)
            if ((state.status as BackgroundTaskStatus) === 'cancelled') {
                return;
            }

            if (abortController.signal.aborted) {
                state.status = 'cancelled';
                state.completedAt = Date.now();
                logger(`backgroundTasks: Task ${id} was cancelled`, 2);
            } else {
                state.status = 'failed';
                state.error = error?.message || String(error);
                state.completedAt = Date.now();
                logger(`backgroundTasks: Task ${id} failed: ${state.error}`, 1);
            }
        }

        notifyListeners(toPublicState(state));
        scheduleCleanup(id);
    })();
}

/**
 * Schedule removal of a task from the registry after a delay.
 */
function scheduleCleanup(id: string): void {
    setTimeout(() => {
        const state = tasks.get(id);
        if (state) {
            tasks.delete(id);
            notifyListeners(toPublicState(state));
        }
    }, TASK_CLEANUP_DELAY);
}

/**
 * Cancel a specific task by ID.
 * Signals the task's AbortController. The task should check the signal
 * and stop work at async boundaries.
 */
export function cancelTask(id: string): void {
    const state = tasks.get(id);
    if (state && (state.status === 'pending' || state.status === 'running')) {
        logger(`backgroundTasks: Cancelling task ${id}`, 2);
        state.abortController.abort();
        state.status = 'cancelled';
        state.completedAt = Date.now();
        notifyListeners(toPublicState(state));
        scheduleCleanup(id);
    }
}

/**
 * Cancel all active tasks for a specific item.
 * Use this before deleting an item to prevent background tasks
 * from operating on a deleted item.
 *
 * @param libraryId - Library ID
 * @param itemKey - Item key
 */
export function cancelTasksForItem(libraryId: number, itemKey: string): void {
    for (const [id, task] of tasks.entries()) {
        if (
            task.libraryId === libraryId &&
            task.itemKey === itemKey &&
            (task.status === 'pending' || task.status === 'running')
        ) {
            cancelTask(id);
        }
    }
}

/**
 * Get the current state of a task.
 * @param id - Task identifier
 * @returns Task state snapshot or undefined if not found
 */
export function getTaskState(id: string): BackgroundTaskState | undefined {
    const state = tasks.get(id);
    return state ? toPublicState(state) : undefined;
}

/**
 * Get all tasks for a specific item.
 * @param libraryId - Library ID
 * @param itemKey - Zotero item key
 * @returns Array of task state snapshots
 */
export function getTasksForItem(libraryId: number, itemKey: string): BackgroundTaskState[] {
    const result: BackgroundTaskState[] = [];
    for (const task of tasks.values()) {
        if (task.libraryId === libraryId && task.itemKey === itemKey) {
            result.push(toPublicState(task));
        }
    }
    return result;
}

/**
 * Get all tasks of a specific type.
 * @param type - Task type to filter by
 * @returns Array of task state snapshots
 */
export function getTasksByType(type: BackgroundTaskType): BackgroundTaskState[] {
    const result: BackgroundTaskState[] = [];
    for (const task of tasks.values()) {
        if (task.type === type) {
            result.push(toPublicState(task));
        }
    }
    return result;
}

/**
 * Get all active (pending or running) tasks.
 * @returns Array of active task state snapshots
 */
export function getActiveTasks(): BackgroundTaskState[] {
    const result: BackgroundTaskState[] = [];
    for (const task of tasks.values()) {
        if (task.status === 'pending' || task.status === 'running') {
            result.push(toPublicState(task));
        }
    }
    return result;
}

/**
 * Get all tasks (including completed and failed).
 * Tasks are kept in registry for TASK_CLEANUP_DELAY after completion.
 * @returns Array of all task state snapshots
 */
export function getAllTasks(): BackgroundTaskState[] {
    return Array.from(tasks.values()).map(toPublicState);
}

/**
 * Subscribe to task state changes.
 * @param listener - Callback function called when any task state changes
 * @returns Unsubscribe function
 */
export function subscribeToTasks(listener: TaskListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Notify all listeners of a task state change.
 */
function notifyListeners(task: BackgroundTaskState): void {
    for (const listener of listeners) {
        try {
            listener(task);
        } catch (error) {
            logger(`backgroundTasks: Listener error: ${error}`, 1);
        }
    }
}

/**
 * Generate a unique task ID for an item operation.
 * @param type - Task type
 * @param libraryId - Library ID
 * @param itemKey - Item key
 * @returns Unique task ID
 */
export function generateTaskId(type: BackgroundTaskType, libraryId: number, itemKey: string): string {
    return `${type}-${libraryId}-${itemKey}-${Date.now()}`;
}

/**
 * Check if there's an active PDF fetch task for an item.
 * @param libraryId - Library ID
 * @param itemKey - Item key
 * @returns True if a PDF fetch is in progress
 */
export function isPdfFetchInProgress(libraryId: number, itemKey: string): boolean {
    for (const task of tasks.values()) {
        if (
            task.type === 'pdf_fetch' &&
            task.libraryId === libraryId &&
            task.itemKey === itemKey &&
            (task.status === 'pending' || task.status === 'running')
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Deduplicated sync for a specific item. If a sync is already in progress
 * for the same item, returns the existing promise instead of starting a new one.
 *
 * @param libraryId - Library ID
 * @param itemKey - Item key
 * @param syncFn - The actual sync function to call
 * @param options - Optional deduplication behavior
 * @returns Promise that resolves when sync completes
 */
export async function deduplicatedSync(
    libraryId: number,
    itemKey: string,
    syncFn: () => Promise<void>,
    options?: {
        /** If true, queue a follow-up sync after the in-flight sync finishes */
        queueIfInFlight?: boolean;
    }
): Promise<void> {
    const key = `${libraryId}-${itemKey}`;
    const existing = pendingSyncs.get(key);
    const queued = queuedSyncs.get(key);
    if (!existing && queued) {
        logger(`backgroundTasks: Follow-up sync already queued for ${key}`, 2);
        return queued;
    }
    if (existing) {
        if (!options?.queueIfInFlight) {
            logger(`backgroundTasks: Sync already in progress for ${key}, reusing promise`, 2);
            return existing;
        }

        if (queued) {
            logger(`backgroundTasks: Follow-up sync already queued for ${key}`, 2);
            return queued;
        }

        logger(`backgroundTasks: Queuing follow-up sync for ${key}`, 2);
        const followUp = existing
            .catch(() => {
                // Ignore in-flight sync errors; follow-up should still run.
            })
            .then(() => {
                const run = syncFn().finally(() => {
                    if (pendingSyncs.get(key) === run) {
                        pendingSyncs.delete(key);
                    }
                });
                pendingSyncs.set(key, run);
                return run;
            })
            .finally(() => {
                queuedSyncs.delete(key);
            });

        queuedSyncs.set(key, followUp);
        return followUp;
    }

    const promise = syncFn().finally(() => {
        if (pendingSyncs.get(key) === promise) {
            pendingSyncs.delete(key);
        }
    });

    pendingSyncs.set(key, promise);
    return promise;
}
