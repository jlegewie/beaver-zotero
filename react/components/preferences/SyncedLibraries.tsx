import React from 'react';
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { userAtom } from '../../atoms/auth';
import { profileWithPlanAtom, syncLibraryIdsAtom } from '../../atoms/profile';
import { Icon, LibraryIcon, SyncIcon, DeleteIcon, CSSIcon, TickIcon, DatabaseIcon } from '../icons/icons';
import { accountService } from '../../../src/services/accountService';
import { syncZoteroDatabase } from '../../../src/utils/sync';
import { ZoteroLibrary } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';
import IconButton from '../ui/IconButton';
import { useLibraryDeletions } from '../../hooks/useLibraryDeletions';
import AddLibraryButton from '../ui/buttons/AddLibraryButton';
import { syncStatusAtom } from '../../atoms/sync';
import { CancelIcon } from '../status/icons';

type LastSyncedMap = Record<number, string>;

function formatSyncTimestamp(ts?: string): string {
    if (!ts) return 'Never';
    const stamp = ts.endsWith('Z') ? ts : `${ts}Z`;
    const d = new Date(stamp);
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(d);
}

const SyncedLibraries: React.FC = () => {
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    const syncStatusMap = useAtomValue(syncStatusAtom);

    const [lastSynced, setLastSynced] = useState<LastSyncedMap>({});
    const [isSyncing, setIsSyncing] = useState<Record<number, boolean>>({});
    const [isSyncingComplete, setIsSyncingComplete] = useState<Record<number, boolean>>({});
    const [isDeleting, setIsDeleting] = useState<Record<number, boolean>>({});

    // Track libraries for which we've already refreshed after initial sync completes
    const initialSyncRefreshed = useRef<Set<number>>(new Set());

    // Hydrate/poll deletion jobs
    const { jobs, startDeletion } = useLibraryDeletions();

    const libraries = useMemo(() => {
        // Get synced libraries
        const synced = syncLibraryIds
            .map((id) => Zotero.Libraries.get(id))
            .filter((lib): lib is Zotero.Library => !!lib);
        
        // Get deleting libraries
        const deletingExtras = Object.values(jobs)
            .filter(j => j.status !== 'completed' && j.status !== 'failed')
            .map(j => Zotero.Libraries.get(j.libraryID) ?? ({ libraryID: j.libraryID, name: j.name, isGroup: j.isGroup } as any))
            .filter((lib): lib is Zotero.Library => !!lib);
        
        // Combine and deduplicate
        const map = new Map<number, Zotero.Library>();
        for (const l of [...synced, ...deletingExtras]) map.set(l.libraryID, l as Zotero.Library);
        
        // Return sorted by libraryID
        return Array.from(map.values()).sort((a, b) => a.libraryID - b.libraryID);
    }, [syncLibraryIds, jobs]);

    // Load last-synced timestamps for each library
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            if (!user?.id) {
                setLastSynced({});
                return;
            }
            try {
                const entries = await Promise.all(
                    libraries.map(async (lib) => {
                        try {
                            // Order by timestamp and take the latest row
                            const rows = await Zotero.Beaver.db.getAllSyncLogsForLibrary(
                                user.id,
                                lib.libraryID,
                                'timestamp',
                                'DESC'
                            );
                            const ts = rows && rows.length > 0 ? rows[0].timestamp : undefined;
                            return [lib.libraryID, formatSyncTimestamp(ts)] as const;
                        } catch {
                            return [lib.libraryID, '—'] as const;
                        }
                    })
                );
                if (!cancelled) {
                    const map: LastSyncedMap = {};
                    for (const [id, text] of entries) map[id] = text;
                    setLastSynced(map);
                }
            } catch (e) {
                logger(`SyncedLibraries: failed to load last-synced: ${String(e)}`, 1);
            }
        };
        load();
        return () => {
            cancelled = true;
        };
    }, [libraries, user?.id]);

    const refreshOne = useCallback(async (libraryID: number) => {
        try {
            if (!user?.id) return;
            const rows = await Zotero.Beaver.db.getAllSyncLogsForLibrary(user.id, libraryID, 'timestamp', 'DESC');
            const ts = rows && rows.length > 0 ? rows[0].timestamp : undefined;
            setLastSynced((prev) => ({ ...prev, [libraryID]: formatSyncTimestamp(ts) }));
        } catch {
            // no-op
        }
    }, [user?.id]);

    const handleSyncOne = useCallback(async (libraryID: number) => {
        if (isSyncing[libraryID]) return;
        setIsSyncing((s) => ({ ...s, [libraryID]: true }));
        try {
            logger(`SyncedLibraries: syncing library ${libraryID}`);
            await syncZoteroDatabase([libraryID]);
            await refreshOne(libraryID);
        } catch (e) {
            logger(`SyncedLibraries: sync failed for ${libraryID}: ${String(e)}`, 1);
            Zotero.logError(e as Error);
        } finally {
            setIsSyncing((s) => ({ ...s, [libraryID]: false }));
            setIsSyncingComplete((s) => ({ ...s, [libraryID]: true }));
            setTimeout(() => {
                setIsSyncingComplete((s) => ({ ...s, [libraryID]: false }));
            }, 2000);
        }
    }, [isSyncing, refreshOne]);

    // When an initial sync completes, refresh "Last synced" for that library
    useEffect(() => {
        for (const [idStr, s] of Object.entries(syncStatusMap)) {
            const id = Number(idStr);
            if (s?.status === 'completed' && s.syncType === 'initial' && !initialSyncRefreshed.current.has(id)) {
                initialSyncRefreshed.current.add(id);
                refreshOne(id);
            }
        }
    }, [syncStatusMap, refreshOne]);

    const handleDeleteOne = useCallback(async (libraryID: number) => {
        if (isDeleting[libraryID]) return;
        const lib = Zotero.Libraries.get(libraryID);
        if (!lib) return;

        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: 'Remove Library from Syncing?',
            text: `Do you want to remove "${lib.name || 'this library'}" from syncing? This will delete all associated data from Beaver.\n\nRemoving a library will NOT free up pages for full-document search.`,
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        setIsDeleting((s) => ({ ...s, [libraryID]: true }));
        try {
            logger(`SyncedLibraries: Starting deletion for library ${libraryID}`);
            await startDeletion({ libraryID, name: lib.name, isGroup: lib.isGroup });

            // Update list of libraries in backend/profile
            if (profileWithPlan) {
                const remainingIds = syncLibraryIds.filter((id) => id !== libraryID);
                const updated = remainingIds
                    .map((id) => Zotero.Libraries.get(id))
                    .filter((l): l is Zotero.Library => !!l)
                    .map((l) => ({
                        library_id: l.libraryID,
                        group_id: l.isGroup ? l.id : null,
                        name: l.name,
                        is_group: l.isGroup,
                        type: l.libraryType,
                        type_id: l.libraryTypeID,
                    } as ZoteroLibrary));

                await accountService.updateSyncLibraries(updated);
                setProfileWithPlan({ ...profileWithPlan, libraries: updated });
            }
        } catch (e) {
            logger(`SyncedLibraries: delete failed for ${libraryID}: ${String(e)}`, 1);
            Zotero.logError(e as Error);
        } finally {
            setIsDeleting((s) => ({ ...s, [libraryID]: false }));
        }
    }, [profileWithPlan, setProfileWithPlan, syncLibraryIds, isDeleting, startDeletion]);

    return (
        <div className="display-flex flex-col gap-3">
            {/* Header */}
            <div className="display-flex flex-row items-center justify-between">
                <div className="display-flex flex-row items-center gap-2">
                    <Icon icon={LibraryIcon} className="font-color-secondary scale-11" />
                    <div className="font-color-secondary">Synced Libraries</div>
                </div>
                <div className="display-flex flex-row items-center gap-3">
                    {/* <Button
                        variant="outline" 
                        icon={DatabaseIcon}
                        // iconClassName={verifyButtonProps.iconClassName}
                        // onClick={handleVerifySync}
                        // disabled={verifyButtonProps.disabled}
                    >
                        Verify Data
                    </Button> */}
                    <AddLibraryButton disabled={libraries.length === Zotero.Libraries.getAll().length} />
                </div>
            </div>

            {/* List */}
            <div className="display-flex flex-col rounded-md border-popup">
                {libraries.length === 0 ? (
                    <div className="p-2 text-sm font-color-tertiary">No libraries selected yet.</div>
                ) : (
                    libraries.map((lib, index) => {
                        const syncing = isSyncing[lib.libraryID];
                        const deleting = isDeleting[lib.libraryID];
                        const syncingComplete = !!isSyncingComplete[lib.libraryID];
                        const isDeletingNow = jobs[lib.libraryID] && (jobs[lib.libraryID].status === 'queued' || jobs[lib.libraryID].status === 'processing');

                        const s = syncStatusMap[lib.libraryID];
                        const inProgressInitial = !!s && s.status === 'in_progress' && s.syncType === 'initial';
                        const failedInitial = !!s && s.status === 'failed' && s.syncType === 'initial';
                        const percent = s && s.itemCount && s.itemCount > 0
                            ? Math.min(100, Math.round(((s.syncedCount || 0) / s.itemCount) * 100))
                            : undefined;

                        return (
                            <div
                                key={lib.libraryID}
                                className={`display-flex flex-row items-center justify-between p-3 ${index > 0 ? 'border-top-quinary' : ''}`}
                            >
                                <div className="display-flex flex-row items-start gap-2 min-w-0">
                                    <span className="scale-90 -mt-010">
                                        <CSSIcon
                                            name={lib.isGroup ? 'library-group' : 'library'}
                                            className="icon-16 font-color-secondary"
                                        />
                                    </span>
                                    <div className="display-flex flex-col min-w-0 gap-1">
                                        <div className="font-color-primary truncate">{lib.name}</div>

                                        {!isDeletingNow && (
                                            inProgressInitial ? (
                                                <div className="text-sm font-color-tertiary">
                                                    {`Syncing${percent !== undefined ? ` • ${percent}%` : ''}`}
                                                </div>
                                            ) : failedInitial ? (
                                                <div className="display-flex flex-row items-center gap-2 text-sm font-color-red">
                                                    {CancelIcon}
                                                    <span>Sync failed</span>
                                                </div>
                                            ) : (
                                                <div className="text-sm font-color-tertiary">
                                                    {lastSynced[lib.libraryID] ? `Last synced ${lastSynced[lib.libraryID]}` : ''}
                                                </div>
                                            )
                                        )}
                                    </div>
                                    
                                </div>
                                <div className="display-flex flex-row items-center gap-4 mr-1">
                                    {isDeletingNow ? (
                                        <div className="display-flex flex-row items-center gap-3">
                                            <span className="font-color-tertiary">
                                                {jobs[lib.libraryID].status === 'queued' ? 'Queued…' : 'Deleting…'}
                                            </span>
                                            <Icon icon={SyncIcon} className="animate-spin font-color-tertiary" />
                                        </div>
                                    ) : inProgressInitial ? (
                                        <div className="display-flex flex-row items-center gap-3">
                                            <Icon icon={SyncIcon} className="animate-spin font-color-tertiary" />
                                        </div>
                                    ) : (
                                        <>
                                            <IconButton
                                                onClick={() => handleSyncOne(lib.libraryID)}
                                                variant="ghost-secondary"
                                                ariaLabel="Sync Library"
                                                disabled={!!syncing || !!deleting}
                                                title="Sync Library with Beaver"
                                                icon={!syncingComplete ? SyncIcon : TickIcon}
                                                iconClassName={syncing && !syncingComplete ? 'animate-spin' : ''}
                                                className="scale-11"
                                            />
                                            <IconButton
                                                onClick={() => handleDeleteOne(lib.libraryID)}
                                                variant="ghost-secondary"
                                                ariaLabel="Remove Library from Beaver"
                                                disabled={!!deleting || !!syncing || syncLibraryIds.length <= 1}
                                                title="Delete Library from Beaver"
                                                icon={DeleteIcon}
                                                className="scale-11"
                                            />
                                        </>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

export default SyncedLibraries;