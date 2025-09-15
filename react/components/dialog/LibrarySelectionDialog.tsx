import React, { useState, useEffect, useCallback } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { isLibrarySelectionDialogVisibleAtom } from '../../atoms/ui';
import { CancelIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import Button from '../ui/Button';
import LibrarySelection from '../LibrarySelection';
import { LibraryStatistics } from '../../../src/utils/libraries';
import { syncLibraryIdsAtom, profileWithPlanAtom } from '../../atoms/profile';
import { logger } from '../../../src/utils/logger';
import { accountService } from '../../../src/services/accountService';
import { ZoteroLibrary } from '../../types/zotero';
import { syncZoteroDatabase, deleteLibraryDataFromBackend } from '../../../src/utils/sync';

const LibrarySelectionDialog: React.FC = () => {
    const [isVisible, setIsVisible] = useAtom(isLibrarySelectionDialogVisibleAtom);
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const currentSyncLibraryIds = useAtomValue(syncLibraryIdsAtom);

    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>(currentSyncLibraryIds);
    const [libraryStatistics, setLibraryStatistics] = useState<LibraryStatistics[]>([]);
    
    // Handle state for this component
    const [isConfirming, setIsConfirming] = useState(false);

    useEffect(() => {
        // Initialize with currently synced libraries when dialog becomes visible
        if (isVisible) {
            setSelectedLibraryIds(currentSyncLibraryIds);
        }
    }, [currentSyncLibraryIds, isVisible]);

    const handleClose = useCallback(() => {
        setIsVisible(false);
    }, [setIsVisible]);
    
    const handleConfirm = async () => {
        logger(`LibrarySelectionDialog: Confirming library selection update.`);
        if (!profileWithPlan) {
            logger('Profile not loaded, aborting library update.', 1);
            return;
        }

        setIsConfirming(true);
        
        // Get removed and added library IDs
        const removedLibraryIds = currentSyncLibraryIds.filter(id => !selectedLibraryIds.includes(id));
        const addedLibraryIds = selectedLibraryIds.filter(id => !currentSyncLibraryIds.includes(id));

        // Confirming removal of libraries
        if (removedLibraryIds.length > 0) {
            const confirmed = Zotero.getMainWindow().confirm(
                `Are you sure you want to remove ${removedLibraryIds.length} librarie${removedLibraryIds.length === 1 ? '' : 's'} from syncing? This will remove all associated data from Beaver.`
                // 'Confirm Library Removal'
            );
            if (!confirmed) {
                setIsConfirming(false);
                return;
            }
        }
        
        try {
            // Update list of libraries to sync
            const libraries = selectedLibraryIds
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

            // Delete data for removed libraries from backend
            if (removedLibraryIds.length > 0) {
                logger(`LibrarySelectionDialog: Removing ${removedLibraryIds.length} libraries from sync.`);
                await Promise.all(removedLibraryIds.map(id => deleteLibraryDataFromBackend(id)));
            }

            // Sync new libraries to Zotero
            await syncZoteroDatabase(addedLibraryIds);

            // Using updateSyncLibraries to update the libraries in the backend
            await accountService.updateSyncLibraries(libraries);

            // Update local state (triggers database sync)
            setProfileWithPlan({ ...profileWithPlan, libraries });

            logger('LibrarySelectionDialog: Successfully updated synced libraries.');
            handleClose();

        } catch (error) {
            logger(`LibrarySelectionDialog: Failed to update synced libraries: ${error}`, 1);
            Zotero.logError(error as Error);
            // Consider reverting optimistic updates here if needed
        } finally {
            setIsConfirming(false);
        }
    };

    return (
        <div
            className="bg-sidepane border-popup rounded-lg shadow-lg mx-3 w-full overflow-hidden pointer-events-auto"
            style={{
                background: 'var(--material-mix-quarternary)',
                border: '1px solid var(--fill-quinary)',
                borderRadius: '8px',
                maxWidth: '500px'
            }}
            onClick={(e) => e.stopPropagation()}
        >
            {/* Header */}
            <div className="display-flex flex-row items-center justify-between p-4 pb-3">
                <div className="text-lg font-semibold">Select Libraries to Sync</div>
                <IconButton
                    icon={CancelIcon}
                    onClick={handleClose}
                    className="scale-12"
                    ariaLabel="Close dialog"
                />
            </div>

            {/* Content */}
            <div className="px-4 pb-4 display-flex flex-col gap-4">
                <LibrarySelection
                    selectedLibraryIds={selectedLibraryIds}
                    setSelectedLibraryIds={setSelectedLibraryIds}
                    libraryStatistics={libraryStatistics}
                    setLibraryStatistics={setLibraryStatistics}
                />
            </div>

            {/* Footer */}
            <div className="p-4 border-top-quinary display-flex flex-row justify-end gap-3">
                {/* <Button variant="outline" onClick={handleClose}>Cancel</Button> */}
                <Button 
                    variant="solid" 
                    onClick={handleConfirm}
                    disabled={isConfirming}
                >
                    {isConfirming ? 'Confirming...' : 'Confirm'}
                </Button>
            </div>
        </div>
    );
};

export default LibrarySelectionDialog;