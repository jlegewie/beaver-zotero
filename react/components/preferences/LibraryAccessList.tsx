import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getLibraryItemCounts, LibraryStatistics } from '../../../src/utils/libraries';
import { logger } from '@beaver/agent-core/platform/logger';
import { ExcludedLibrary } from '@beaver/agent-core/types/profile';
import { ZoteroLibrary } from '@beaver/agent-core/types/zotero';
import {
    allLibrariesExcludedAtom,
    excludedEntryKey,
    excludedLibrariesAtom,
    isProfileLoadedAtom,
    libraryExclusionKey,
    profileWithPlanAtom,
} from '../../atoms/profile';
import {
    isUpdatingExcludedLibrariesAtom,
    toggleExcludedLibraryAtom,
} from '../../atoms/excludedLibraries';
import { AlertIcon, CSSIcon, Icon } from '../icons/icons';
import { SettingsGroup } from './components/SettingsElements';

/** Libraries shown before the list collapses behind "Show all". */
const COLLAPSED_LIBRARY_COUNT = 3;

type LocalZoteroLibraryLike = {
    libraryID: number;
    id: number;
    name: string;
    isGroup: boolean;
    libraryType: string;
};

function zoteroLibraryToProfileLibrary(library: LocalZoteroLibraryLike): ZoteroLibrary {
    return {
        library_id: library.libraryID,
        group_id: library.isGroup ? library.id : null,
        name: library.name,
        is_group: library.isGroup,
        type: library.libraryType,
        type_id: 0,
        read_only: false,
    };
}

function isPersonalLibraryExcluded(excluded: ExcludedLibrary[]): boolean {
    return excluded.some(entry => excludedEntryKey(entry) === 'user');
}

/** Personal library first, then groups by name. */
function compareLibraries(a: ZoteroLibrary, b: ZoteroLibrary): number {
    if (a.is_group !== b.is_group) return a.is_group ? 1 : -1;
    return a.name.localeCompare(b.name);
}

/**
 * One checkbox per Zotero library. A checked library is one Beaver may
 * search, read, and edit; unchecking it adds the library to the account's
 * excluded list, which applies on every device signed in to the account.
 *
 * Local enumeration and item counts are allowed here: this is the UI that
 * implements the exclusion boundary, not a path that sends data anywhere.
 */
