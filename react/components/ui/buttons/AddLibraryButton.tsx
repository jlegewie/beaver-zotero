import React from 'react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { profileWithPlanAtom, syncLibraryIdsAtom } from '../../../atoms/profile';
import { PlusSignIcon, CSSIcon, Icon } from '../../icons/icons';
import SearchMenu, { MenuPosition, SearchMenuItem } from '../../ui/menus/SearchMenu';
import { getLibraryItemCounts, LibraryStatistics } from '../../../../src/utils/libraries';
import { isLibraryValidForSync, isLibraryValidForSyncWithServerCheck } from '../../../../src/utils/sync';
import { logger } from '../../../../src/utils/logger';
import { accountService } from '../../../../src/services/accountService';
import { ZoteroLibrary } from '../../../types/zotero';

interface AddLibraryButtonProps {
    disabled?: boolean;
}


const AddLibraryButton: React.FC<AddLibraryButtonProps> = ({ disabled=false }) => {
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);

    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [searchQuery, setSearchQuery] = useState('');
    const [availableLibraries, setAvailableLibraries] = useState<Zotero.Library[]>([]);
    const [libraryStats, setLibraryStats] = useState<Record<number, LibraryStatistics>>({});
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const libraryStatsRef = useRef<Record<number, LibraryStatistics>>({});

    useEffect(() => {
        libraryStatsRef.current = libraryStats;
    }, [libraryStats]);

    const handleOnClose = () => {
        setIsMenuOpen(false);
        setSearchQuery('');
    };

    const handleAddLibrary = useCallback(async (libraryID: number) => {
        logger(`AddLibraryButton: Adding library ${libraryID}`);
        if (!profileWithPlan) {
            logger('Profile not loaded, aborting library update.', 1);
            return;
        }

        // Get the library
        const lib = Zotero.Libraries.get(libraryID);
        if (!lib) return;

        // Group libraries: Check if the library is valid for sync (temporary guard)
        if (lib.isGroup) {
            const isValid = await isLibraryValidForSyncWithServerCheck(lib);
            if (!isValid) {
                Zotero.alert(
                    Zotero.getMainWindow(),
                    'Unable to add library "' + lib.name + '"',
                    'The library includes too many files that are stored on the Zotero server and not locally.\n\nConsider changing the "Download files" setting to "at sync time" in Zotero preferences -> Sync.\n\nLater versions of Beaver might support syncing files stored on the Zotero server.',
                );
                logger(`AddLibraryButton: Library ${libraryID} includes too many files that are stored on the Zotero server and not locally`, 1);
                return;
            }
        }

        // Confirm adding the library
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: 'Sync Library with Beaver?',
            text: `Sync "${lib.name}" with Beaver?\n\nWe'll import your Zotero data, upload attachments, and index everything for search and AI features.`,
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        // Add the library to the sync libraries
        const newSyncLibraryIds = [...syncLibraryIds, libraryID];

        try {
            const libraries = newSyncLibraryIds
                .map(id => {
                    const library = Zotero.Libraries.get(id);
                    if (!library) return null;
                    return {
                        library_id: library.libraryID,
                        group_id: library.isGroup ? library.id : null,
                        name: library.name,
                        is_group: library.isGroup,
                        type: library.libraryType,
                        type_id: library.libraryTypeID,
                    } as ZoteroLibrary;
                })
                .filter((library): library is ZoteroLibrary => library !== null);

            await accountService.updateSyncLibraries(libraries);
            setProfileWithPlan({ ...profileWithPlan, libraries });

            logger(`AddLibraryButton: Successfully added library ${libraryID}.`);
        } catch (error) {
            logger(`AddLibraryButton: Failed to add library ${libraryID}: ${error}`, 1);
            Zotero.logError(error as Error);
        } finally {
            handleOnClose();
        }
    }, [profileWithPlan, setProfileWithPlan, syncLibraryIds]);

    useEffect(() => {
        if (!isMenuOpen) return;

        let isCancelled = false;

        const fetchLibrariesAndStats = async () => {
            const allLibraries = (await Zotero.Libraries.getAll())
                .filter(lib => !syncLibraryIds.includes(lib.libraryID));

            if (isCancelled) return;

            setAvailableLibraries(allLibraries);

            const missingLibraryIds = allLibraries
                .map(lib => lib.libraryID)
                .filter(id => !libraryStatsRef.current[id]);

            if (missingLibraryIds.length === 0) {
                return;
            }

            const statsPromises = missingLibraryIds.map(libId => getLibraryItemCounts(libId));
            const statsResults = await Promise.all(statsPromises);

            const newStats: Record<number, LibraryStatistics> = {};
            statsResults.forEach(stat => {
                if (stat) {
                    newStats[stat.libraryID] = stat;
                }
            });

            if (!isCancelled && Object.keys(newStats).length > 0) {
                setLibraryStats(prev => ({ ...prev, ...newStats }));
            }
        };

        fetchLibrariesAndStats();

        return () => {
            isCancelled = true;
        };
    }, [isMenuOpen, syncLibraryIds]);

    const handleSearch = async (query: string) => {
        setSearchQuery(query);
    };

    const menuItems = useMemo(() => {
        const lowerCaseQuery = searchQuery.toLowerCase();

        return availableLibraries
            .filter(lib => lib.name.toLowerCase().includes(lowerCaseQuery))
            .map<SearchMenuItem>(library => {
                const stats = libraryStats[library.libraryID];
                const isValid = isLibraryValidForSync(library);

                if (!isValid) {
                    return {
                        label: library.name,
                        onClick: () => {},
                        disabled: true,
                        customContent: (
                            <div className="display-flex flex-row gap-2 items-center min-w-0 w-full">
                                <span className="scale-90">
                                    <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16 font-color-secondary" />
                                </span>
                                <div className="display-flex flex-col min-w-0 flex-1">
                                    <span className="truncate font-color-primary">{library.name}</span>
                                    <span className="text-sm font-color-tertiary">
                                        Library not synced with Zotero
                                    </span>
                                </div>
                            </div>
                        ),
                    };
                }

                return {
                    label: library.name,
                    onClick: () => handleAddLibrary(library.libraryID),
                    customContent: (
                        <div className="display-flex flex-row gap-2 items-center min-w-0 w-full">
                            <span className="scale-90">
                                <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16 font-color-secondary" />
                            </span>
                            <div className="display-flex flex-col min-w-0 flex-1">
                                <span className="truncate font-color-primary">{library.name}</span>
                                {stats && (
                                    <span className="text-sm font-color-tertiary">
                                        {stats.itemCount} items, {stats.attachmentCount} attachments
                                    </span>
                                )}
                            </div>
                        </div>
                    ),
                };
            });
    }, [availableLibraries, handleAddLibrary, libraryStats, searchQuery]);

    const handleButtonClick = () => {
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({ x: rect.right, y: rect.top });
            setIsMenuOpen(true);
        }
    };

    return (
        <>
            <button
                className="variant-outline"
                style={{  paddingRight: '4px', paddingLeft: '4px', marginRight: '1px'}}
                ref={buttonRef}
                onClick={handleButtonClick}
                disabled={disabled}
                aria-label="Add Library"
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
            >
                <Icon icon={PlusSignIcon} className="scale-11" />
                <span>Add Library</span>
            </button>
            <SearchMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                onClose={handleOnClose}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition="below"
                positionAdjustment={{y: 18}}
                width="220px"
                maxHeight="260px"
                onSearch={handleSearch}
                noResultsText="No libraries found"
                placeholder="Search libraries"
                closeOnSelect={true}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                showSearchInput={true}
            />
        </>
    );
};

export default AddLibraryButton;
