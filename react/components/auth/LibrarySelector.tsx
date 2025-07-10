import React, { useEffect, useState, useMemo } from "react";
import { Icon, AlertIcon, Spinner, CSSIcon } from "../icons/icons";
import { getLibraryStatistics, LibraryStatistics } from "../../../src/utils/libraries";
import { planFeaturesAtom, profileBalanceAtom, planDisplayNameAtom, planNameAtom } from "../../atoms/profile";
import ZoteroSyncToggle from "../preferences/SyncToggle";
import { useAtomValue } from "jotai";
import Button from "../ui/Button";

interface LibrarySelectorProps {
    onSelectionChange?: (selectedLibraries: number[]) => void;
    libraryStatistics: LibraryStatistics[];
    setLibraryStatistics: (statistics: LibraryStatistics[]) => void;
    useZoteroSync: boolean;
    handleSyncToggleChange: (checked: boolean) => void;
}

const LibrarySelector: React.FC<LibrarySelectorProps> = ({ onSelectionChange, libraryStatistics, setLibraryStatistics, useZoteroSync, handleSyncToggleChange }) => {
    // Plan and profile balance
    const planFeatures = useAtomValue(planFeaturesAtom);
    const profileBalance = useAtomValue(profileBalanceAtom);
    const planDisplayName = useAtomValue(planDisplayNameAtom);
    // State for basic library information (available immediately)
    const [libraries, setLibraries] = useState<{ id: number, name: string, isGroup: boolean }[]>([]);
    // Track which libraries are selected
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([]);
    // Loading state
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        onSelectionChange?.(selectedLibraryIds);
    }, [isLoading]);

    // Load basic library info immediately
    useEffect(() => {
        const loadBasicLibraryInfo = async () => {
            try {
                // Get all libraries
                const allLibraries = await Zotero.Libraries.getAll();
                // Filter to user libraries
                // TODO: Add support for group libraries with library.libraryType == "group"
                const userLibraries = allLibraries.filter(library => library.libraryType === 'user');
                
                // Create a simple array with just id, name, isGroup
                const basicInfo = userLibraries.map(library => ({
                    id: library.libraryID,
                    name: library.name,
                    isGroup: library.isGroup
                }));
                
                setLibraries(basicInfo);
                // Pre-select all libraries by default
                setSelectedLibraryIds(basicInfo.map(lib => lib.id));
            } catch (error) {
                console.error("Error loading library info:", error);
            }
        };
        
        loadBasicLibraryInfo();
    }, []);

    // Load detailed library statistics in a separate effect
    useEffect(() => {
        const fetchLibraryStatistics = async () => {
            try {
                setIsLoading(true);
                const stats = await getLibraryStatistics();
                setLibraryStatistics(stats);
                setIsLoading(false);
            } catch (error) {
                console.error("Error fetching library statistics:", error);
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
                    pdfCount: totals.pdfCount + lib.pdfCount,
                    imageCount: totals.imageCount + lib.imageCount,
                    pageCount: totals.pageCount + lib.pageCount
                };
            }, { 
                itemCount: 0, 
                attachmentCount: 0, 
                pdfCount: 0, 
                imageCount: 0, 
                pageCount: 0 
            });
    }, [libraryStatistics, selectedLibraryIds]);

    // Handle library selection changes
    const handleLibraryToggle = (libraryId: number) => {
        setSelectedLibraryIds(prev => {
            const newSelection = prev.includes(libraryId)
                ? prev.filter(id => id !== libraryId) // Remove if already selected
                : [...prev, libraryId]; // Add if not selected
            
            // Call the parent component's callback with the new selection
            if (onSelectionChange) {
                onSelectionChange(newSelection);
            }
            
            return newSelection;
        });
    };

    // Prevent click propagation from checkbox to parent div
    const handleCheckboxClick = (e: React.MouseEvent) => {
        e.stopPropagation();
    };
    
    // Check if selected libraries exceed the page balance
    const exceedsBalance = selectedLibraryTotals.pageCount > profileBalance.pagesRemaining;
    
    return (
        <div className="display-flex flex-col gap-3">
            {/* <div className="text-lg font-semibold">Step 1: Select Libraries</div> */}

            {/* <div className="text-base font-color-secondary">
                Select the libraries you want to sync. Beaver will sync your Zotero library, upload your PDFs, and index your files for search. This process can take 60 minutes or more.
            </div> */}
            
            {/* Library list */}
            <div className="display-flex flex-col gap-2">
                {libraries.map((library) => {
                    // Find detailed statistics for this library if available
                    const statistics = libraryStatistics.find(stats => stats.libraryID === library.id);
                    const isSelected = selectedLibraryIds.includes(library.id);
                    
                    return (
                        <div 
                            key={library.id}
                            className="display-flex flex-col gap-2 p-2 rounded-md hover:bg-senary cursor-pointer"
                            onClick={() => handleLibraryToggle(library.id)}
                        >
                            <div className="display-flex flex-row gap-2 items-start">

                                <input
                                    type="checkbox" 
                                    className="mr-1 scale-90"
                                    checked={isSelected}
                                    onChange={() => handleLibraryToggle(library.id)}
                                    onClick={handleCheckboxClick}
                                />

                                <div className="display-flex flex-col gap-3">
                                    <div className="display-flex flex-row gap-3 items-center">
                                        <CSSIcon name="library" className="icon-16" />
                                        <div className="font-color-primary text-base">
                                            {library.name}
                                        </div>
                                    </div>
                                    
                                    {/* Statistics or loading spinner */}
                                    <div className="display-flex flex-row gap-3 font-color-secondary text-sm ml-05">
                                        {isLoading ? (
                                            <div className="display-flex flex-row gap-2 items-start">
                                                <Spinner className="mt-015" size={14} />
                                                <div className="display-flex flex-col gap-1">
                                                    <div className="font-color-secondary text-sm">
                                                        Loading library statistics...
                                                    </div> 
                                                </div>
                                            </div>
                                        ) : statistics ? (
                                            <>
                                                {statistics.itemCount.toLocaleString()} items,{' '}
                                                {statistics.attachmentCount.toLocaleString()} attachments,{' '}
                                                {statistics.pageCount.toLocaleString()} pages
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

            {isLoading && (
                <div className="font-color-tertiary text-sm">
                    Loading library statistics may take a few minutes...
                </div>
            )}
            
            {/* Processing tiers */}
            {!isLoading && (
                <div className="mt-4 display-flex flex-col gap-3">

                    {/* Basic Processing */}
                    {planFeatures.processingTier === 'basic' && (
                        <div className={`p-3 rounded-md bg-senary ${planFeatures.processingTier === 'basic' ? "border-popup" : ''}`}>
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <span className="font-medium">Basic Processing</span>
                                {!isLoading && <span className={`text-sm font-medium ${exceedsBalance ? 'text-red-500' : 'text-green-600'}`}>
                                    {exceedsBalance ? 'Exceeds balance' : 'Within balance'}
                                </span>}
                            </div>
                            <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                                {!isLoading && <span>Selected: {selectedLibraryTotals.pageCount.toLocaleString()} pages</span>}
                                <span>Balance: {profileBalance.pagesRemaining.toLocaleString()} pages</span>
                            </div>
                        </div>
                    )}

                    {/* Standard Processing */}
                    {planFeatures.processingTier === 'standard' && (
                        <div className={`p-3 rounded-md bg-senary ${planFeatures.processingTier === 'standard' ? "border-popup" : ''}`}>
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <span className="font-medium">Standard Processing</span>
                                {!isLoading && <span className={`text-sm font-medium ${exceedsBalance ? 'text-red-500' : 'text-green-600'}`}>
                                    {exceedsBalance ? 'Exceeds balance' : 'Within balance'}
                                </span>}
                            </div>
                            <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                                {!isLoading && <span>Selected: {selectedLibraryTotals.pageCount.toLocaleString()} pages</span>}
                                <span>Balance: {profileBalance.pagesRemaining.toLocaleString()} pages</span>
                            </div>
                        </div>
                    )}
                    {planFeatures.processingTier === 'basic' && (
                        <div className="p-3 rounded-md bg-senary">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <span className="font-medium">Standard Processing</span>
                                <Button variant="surface">Upgrade</Button>
                            </div>
                            <div className="text-sm font-color-secondary">
                                Better search with semantic document understanding
                            </div>
                        </div>
                    )}

                    {/* Advanced Processing */}
                    {planFeatures.processingTier === 'advanced' && (
                        <div className="p-3 rounded-md bg-senary border-popup">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <span className="font-medium">Advanced Processing</span>
                                {!isLoading && <span className={`text-sm font-medium ${exceedsBalance ? 'text-red-500' : 'text-green-600'}`}>
                                    {exceedsBalance ? 'Exceeds balance' : 'Within balance'}
                                </span>}
                            </div>
                            <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                                {!isLoading && <span>Selected: {selectedLibraryTotals.pageCount.toLocaleString()} pages</span>} 
                                <span>Balance: {profileBalance.pagesRemaining.toLocaleString()} pages</span>
                            </div>
                        </div>
                    )}
                    {planFeatures.processingTier !== 'advanced' && (
                        /* When user has basic plan, show advanced processing with upgrade button */
                        <div className="p-3 rounded-md bg-senary">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <span className="font-medium">Advanced Processing</span>
                                <Button variant="surface">Upgrade</Button>
                            </div>
                            <div className="text-sm font-color-secondary">
                                Best search with state-of-the-art document processing
                            </div>
                        </div>
                    )}
                </div>
            )}

            {exceedsBalance && (
                <div className="font-color-red p-3 display-flex flex-row gap-3 items-start">
                    <Icon icon={AlertIcon} className="scale-12 mt-1"/>
                    <div className="display-flex flex-col gap-2">
                        {`File pages in selected libraries exceed the limit for the ${planDisplayName} plan. Some documents won't be searchable.`}
                    </div>
                </div>
            )}      

            {!isLoading && (
                <>
                    <div className="flex-1" />
                    <ZoteroSyncToggle 
                        checked={useZoteroSync}
                        onChange={handleSyncToggleChange}
                        disabled={disableSyncToggle}
                    />
                </>
            )}
            

            {/* Totals for selected libraries */}
            {/* {libraryStatistics.length > 0 && (
                <div className="display-flex flex-col gap-1 mt-2 p-3 border-t border-quinary">
                    <div className="font-medium font-color-primary">Selected Libraries Total:</div>
                    <div className="display-flex flex-row gap-4 font-color-secondary text-sm">
                        {selectedLibraryTotals.itemCount} items,{' '}
                        {selectedLibraryTotals.attachmentCount} attachments,{' '}
                        {selectedLibraryTotals.pageCount} pages
                    </div>
                </div>
            )} */}

            
        </div>
    );
};

export default LibrarySelector;