const LibraryAccessList: React.FC = () => {
    const excludedLibraries = useAtomValue(excludedLibrariesAtom);
    // The exclusion list lives on the profile; until it has loaded, an empty
    // list means "unknown", not "everything allowed", so no box is drawn.
    const profileLoaded = useAtomValue(isProfileLoadedAtom);
    const profile = useAtomValue(profileWithPlanAtom);
    const profileReady = profileLoaded && profile !== null;
    const allLibrariesExcluded = useAtomValue(allLibrariesExcludedAtom);
    const isUpdating = useAtomValue(isUpdatingExcludedLibrariesAtom);
    const toggleExcludedLibrary = useSetAtom(toggleExcludedLibraryAtom);

    const [allLibraries, setAllLibraries] = useState<ZoteroLibrary[] | null>(null);
    const [statsById, setStatsById] = useState<Record<number, LibraryStatistics>>({});
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        let isCancelled = false;
        const load = async () => {
            const libs = await Zotero.Libraries.getAll();
            if (isCancelled) return;
            const libraries = libs
                .filter(library => library.libraryType === 'user' || library.libraryType === 'group')
                .map(zoteroLibraryToProfileLibrary)
                .sort(compareLibraries);
            setAllLibraries(libraries);
            const stats = await Promise.all(libraries.map(async (library) => {
                try {
                    return await getLibraryItemCounts(library.library_id);
                } catch (error) {
                    logger(`LibraryAccessList: failed to count items in library ${library.library_id}: ${error}`, 1);
                    return null;
                }
            }));
            if (isCancelled) return;
            const byId: Record<number, LibraryStatistics> = {};
            for (const stat of stats) {
                if (stat) byId[stat.libraryID] = stat;
            }
            setStatsById(byId);
        };
        void load().catch((error) => {
            logger(`LibraryAccessList: failed to load libraries: ${error}`, 1);
            if (!isCancelled) setAllLibraries([]);
        });
        return () => {
            isCancelled = true;
        };
    }, []);

    const excludedKeys = useMemo(
        () => new Set(excludedLibraries.map(excludedEntryKey)),
        [excludedLibraries],
    );
    const personalExcluded = isPersonalLibraryExcluded(excludedLibraries);
    const collapsible = (allLibraries?.length ?? 0) > COLLAPSED_LIBRARY_COUNT;
    const visibleLibraries = allLibraries && collapsible && !expanded
        ? allLibraries.slice(0, COLLAPSED_LIBRARY_COUNT)
        : allLibraries ?? [];
    // Exclusions are the point of the list, so a collapsed view says how many
    // of the hidden libraries are unchecked rather than hiding that silently.
    const hiddenExcluded = allLibraries && collapsible && !expanded
        ? allLibraries.slice(COLLAPSED_LIBRARY_COUNT).filter((library) => excludedKeys.has(libraryExclusionKey(library))).length
        : 0;

    return (
        <div className="display-flex flex-col gap-2">
            <div className="text-base font-color-secondary" style={{ paddingLeft: '2px' }}>
                Beaver only searches, reads, and edits the libraries checked here.
                This applies on every device signed in to your account.
            </div>

            {(personalExcluded || allLibrariesExcluded) && (
                <div
                    role="alert"
                    className="display-flex flex-row items-start gap-2 text-sm p-2 rounded-md"
                    style={{ color: 'var(--tag-red-secondary)', border: '1px solid var(--tag-red-tertiary)', background: 'var(--tag-red-quinary)' }}
                >
                    <Icon icon={AlertIcon} className="scale-11 mt-015 flex-none" />
                    <span>
                        {allLibrariesExcluded
                            ? "All libraries are unchecked. Beaver can't access any libraries."
                            : 'Your personal library is unchecked, so Beaver cannot use it on any of your devices.'}
                    </span>
                </div>
            )}

            <SettingsGroup>
                {allLibraries === null || !profileReady ? (
                    <div className="p-2 text-base font-color-secondary">
                        {allLibraries === null ? 'Loading libraries…' : 'Waiting for your Beaver account to load…'}
                    </div>
                ) : allLibraries.length === 0 ? (
                    <div className="p-2 text-base font-color-secondary">No libraries found.</div>
                ) : visibleLibraries.map((library, index) => {
                    const stats = statsById[library.library_id];
                    const checked = !excludedKeys.has(libraryExclusionKey(library));
                    const toggle = () => { if (!isUpdating) void toggleExcludedLibrary(library); };
                    return (
                        <div
                            key={library.library_id}
                            className={`display-flex flex-row items-center justify-between gap-4 ${index > 0 ? 'border-top-quinary' : ''} ${isUpdating ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                            style={{ padding: '8px 12px', minHeight: '38px' }}
                            onClick={toggle}
                        >
                            <div className="display-flex flex-row items-center gap-2 min-w-0">
                                <span className="scale-90 flex-none">
                                    <CSSIcon
                                        name={library.is_group ? 'library-group' : 'library'}
                                        className="icon-16 font-color-secondary"
                                    />
                                </span>
                                <div className="display-flex flex-col min-w-0 gap-05">
                                    <div className="font-color-primary text-base font-medium truncate">{library.name}</div>
                                    <div className="text-sm font-color-tertiary">
                                        {stats
                                            ? `${stats.itemCount.toLocaleString()} items, ${stats.attachmentCount.toLocaleString()} attachments`
                                            : '…'}
                                    </div>
                                </div>
                            </div>
                            <input
                                type="checkbox"
                                aria-label={`Allow Beaver to use ${library.name}`}
                                checked={checked}
                                disabled={isUpdating}
                                onChange={toggle}
                                onClick={(event) => event.stopPropagation()}
                                style={{ cursor: isUpdating ? 'not-allowed' : 'pointer', margin: 0 }}
                            />
                        </div>
                    );
                })}
                {allLibraries !== null && profileReady && collapsible && (
                    <button
                        type="button"
                        className="display-flex flex-row items-center border-top-quinary text-base text-link-muted"
                        style={{ padding: '8px 12px', background: 'none', border: 'none', borderTop: '1px solid var(--fill-quinary)', cursor: 'pointer', width: '100%' }}
                        aria-expanded={expanded}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded
                            ? 'Show fewer'
                            : `Show all ${allLibraries.length.toLocaleString()} libraries`
                                + (hiddenExcluded > 0 ? ` · ${hiddenExcluded.toLocaleString()} unchecked` : '')}
                    </button>
                )}
            </SettingsGroup>
        </div>
    );
};

export default LibraryAccessList;
