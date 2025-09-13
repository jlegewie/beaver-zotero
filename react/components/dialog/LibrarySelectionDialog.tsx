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
import { syncStatusAtom, LibrarySyncStatus } from '../../atoms/sync';

const LibrarySelectionDialog: React.FC = () => {
    const [isVisible, setIsVisible] = useAtom(isLibrarySelectionDialogVisibleAtom);
    const setSyncStatus = useSetAtom(syncStatusAtom);
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
        if (!profileWithPlan) {
            logger('Profile not loaded, aborting library update.', 1);
            return;
        }

        setIsConfirming(true);
        
        const removedLibraryIds = currentSyncLibraryIds.filter(id => !selectedLibraryIds.includes(id));
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

            // Using authorizeAccess to update the libraries
            await accountService.authorizeAccess(
                false, // Not part of initial onboarding
                libraries, 
                profileWithPlan.plan.processing_tier,
                profileWithPlan.use_zotero_sync,
                profileWithPlan.consent_to_share
            );

            // Optimistically update profile atom
            setProfileWithPlan({ ...profileWithPlan, libraries });

            // Update sync status for new and removed libraries
            const newLibraryIds = selectedLibraryIds.filter(id => !currentSyncLibraryIds.includes(id));
            setSyncStatus(prev => {
                const next = { ...prev };

                // Add new libraries
                newLibraryIds.forEach(id => {
                    const library = libraryStatistics.find(lib => lib.libraryID === id);
                    next[id] = {
                        libraryID: library?.libraryID,
                        libraryName: library?.name || '',
                        itemCount: library?.itemCount || 0,
                        syncedCount: 0,
                        status: (library?.itemCount ?? 0) > 0 ? 'idle' : 'completed',
                    } as LibrarySyncStatus;
                });

                // Remove old libraries
                removedLibraryIds.forEach(id => {
                    delete next[id];
                });

                return next;
            });

            logger('Successfully updated synced libraries.');
            handleClose();

        } catch (error) {
            logger(`Failed to update synced libraries: ${error}`, 1);
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
                <Button variant="outline" onClick={handleClose}>Cancel</Button>
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