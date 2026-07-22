import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getLibraryItemCounts, LibraryStatistics } from '../../../src/utils/libraries';
import { logger } from '../../../src/utils/logger';
import { ExcludedLibrary } from '../../types/profile';
import { ZoteroLibrary } from '../../types/zotero';
import {
    allLibrariesExcludedAtom,
    excludedEntryKey,
    excludedLibrariesAtom,
    libraryExclusionKey,
} from '../../atoms/profile';
import {
    isUpdatingExcludedLibrariesAtom,
    toggleExcludedLibraryAtom,
} from '../../atoms/excludedLibraries';
import { AlertIcon, CSSIcon, Icon, PlusSignIcon, UndoIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import SearchMenu, { MenuPosition, SearchMenuItem } from '../ui/menus/SearchMenu';

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

const ExcludedLibrariesList: React.FC = () => {
    const excludedLibraries = useAtomValue(excludedLibrariesAtom);
    const allLibrariesExcluded = useAtomValue(allLibrariesExcludedAtom);
    const isUpdating = useAtomValue(isUpdatingExcludedLibrariesAtom);
    const toggleExcludedLibrary = useSetAtom(toggleExcludedLibraryAtom);

    const [allLibraries, setAllLibraries] = useState<ZoteroLibrary[]>([]);
    const [libraryStatistics, setLibraryStatistics] = useState<LibraryStatistics[]>([]);
    const [isLoadingStats, setIsLoadingStats] = useState(true);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [searchQuery, setSearchQuery] = useState('');
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        let isCancelled = false;

        const loadLibraries = async () => {
            const libs = await Zotero.Libraries.getAll();
            if (isCancelled) {
                return;
            }

            setAllLibraries(
                libs
                    .filter(library => library.libraryType === 'user' || library.libraryType === 'group')
                    .map(zoteroLibraryToProfileLibrary),
            );
        };

        void loadLibraries();

        return () => {
            isCancelled = true;
        };
    }, []);

    const libraryStatsById = useMemo(() => {
        const map: Record<number, LibraryStatistics> = {};
        for (const stat of libraryStatistics) {
            map[stat.libraryID] = stat;
        }
        return map;
    }, [libraryStatistics]);

    useEffect(() => {
        if (allLibraries.length === 0) {
            setIsLoadingStats(false);
            return;
        }

        let isCancelled = false;

        const fetchLibraryStatistics = async () => {
            const missingLibraryIds = allLibraries
                .map(library => library.library_id)
                .filter(libraryID => !libraryStatsById[libraryID]);

            if (missingLibraryIds.length === 0) {
                setIsLoadingStats(false);
                return;
            }

            try {
                setIsLoadingStats(true);
                const fetchedStats = await Promise.all(missingLibraryIds.map(id => getLibraryItemCounts(id)));
                if (isCancelled) {
                    return;
                }

                const mergedStatsById: Record<number, LibraryStatistics> = { ...libraryStatsById };
                for (const stat of fetchedStats) {
                    if (stat) {
                        mergedStatsById[stat.libraryID] = stat;
                    }
                }

                setLibraryStatistics(Object.values(mergedStatsById));
            } catch (error) {
                if (!isCancelled) {
                    logger(`Error fetching library statistics: ${error}`, 1);
                }
            } finally {
                if (!isCancelled) {
                    setIsLoadingStats(false);
                }
            }
        };

        void fetchLibraryStatistics();

        return () => {
            isCancelled = true;
        };
    }, [allLibraries, libraryStatsById]);

    const excludedKeys = useMemo(
        () => new Set(excludedLibraries.map(excludedEntryKey)),
        [excludedLibraries],
    );

    const excludedRows = useMemo(() => {
        return allLibraries
            .filter(library => excludedKeys.has(libraryExclusionKey(library)))
            .sort((a, b) => a.library_id - b.library_id);
    }, [allLibraries, excludedKeys]);

    const unexcludedLibraries = useMemo(() => {
        return allLibraries.filter(library => !excludedKeys.has(libraryExclusionKey(library)));
    }, [allLibraries, excludedKeys]);

    const availableLibraries = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) {
            return unexcludedLibraries;
        }
        return unexcludedLibraries.filter(library => library.name.toLowerCase().includes(query));
    }, [searchQuery, unexcludedLibraries]);

    const handleToggleLibrary = useCallback((library: ZoteroLibrary) => {
        void toggleExcludedLibrary(library);
        setIsMenuOpen(false);
    }, [toggleExcludedLibrary]);

    const addLibraryMenuItems = useMemo((): SearchMenuItem[] => {
        return availableLibraries.map(library => {
            const stats = libraryStatsById[library.library_id];
            return {
                label: library.name,
                onClick: () => handleToggleLibrary(library),
                disabled: isUpdating,
                customContent: (
                    <div className="display-flex flex-row gap-2 items-center min-w-0 w-full">
                        <span className="scale-90">
                            <CSSIcon name={library.is_group ? 'library-group' : 'library'} className="icon-16 font-color-secondary" />
                        </span>
                        <div className="display-flex flex-col min-w-0 flex-1">
                            <span className="truncate font-color-primary">{library.name}</span>
                            {stats && (
                                <span className="text-sm font-color-tertiary">
                                    {stats.itemCount.toLocaleString()} items, {stats.attachmentCount.toLocaleString()} attachments
                                </span>
                            )}
                        </div>
                    </div>
                ),
            };
        });
    }, [availableLibraries, handleToggleLibrary, isUpdating, libraryStatsById]);

    const handleButtonClick = () => {
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setSearchQuery('');
            setMenuPosition({ x: rect.right, y: rect.top });
            setIsMenuOpen(true);
        }
    };

    const personalExcluded = isPersonalLibraryExcluded(excludedLibraries);
    const accessibleLibraryNames = unexcludedLibraries.map(library => library.name).join(', ');

    return (
        <div className="display-flex flex-col gap-3">
            {allLibraries.length > 0 && (
                <div className="text-base font-color-secondary" style={{ paddingLeft: '2px' }}>
                    {unexcludedLibraries.length === 0
                        ? "Beaver can't access any libraries."
                        : excludedKeys.size === 0
                            ? `Beaver can access all your libraries: ${accessibleLibraryNames}`
                            : `Beaver can access the following libraries: ${accessibleLibraryNames}`
                    }
                </div>
            )}

            <div className="display-flex flex-col gap-2">
                <div className="display-flex flex-row items-center justify-between gap-3">
                    <div
                        role="heading"
                        aria-level={3}
                        className="text-base font-color-primary font-medium"
                        style={{ paddingLeft: '2px', fontSize: '1.05rem' }}
                    >
                        Excluded Libraries
                    </div>
                    <button
                        ref={buttonRef}
                        type="button"
                        className="variant-outline"
                        style={{ marginRight: '1px', padding: '4px 6px' }}
                        onClick={handleButtonClick}
                        disabled={unexcludedLibraries.length === 0 || isUpdating}
                        aria-label="Exclude a library"
                    >
                        <Icon icon={PlusSignIcon} className="scale-11" />
                        <span>Exclude a library...</span>
                    </button>
                </div>

                {(personalExcluded || allLibrariesExcluded) && (
                    <div
                        className="display-flex flex-row items-start gap-2 text-sm p-2 rounded-md"
                        style={{ color: 'var(--tag-red-secondary)', border: '1px solid var(--tag-red-tertiary)', background: 'var(--tag-red-quinary)' }}
                    >
                        <Icon icon={AlertIcon} className="scale-11 mt-015 flex-none" />
                        <span>
                            {allLibrariesExcluded
                                ? "All libraries are excluded. Beaver can't access any libraries."
                                : "Your personal library is excluded on every device connected to this account."}
                        </span>
                    </div>
                )}

                <div className="display-flex flex-col rounded-md border-popup">
                    {excludedRows.length === 0 ? (
                        <div className="p-2 text-base font-color-secondary">
                            No libraries excluded.
                        </div>
                    ) : (
                        excludedRows.map((library, index) => {
                            const stats = libraryStatsById[library.library_id];
                            return (
                                <div
                                    key={library.library_id}
                                    className={`display-flex flex-row items-center justify-between p-3 ${index > 0 ? 'border-top-quinary' : ''}`}
                                >
                                    <div className="display-flex flex-row items-start gap-2 min-w-0">
                                        <span className="scale-90 -mt-010">
                                            <CSSIcon
                                                name={library.is_group ? 'library-group' : 'library'}
                                                className="icon-16 font-color-secondary"
                                            />
                                        </span>
                                        <div className="display-flex flex-col min-w-0 gap-1">
                                            <div className="font-color-primary truncate">{library.name}</div>
                                            <div className="text-sm font-color-tertiary">
                                                {isLoadingStats && !stats
                                                    ? 'Loading...'
                                                    : stats ? `${stats.itemCount.toLocaleString()} items, ${stats.attachmentCount.toLocaleString()} attachments` : '...'
                                                }
                                            </div>
                                        </div>
                                    </div>
                                    <div className="display-flex flex-row items-center gap-4 mr-1">
                                        <IconButton
                                            onClick={() => handleToggleLibrary(library)}
                                            variant="ghost-secondary"
                                            ariaLabel="Restore Library"
                                            disabled={isUpdating}
                                            title="Restore Library"
                                            icon={UndoIcon}
                                            className="scale-11"
                                        />
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            <SearchMenu
                menuItems={addLibraryMenuItems}
                isOpen={isMenuOpen}
                onClose={() => setIsMenuOpen(false)}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition="below"
                positionAdjustment={{ y: 18 }}
                width="280px"
                maxHeight="260px"
                onSearch={() => {}}
                noResultsText="No libraries found"
                placeholder="Search libraries"
                closeOnSelect={true}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                showSearchInput={unexcludedLibraries.length > 5}
            />
        </div>
    );
};

export default ExcludedLibrariesList;
