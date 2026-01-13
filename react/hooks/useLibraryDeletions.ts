import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { deletionJobsAtom, DeletionJob, DeletionStatus } from '../atoms/sync';
import { getPref, setPref } from '../../src/utils/prefs';
import { scheduleLibraryDeletion } from '../../src/utils/sync';
import { syncService, DeletionStatusRequestItem, DeletionStatusResponse, DeleteLibraryTask } from '../../src/services/syncService';
import { logger } from '../../src/utils/logger';
import { hasAuthorizedProAccessAtom, isDeviceAuthorizedAtom } from '../atoms/profile';
import { isAuthenticatedAtom } from '../atoms/auth';

const PREF_KEY = 'deletionJobs';

function readJobsPref(): Record<number, DeletionJob> {
    try {
        const raw = getPref(PREF_KEY) as unknown as string;
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function writeJobsPref(jobs: Record<number, DeletionJob>) {
    try {
        setPref(PREF_KEY, JSON.stringify(jobs) as any);
    } catch {
        // ignore
    }
}

/**
 * Schedules a library deletion and manages the deletion job state
 * This is a shared utility used by both the hook and components
 * @param lib Library metadata
 * @param setJobs Setter function for deletionJobsAtom
 * @returns Promise resolving to the deletion tasks
 */
export async function scheduleSingleLibraryDeletion(
    lib: { libraryID: number; name: string; isGroup: boolean },
    setJobs: (update: (prev: Record<number, DeletionJob>) => Record<number, DeletionJob>) => void
): Promise<DeleteLibraryTask[]> {
    // Optimistically update deletion jobs atom
    setJobs((prev) => ({
        ...prev,
        [lib.libraryID]: {
            libraryID: lib.libraryID,
            name: lib.name,
            isGroup: lib.isGroup,
            startedAt: new Date().toISOString(),
            status: 'queued'
        }
    }));

    try {
        // Schedule backend deletion
        const tasks = await scheduleLibraryDeletion([lib.libraryID]);
        const task = tasks.find((t) => t.library_id === lib.libraryID);

        // Update with task details
        setJobs((prev) => {
            const next = { ...prev };
            const j = next[lib.libraryID];
            if (!j) return next;
            return {
                ...next,
                [lib.libraryID]: {
                    ...j,
                    status: 'processing',
                    msgId: task?.msg_id,
                    sessionId: task?.session_id,
                }
            };
        });

        return tasks;
    } catch (error) {
        // Rollback optimistic update on failure
        setJobs((prev) => {
            const next = { ...prev };
            const j = next[lib.libraryID];
            if (!j) return next;
            return {
                ...next,
                [lib.libraryID]: {
                    ...j,
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error)
                }
            };
        });
        throw error;
    }
}

export function useLibraryDeletions() {
    const [jobs, setJobs] = useAtom(deletionJobsAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isProAuthorized = useAtomValue(hasAuthorizedProAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const timerRef = useRef<number | null>(null);
    const jobsRef = useRef(jobs);
    const pollIntervalRef = useRef(5000); // Start at 5 seconds

    useEffect(() => {
        jobsRef.current = jobs;
    }, [jobs]);

    // Hydrate once
    useEffect(() => {
        const initial = readJobsPref();
        if (Object.keys(initial).length) setJobs(initial);
    }, []);

    // Persist on change
    useEffect(() => {
        writeJobsPref(jobs);
    }, [jobs]);

    const activeJobs = useMemo(
        () => Object.values(jobs).filter(j => j.status !== 'completed' && j.status !== 'failed'),
        [jobs]
    );

    // Start deletion for a single library (uses shared utility)
    const startDeletion = useCallback(async (lib: { libraryID: number; name: string; isGroup: boolean }) => {
        await scheduleSingleLibraryDeletion(lib, setJobs);
    }, [setJobs]);

    // Start deletion for multiple libraries
    const startDeletions = useCallback(async (libs: { libraryID: number; name: string; isGroup: boolean }[]) => {
        // Optimistic UI
        setJobs(prev => {
            const next = { ...prev };
            const now = new Date().toISOString();
            for (const lib of libs) {
                next[lib.libraryID] = {
                    libraryID: lib.libraryID,
                    name: lib.name,
                    isGroup: lib.isGroup,
                    startedAt: now,
                    status: 'queued'
                };
            }
            return next;
        });
        // Schedule backend
        const ids = libs.map(l => l.libraryID);
        const tasks = await scheduleLibraryDeletion(ids) as any;
        const byLib = new Map<number, any>();
        if (Array.isArray(tasks)) {
            for (const t of tasks) byLib.set(t.library_id, t);
        }
        setJobs(prev => {
            const next = { ...prev };
            for (const lib of libs) {
                const t = byLib.get(lib.libraryID);
                const j = next[lib.libraryID];
                if (!j) continue;
                next[lib.libraryID] = {
                    ...j,
                    status: 'processing',
                    msgId: t?.msg_id,
                    sessionId: t?.session_id,
                };
            }
            return next;
        });
    }, [setJobs]);

    // Poller - use useRef to avoid recreating the callback
    const pollOnceRef = useRef<() => Promise<void>>();
    pollOnceRef.current = async () => {
        const currentJobs = Object.values(jobsRef.current)
            .filter(j => j.status !== 'completed' && j.status !== 'failed');

        const requests: DeletionStatusRequestItem[] = currentJobs
            .filter(j => !!j.sessionId)
            .map(j => ({ library_id: j.libraryID, session_id: j.sessionId! }));

        if (requests.length === 0) return;

        let results: DeletionStatusResponse[] = [];
        try {
            results = await syncService.getLibraryDeletionStatus(requests);
        } catch (error) {
            logger(`useLibraryDeletions: Failed to fetch deletion status: ${error}`, 1);
            return;
        }

        setJobs(prev => {
            const next = { ...prev };
            const now = new Date().toISOString();
            for (const res of results) {
                const j = next[res.library_id];
                if (!j) continue;
                const status: DeletionStatus = res.status === 'completed' ? 'completed' : 'processing';
                if (status === 'completed') {
                    delete next[res.library_id];
                } else {
                    next[res.library_id] = { ...j, status, lastCheckedAt: now };
                }
            }
            return next;
        });
    };

    const scheduleNextPoll = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        
        const currentJobs = Object.values(jobsRef.current)
            .filter(j => j.status !== 'completed' && j.status !== 'failed');
        
        if (currentJobs.length === 0) {
            pollIntervalRef.current = 5000; // Reset for next time
            return;
        }

        timerRef.current = setTimeout(async () => {
            await pollOnceRef.current?.();
            // Exponential backoff: 5s -> 10s -> 20s -> 40s -> 60s (capped)
            pollIntervalRef.current = Math.min(pollIntervalRef.current * 2, 60000);
            scheduleNextPoll();
        }, pollIntervalRef.current) as unknown as number;
    }, []); // ← No dependencies! Uses refs instead

    // Only start polling when active jobs count changes AND user is authenticated
    useEffect(() => {
        // Guard: only poll if authenticated
        if (!isAuthenticated) return;
        if (!isProAuthorized) return;
        if (!isDeviceAuthorized) return;
        
        const hasActiveJobs = activeJobs.length > 0;
        
        if (hasActiveJobs) {
            // Run immediately on first poll or when new jobs are added
            void pollOnceRef.current?.();
            // Reset interval for new jobs
            pollIntervalRef.current = 5000;
            scheduleNextPoll();
        } else {
            // Stop polling when no active jobs
            if (timerRef.current) clearTimeout(timerRef.current);
        }
        
        return () => { 
            if (timerRef.current) clearTimeout(timerRef.current); 
        };
    }, [activeJobs.length, scheduleNextPoll, isAuthenticated, isProAuthorized, isDeviceAuthorized]);

    const activeDeletionIds = useMemo(
        () => new Set(activeJobs.map(j => j.libraryID)),
        [activeJobs]
    );

    return {
        jobs,
        activeDeletionIds,
        startDeletion,
        startDeletions,
    };
}