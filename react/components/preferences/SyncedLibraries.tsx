import React from 'react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { userAtom } from '../../atoms/auth';
import { profileWithPlanAtom, syncLibraryIdsAtom } from '../../atoms/profile';
import { Icon, LibraryIcon, SyncIcon, DeleteIcon, CSSIcon, Spinner } from '../icons/icons';
import { accountService } from '../../../src/services/accountService';
import { scheduleLibraryDeletion, syncZoteroDatabase } from '../../../src/utils/sync';
import { ZoteroLibrary } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';

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

    const [lastSynced, setLastSynced] = useState<LastSyncedMap>({});
    const [isSyncing, setIsSyncing] = useState<Record<number, boolean>>({});
    const [isDeleting, setIsDeleting] = useState<Record<number, boolean>>({});

    const libraries = useMemo(() => {
        return syncLibraryIds
            .map((id) => Zotero.Libraries.get(id))
            .filter((lib): lib is Zotero.Library => !!lib);
    }, [syncLibraryIds]);

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
        }
    }, [isSyncing, refreshOne]);

    const handleDeleteOne = useCallback(async (libraryID: number) => {
        if (isDeleting[libraryID]) return;
        const lib = Zotero.Libraries.get(libraryID);
        if (!lib) return;
        const confirmed = Zotero.getMainWindow().confirm(
            `Remove "${lib?.name || 'this library'}" from syncing?\n\nThis will delete all associated data from Beaver.`
        );
        if (!confirmed) return;

        setIsDeleting((s) => ({ ...s, [libraryID]: true }));
        try {
            logger(`SyncedLibraries: scheduling deletion for library ${libraryID}`);
            await scheduleLibraryDeletion([libraryID]);

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
    }, [profileWithPlan, setProfileWithPlan, syncLibraryIds, isDeleting]);

    return (
        <div className="display-flex flex-col gap-2">
            {/* Header */}
            <div className="display-flex flex-row items-center justify-between">
                <div className="display-flex flex-row items-center gap-2">
                    <Icon icon={LibraryIcon} className="font-color-secondary" />
                    <div className="font-color-secondary">Synced Libraries</div>
                </div>
                <button
                    type="button"
                    className="variant-outline"
                    onClick={() => console.log('+ Add Library')}
                    aria-label="Add Library"
                >
                    + Add Library
                </button>
            </div>

            {/* List */}
            <div className="display-flex flex-col rounded-md border-popup">
                {libraries.length === 0 ? (
                    <div className="p-2 text-sm font-color-tertiary">No libraries selected yet.</div>
                ) : (
                    libraries.map((lib) => {
                        const syncing = isSyncing[lib.libraryID];
                        const deleting = isDeleting[lib.libraryID];
                        return (
                            <div
                                key={lib.libraryID}
                                className="display-flex flex-row items-center justify-between p-2 border-top-quinary hover:bg-senary"
                            >
                                <div className="display-flex flex-row items-start gap-2 min-w-0">
                                    <span className="scale-90">
                                        <CSSIcon
                                            name={lib.isGroup ? 'library-group' : 'library'}
                                            className="icon-16 font-color-secondary"
                                        />
                                    </span>
                                    <div className="display-flex flex-col min-w-0">
                                        <div className="font-color-primary truncate">{lib.name}</div>
                                        <div className="text-xs font-color-tertiary">
                                            {lastSynced[lib.libraryID] ? `Indexed ${lastSynced[lib.libraryID]}` : 'Never'}
                                        </div>
                                    </div>
                                </div>
                                <div className="display-flex flex-row items-center gap-2">
                                    <button
                                        className="icon-button"
                                        onClick={() => handleSyncOne(lib.libraryID)}
                                        aria-label="Sync Library"
                                        disabled={!!syncing || !!deleting}
                                        title="Sync"
                                    >
                                        {syncing ? (
                                            <Icon icon={SyncIcon} className="animate-spin font-color-secondary" />
                                        ) : (
                                            <Icon icon={SyncIcon} className="font-color-secondary" />
                                        )}
                                    </button>
                                    <button
                                        className="icon-button"
                                        onClick={() => handleDeleteOne(lib.libraryID)}
                                        aria-label="Remove Library"
                                        disabled={!!deleting || !!syncing}
                                        title="Delete"
                                    >
                                        {deleting ? (
                                            <Icon icon={Spinner} className="animate-spin font-color-secondary" />
                                        ) : (
                                            <Icon icon={DeleteIcon} className="font-color-secondary" />
                                        )}
                                    </button>
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