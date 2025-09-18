import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { LibraryIcon, Icon, CSSIcon, TickIcon } from '../../icons/icons';
import SearchMenu, { MenuPosition, SearchMenuItem } from './SearchMenu';
import { useAtomValue, useSetAtom } from 'jotai';
import { syncLibraryIdsAtom } from '../../../atoms/profile';
import { currentLibraryIdsAtom } from '../../../atoms/input';

interface AddLibraryMenuProps {
    showText: boolean;
    onClose: () => void;
    onOpen: () => void;
    isMenuOpen: boolean;
    menuPosition: MenuPosition;
    setMenuPosition: (position: MenuPosition) => void;
}

const AddLibraryMenu: React.FC<AddLibraryMenuProps> = ({
    showText,
    onClose,
    onOpen,
    isMenuOpen,
    menuPosition,
    setMenuPosition,
}) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);
    const [allLibraries, setAllLibraries] = useState<Zotero.Library[]>([]);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    const setCurrentLibraryIds = useSetAtom(currentLibraryIdsAtom);

    const createMenuItemFromLibrary = useCallback((
        library: Zotero.Library,
    ): SearchMenuItem => {

        const getIconElement = (library: Zotero.Library) => {
            return (
                <span className="scale-90">
                    <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16" />
                </span>
            );
        }
        
        return {
            label: library.name,
            onClick: () => {
                setCurrentLibraryIds([library.libraryID]);
                // Delay the onClose call to ensure focus happens after menu is fully closed
                setTimeout(() => {
                    onClose();
                }, 5);
            },
            customContent: (
                <div className={'display-flex flex-row gap-2 items-start min-w-0'}>
                    {getIconElement(library)}
                    <div className="display-flex flex-col gap-2 min-w-0 font-color-secondary">
                        <div className="display-flex flex-row justify-between min-w-0">
                            <span className={'truncate font-color-secondary'}>
                                {library.name}
                            </span>
                        </div>
                    </div>
                </div>
            ),
        };
    }, []);

    // Fetch libraries when menu opens
    useEffect(() => {
        if (isMenuOpen) {
            const fetchLibraries = async () => {
                const libraries = await Zotero.Libraries.getAll();
                const librariesFiltered = libraries.filter((library) => syncLibraryIds.includes(library.libraryID));
                setAllLibraries(librariesFiltered);
            };
            fetchLibraries();
        }
    }, [isMenuOpen, syncLibraryIds]);

    // Update menu items when libraries or search query change
    useEffect(() => {
        if (!isMenuOpen) return;

        const lowerCaseQuery = searchQuery.toLowerCase();
        const filteredLibraries = allLibraries.filter(lib => 
            lib.name.toLowerCase().includes(lowerCaseQuery)
        );

        const items = filteredLibraries.map(lib => {
            return createMenuItemFromLibrary(lib);
        });

        const header = { label: "Select Library", isGroupHeader: true, onClick: () => {} };
        
        setMenuItems([...items.reverse(), header]);

    }, [allLibraries, searchQuery, createMenuItemFromLibrary, isMenuOpen]);


    const handleOnClose = () => {
        setSearchQuery('');
        setMenuItems([]);
        setTimeout(() => {
            onClose();
        }, 5);
    }

    const handleButtonClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({ 
                x: rect.left,
                y: rect.top - 5
            });
            onOpen();
            buttonRef.current.blur();
            const mainWindow = Zotero.getMainWindow();
            mainWindow.document.dispatchEvent(new MouseEvent('click'));
        }
    };

    return (
        <>
            <button
                className="variant-outline source-button"
                style={{ height: '22px !important', paddingRight: '4px', paddingLeft: '4px', paddingTop: '3px', paddingBottom: '3px' }}
                ref={buttonRef}
                onClick={handleButtonClick}
                aria-label="Add Library"
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
            >
                <Icon icon={LibraryIcon} className="scale-12" />
                {showText && <span>Add Library</span>}
            </button>
            <SearchMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                onClose={handleOnClose}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition="above"
                width="250px"
                onSearch={() => {}}
                noResultsText="No libraries found"
                placeholder="Search libraries"
                closeOnSelect={true}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                showSearchInput={allLibraries.length > 5}
            />
        </>
    );
};

export default AddLibraryMenu;
