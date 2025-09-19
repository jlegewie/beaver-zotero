import React, { useState, useEffect, useMemo, useRef, Dispatch, SetStateAction } from 'react';
import { getLibraryItemCounts, LibraryStatistics } from '../../src/utils/libraries';
import { Icon, DeleteIcon, CSSIcon, PlusSignIcon, AlertIcon } from './icons/icons';
import IconButton from './ui/IconButton';
import SearchMenu, { MenuPosition, SearchMenuItem } from './ui/menus/SearchMenu';
import { isLibrarySynced } from '../../src/utils/zoteroUtils';
import { logger } from '../../src/utils/logger';
import { isLibraryValidForSync } from '../../src/utils/sync';

interface SelectLibrariesProps {
    selectedLibraryIds: number[];
    setSelectedLibraryIds: Dispatch<SetStateAction<number[]>>;
    libraryStatistics: LibraryStatistics[];
    setLibraryStatistics: (statistics: LibraryStatistics[]) => void;
    useZoteroSync: boolean;
}

const SelectLibraries: React.FC<SelectLibrariesProps> = ({
    selectedLibraryIds,
    setSelectedLibraryIds,
    libraryStatistics,
    setLibraryStatistics,
    useZoteroSync,
}) => {
    const [allLibraries, setAllLibraries] = useState<{ libraryID: number, name: string, isGroup: boolean }[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    // Add library menu state
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [searchQuery, setSearchQuery] = useState('');
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    // Load all libraries
    useEffect(() => {
        const loadLibraries = async () => {
            const libs = await Zotero.Libraries.getAll();
            const libsFiltered = libs
                .filter(library => library.libraryType === 'user' || library.libraryType === "group")
                .map(library => ({
                    libraryID: library.libraryID,
                    name: library.name,
                    isGroup: library.isGroup
                }));
            setAllLibraries(libsFiltered);
        };
        loadLibraries();
    }, []);

    // Load library statistics
    useEffect(() => {
        if (allLibraries.length === 0) return;
        const fetchLibraryStatistics = async () => {
            try {
                setIsLoading(true);
                const promises = allLibraries.map(library => getLibraryItemCounts(library.libraryID));
                const stats = await Promise.all(promises);
                setLibraryStatistics(stats);
                setIsLoading(false);
            } catch (error) {
                logger(`Error fetching library statistics: ${error}`, 1);
                setIsLoading(false);
            }
        };
        fetchLibraryStatistics();
    }, [allLibraries, setLibraryStatistics]);

    const handleRemoveLibrary = (libraryId: number) => {
        setSelectedLibraryIds(prev => prev.filter(id => id !== libraryId));
    };

    const handleAddLibrary = (libraryId: number) => {
        setSelectedLibraryIds(prev => [...prev, libraryId]);
        setIsMenuOpen(false);
    };

    const selectedLibraries = useMemo(() => {
        return allLibraries
            .filter(lib => selectedLibraryIds.includes(lib.libraryID))
            .sort((a, b) => a.libraryID - b.libraryID);
    }, [allLibraries, selectedLibraryIds]);
    
    const unselectedLibraries = useMemo(() => {
        return allLibraries.filter(lib => !selectedLibraryIds.includes(lib.libraryID));
    }, [allLibraries, selectedLibraryIds]);

    const availableLibraries = useMemo(() => {
        if (!searchQuery) {
            return unselectedLibraries;
        }
        const lowerCaseQuery = searchQuery.toLowerCase();
        return unselectedLibraries.filter(lib => lib.name.toLowerCase().includes(lowerCaseQuery));
    }, [unselectedLibraries, searchQuery]);

    const addLibraryMenuItems = useMemo((): SearchMenuItem[] => {
        return availableLibraries.map(lib => {
            const stats = libraryStatistics.find(s => s.libraryID === lib.libraryID);
            return {
                label: lib.name,
                onClick: () => handleAddLibrary(lib.libraryID),
                customContent: (
                    <div className="display-flex flex-row gap-2 items-center min-w-0 w-full">
                        <span className="scale-90">
                            <CSSIcon name={lib.isGroup ? "library-group" : "library"} className="icon-16 font-color-secondary" />
                        </span>
                        <div className="display-flex flex-col min-w-0 flex-1">
                            <span className="truncate font-color-primary">{lib.name}</span>
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
    }, [availableLibraries, libraryStatistics, handleAddLibrary]);


    const handleButtonClick = () => {
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({ x: rect.right, y: rect.top });
            setIsMenuOpen(true);
        }
    };

    return (
        <div className="display-flex flex-col gap-3">
            {/* Header */}
            <div className="display-flex flex-row items-center justify-between">
                <div className="text-lg font-semibold">Step 1: Select Libraries</div>
                <div className="flex-1" />
                <button
                    ref={buttonRef}
                    className="variant-outline"
                    style={{ paddingRight: '4px', paddingLeft: '4px', marginRight: '1px' }}
                    onClick={handleButtonClick}
                    disabled={availableLibraries.length === 0 || !useZoteroSync}
                    aria-label="Add Library"
                    title={!useZoteroSync ? 'Group libraries require "Coordinate with Zotero Sync"' : ''}
                >
                    <Icon icon={PlusSignIcon} className="scale-11" />
                    <span>Add Library</span>
                </button>
            </div>

            {/* List */}
            <div className="display-flex flex-col rounded-md border-popup">
                {selectedLibraries.length === 0 ? (
                    <div className="p-2 text-sm font-color-tertiary">No libraries selected yet.</div>
                ) : (
                    selectedLibraries.map((lib, index) => {
                        const stats = libraryStatistics.find(s => s.libraryID === lib.libraryID);
                        const isValid = isLibraryValidForSync(lib, useZoteroSync);
                        let invalidTooltip = '';
                        if (!isValid && lib.isGroup && !useZoteroSync) {
                            invalidTooltip = 'Group libraries can only be synced when "Coordinate with Zotero Sync" is enabled';
                        } else if (!isValid && lib.isGroup && !isLibrarySynced(lib.libraryID)) {
                            invalidTooltip = 'This library is excluded from Zotero Sync. Enable it in Preferences → Sync → Choose Libraries… to sync it with Beaver';
                        }
                        return (
                            <div
                                key={lib.libraryID}
                                className={`display-flex flex-row items-center justify-between p-3 ${index > 0 ? 'border-top-quinary' : ''}`}
                                title={invalidTooltip}
                            >
                                <div className={`display-flex flex-row items-start gap-2 min-w-0 ${isValid ? '' : 'opacity-50'}`}>
                                    
                                    {isValid ? (
                                        <span className="scale-90 -mt-010">
                                            <CSSIcon
                                                name={lib.isGroup ? 'library-group' : 'library'}
                                                className="icon-16 font-color-secondary"
                                            />
                                        </span>
                                    ) : (
                                        <Icon
                                            icon={AlertIcon}
                                            className="scale-13 font-color-secondary mt-020 mr-1"
                                            aria-label={invalidTooltip}
                                        />
                                    )}
                                    
                                    <div className="display-flex flex-col min-w-0 gap-1">
                                        <div className="font-color-primary truncate">{lib.name}</div>
                                        <div className="text-sm font-color-tertiary">
                                            {isLoading && !stats ? 'Loading...' : 
                                             stats ? `${stats.itemCount.toLocaleString()} items, ${stats.attachmentCount.toLocaleString()} attachments` : '...'}
                                        </div>
                                    </div>
                                </div>
                                <div className="display-flex flex-row items-center gap-4 mr-1">
                                    <IconButton
                                        onClick={() => handleRemoveLibrary(lib.libraryID)}
                                        variant="ghost-secondary"
                                        ariaLabel="Remove Library"
                                        disabled={selectedLibraries.length <= 1}
                                        title="Remove Library"
                                        icon={DeleteIcon}
                                        className="scale-11"
                                    />
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
            <SearchMenu
                menuItems={addLibraryMenuItems}
                isOpen={isMenuOpen}
                onClose={() => setIsMenuOpen(false)}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition="below"
                positionAdjustment={{ y: 18 }}
                width="220px"
                maxHeight="260px"
                onSearch={() => {}}
                noResultsText="No libraries found"
                placeholder="Search libraries"
                closeOnSelect={true}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                showSearchInput={unselectedLibraries.length > 5}
            />
        </div>
    );
};

export default SelectLibraries;
