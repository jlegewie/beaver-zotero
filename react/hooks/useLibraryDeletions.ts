import { useAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { deletionJobsAtom, DeletionJob, DeletionStatus } from '../atoms/sync';
import { getPref, setPref } from '../../src/utils/prefs';
import { scheduleLibraryDeletion } from '../../src/utils/sync';
import { syncService, DeletionStatusRequestItem, DeletionStatusResponse } from '../../src/services/syncService';

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

export function useLibraryDeletions() {
    const [jobs, setJobs] = useAtom(deletionJobsAtom);
    const timerRef = useRef<number | null>(null);

    // Hydrate once
    useEffect(() => {
        const initial = readJobsPref();
        if (Object.keys(initial).length) setJobs(initial);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Persist on change
    useEffect(() => {
        writeJobsPref(jobs);
    }, [jobs]);

    const activeJobs = useMemo(
        () => Object.values(jobs).filter(j => j.status !== 'completed' && j.status !== 'failed'),
        [jobs]
    );

    // Start deletion for a single library (schedules backend + tracks session)
    const startDeletion = useCallback(async (lib: { libraryID: number; name: string; isGroup: boolean }) => {
        // Optimistic enqueue in UI
        setJobs(prev => ({
            ...prev,
            [lib.libraryID]: {
                libraryID: lib.libraryID,
                name: lib.name,
                isGroup: lib.isGroup,
                startedAt: new Date().toISOString(),
                status: 'queued'
            }
        }));

        // Schedule backend deletion and capture session/msg id
        const tasks = await scheduleLibraryDeletion([lib.libraryID]) as any;
        const task = Array.isArray(tasks) ? tasks.find((t: any) => t.library_id === lib.libraryID) : undefined;

        setJobs(prev => {
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

    // Poller
    const pollOnce = useCallback(async () => {
        const requests: DeletionStatusRequestItem[] = activeJobs
            .filter(j => !!j.sessionId)
            .map(j => ({ library_id: j.libraryID, session_id: j.sessionId! }));
        if (requests.length === 0) return;
        let results: DeletionStatusResponse[] = [];
        try {
            results = await syncService.getLibraryDeletionStatus(requests);
        } catch {
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
    }, [activeJobs, setJobs]);

    useEffect(() => {
        void pollOnce();
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(pollOnce, 20000) as unknown as number; // 20s
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [pollOnce]);

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