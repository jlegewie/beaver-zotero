import React, { useEffect, useState, useMemo } from "react";
import { useAtomValue } from "jotai";
import { CSSIcon, Spinner, CheckmarkCircleIcon } from "../icons/icons";
import { getLibraryStatistics, LibraryStatistics } from "../../../src/utils/libraries";
import { syncLibraryIdsAtom } from "../../atoms/profile";
import Button from "../ui/Button";
import { logger } from "../../../src/utils/logger";


const LibrarySelection: React.FC = () => {
    // Get current sync library IDs from profile
    const currentSyncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    
    // State for basic library information
    const [libraries, setLibraries] = useState<{ libraryID: number, name: string, isGroup: boolean }[]>([]);
    // State for library statistics
    const [libraryStatistics, setLibraryStatistics] = useState<LibraryStatistics[]>([]);
    // Track which libraries are selected
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([]);
    // Loading states
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    // Load basic library info immediately
    useEffect(() => {
        const loadBasicLibraryInfo = async () => {
            try {
                // Get all libraries
                const allLibraries = await Zotero.Libraries.getAll();
                // Filter to user libraries (TODO: Add support for group libraries)
                const userLibraries = allLibraries.filter(library => library.libraryType === 'user');
                
                // Create a simple array with just id, name, isGroup
                const basicInfo = userLibraries.map(library => ({
                    libraryID: library.libraryID,
                    name: library.name,
                    isGroup: library.isGroup
                }));
                
                setLibraries(basicInfo);
                // Initialize selection from current sync library IDs
                setSelectedLibraryIds(currentSyncLibraryIds.filter(id => 
                    basicInfo.some(lib => lib.libraryID === id)
                ));
            } catch (error) {
                logger(`LibrarySelection: Error loading library info: ${error}`);
            }
        };
        
        loadBasicLibraryInfo();
    }, [currentSyncLibraryIds]);

    // Load detailed library statistics
    useEffect(() => {
        const fetchLibraryStatistics = async () => {
            try {
                setIsLoading(true);
                const stats = await getLibraryStatistics(false);
                setLibraryStatistics(stats);
            } catch (error) {
                logger(`LibrarySelection: Error fetching library statistics: ${error}`);
            } finally {
                setIsLoading(false);
            }
        };
        
        fetchLibraryStatistics();
    }, []);

    // Calculate totals for selected libraries
    const selectedLibraryTotals = useMemo(() => {
        return libraryStatistics
            .filter(lib => selectedLibraryIds.includes(lib.libraryID))
            .reduce((totals, lib) => {
                return {
                    itemCount: totals.itemCount + lib.itemCount,
                    attachmentCount: totals.attachmentCount + lib.attachmentCount,
                    pageCount: totals.pageCount + (lib.pageCount || 0)
                };
            }, { 
                itemCount: 0, 
                attachmentCount: 0, 
                pageCount: 0 
            });
    }, [libraryStatistics, selectedLibraryIds]);

    // Handle library selection changes
    const handleLibraryToggle = (libraryId: number) => {
        setSelectedLibraryIds(prev => {
            const newSelection = prev.includes(libraryId)
                ? prev.filter(id => id !== libraryId) // Remove if already selected
                : [...prev, libraryId]; // Add if not selected
            
            return newSelection;
        });
        
        // Clear save success state when selection changes
        setSaveSuccess(false);
    };

    // Handle save/confirm
    const handleSave = async () => {
        setIsSaving(true);
        try {
            // TODO: Implement API call to update library selection
            // For now, just simulate the save
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            setSaveSuccess(true);
            logger('LibrarySelection: Library selection saved successfully');
            
            // Clear success message after 3 seconds
            setTimeout(() => {
                setSaveSuccess(false);
            }, 3000);
            
        } catch (error) {
            logger(`LibrarySelection: Error saving library selection: ${error}`);
        } finally {
            setIsSaving(false);
        }
    };

    // Check if current selection differs from saved selection
    const hasChanges = useMemo(() => {
        if (selectedLibraryIds.length !== currentSyncLibraryIds.length) return true;
        return !selectedLibraryIds.every(id => currentSyncLibraryIds.includes(id));
    }, [selectedLibraryIds, currentSyncLibraryIds]);

    // Prevent click propagation from checkbox to parent div
    const handleCheckboxClick = (e: React.MouseEvent) => {
        e.stopPropagation();
    };
    
    return (
        <div className="display-flex flex-col gap-4">
            <div className="text-sm font-color-secondary">
                Select the libraries you want to sync with Beaver. Changes will take effect after confirming.
            </div>
            
            {/* Library list */}
            <div className="display-flex flex-col gap-2">
                {libraries.map((library) => {
                    // Find detailed statistics for this library if available
                    const statistics = libraryStatistics.find(stats => stats.libraryID === library.libraryID);
                    const isSelected = selectedLibraryIds.includes(library.libraryID);
                    
                    return (
                        <div 
                            key={library.libraryID}
                            className="display-flex flex-col gap-2 p-2 rounded-md hover:bg-senary cursor-pointer"
                            onClick={() => handleLibraryToggle(library.libraryID)}
                        >
                            <div className="display-flex flex-row gap-2 items-start">
                                <input
                                    type="checkbox" 
                                    className="mr-1 scale-90"
                                    checked={isSelected}
                                    onChange={() => handleLibraryToggle(library.libraryID)}
                                    onClick={handleCheckboxClick}
                                />

                                <div className="display-flex flex-col gap-2">
                                    <div className="display-flex flex-row gap-3 items-center">
                                        <CSSIcon name="library" className="icon-16" />
                                        <div className="font-color-primary text-base">
                                            {library.name}
                                        </div>
                                    </div>
                                    
                                    {/* Statistics or loading spinner */}
                                    <div className="display-flex flex-row gap-3 font-color-secondary text-sm ml-05">
                                        {isLoading ? (
                                            <div className="display-flex flex-row gap-2 items-center">
                                                <Spinner size={14} />
                                                <span>Loading statistics...</span>
                                            </div>
                                        ) : statistics ? (
                                            <>
                                                {statistics.itemCount} items,{' '}
                                                {statistics.attachmentCount} attachments,{' '}
                                                Approx. {statistics.pageCount} pages
                                            </>
                                        ) : (
                                            "No statistics available"
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Selection summary */}
            {!isLoading && selectedLibraryIds.length > 0 && (
                <div className="p-3 bg-senary rounded-md">
                    <div className="font-medium font-color-primary mb-1">
                        Selected Libraries Total:
                    </div>
                    <div className="text-sm font-color-secondary">
                        {selectedLibraryTotals.itemCount.toLocaleString()} items,{' '}
                        {selectedLibraryTotals.attachmentCount.toLocaleString()} attachments,{' '}
                        {selectedLibraryTotals.pageCount.toLocaleString()} pages
                    </div>
                </div>
            )}

            {/* Confirm button */}
            <div className="display-flex flex-row gap-3 items-center">
                <Button
                    variant="outline"
                    onClick={handleSave}
                    disabled={!hasChanges || isSaving || selectedLibraryIds.length === 0}
                    rightIcon={isSaving ? Spinner : saveSuccess ? CheckmarkCircleIcon : undefined}
                >
                    {isSaving ? 'Saving...' : saveSuccess ? 'Saved' : 'Confirm Selection'}
                </Button>
                
                {saveSuccess && (
                    <span className="text-sm font-color-secondary">
                        Library selection updated successfully
                    </span>
                )}
            </div>
        </div>
    );
};

export default LibrarySelection;