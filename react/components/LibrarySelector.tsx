import React, { useEffect, useState, useMemo } from "react";
import { Icon, Spinner, CSSIcon } from "./icons/icons";
import { getLibraryStatistics, LibraryStatistics } from "../../src/utils/libraries";
import { planFeaturesAtom, profileBalanceAtom } from "../atoms/profile";
import { useAtomValue } from "jotai";
import Button from "./ui/Button";

interface LibrarySelectorProps {
    onSelectionChange?: (selectedLibraries: number[]) => void;
    libraryStatistics: LibraryStatistics[];
    setLibraryStatistics: (statistics: LibraryStatistics[]) => void;
}

const LibrarySelector: React.FC<LibrarySelectorProps> = ({ onSelectionChange, libraryStatistics, setLibraryStatistics }) => {
    // Plan and profile balance
    const planFeatures = useAtomValue(planFeaturesAtom);
    const profileBalance = useAtomValue(profileBalanceAtom);
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

    // Calculate processing page balance
    const pageBalance = planFeatures.advancedProcessing
        ? profileBalance.advancedPagesRemaining
        : profileBalance.basicPagesRemaining;
    
    // Check if selected libraries exceed the page balance
    const exceedsBalance = selectedLibraryTotals.pageCount > pageBalance;
    
    // Get processing type label
    const processingType = planFeatures.advancedProcessing ? "Advanced" : "Basic";

    return (
        <div className="display-flex flex-col gap-3 mb-6">
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
                                            <>
                                                <Spinner className="" size={14} />
                                                <span>Loading library statistics...</span>
                                            </>
                                        ) : statistics ? (
                                            <>
                                                {statistics.itemCount} items,{' '}
                                                {statistics.attachmentCount} attachments,{' '}
                                                {statistics.pageCount} pages
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
            
            {/* Summary information with page balance */}
            <div className="mt-4 display-flex flex-col gap-3">
                {/* Basic Processing - Show when user has basic plan */}
                {!planFeatures.advancedProcessing && (
                    <div className={`p-3 rounded-md bg-senary ${!planFeatures.advancedProcessing ? "border-popup" : ''}`}>
                        <div className="display-flex flex-row justify-between items-center mb-1">
                            <span className="font-medium">Basic Processing</span>
                            {!isLoading && <span className={`text-sm font-medium ${exceedsBalance ? 'text-red-500' : 'text-green-600'}`}>
                                {exceedsBalance ? 'Exceeds balance' : 'Within balance'}
                            </span>}
                        </div>
                        <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                            {!isLoading && <span>Selected: {selectedLibraryTotals.pageCount.toLocaleString()} pages</span>}
                            <span>Balance: {pageBalance.toLocaleString()} pages</span>
                        </div>
                    </div>
                )}

                {/* Advanced Processing */}
                {planFeatures.advancedProcessing ? (
                    /* When user has advanced plan, show advanced processing with balance */
                    <div className="p-3 rounded-md bg-senary border-popup">
                        <div className="display-flex flex-row justify-between items-center mb-1">
                            <span className="font-medium">Advanced Processing</span>
                            {!isLoading && <span className={`text-sm font-medium ${exceedsBalance ? 'text-red-500' : 'text-green-600'}`}>
                                {exceedsBalance ? 'Exceeds balance' : 'Within balance'}
                            </span>}
                        </div>
                        <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                            {!isLoading && <span>Selected: {selectedLibraryTotals.pageCount.toLocaleString()} pages</span>} 
                            <span>Balance: {profileBalance.advancedPagesRemaining.toLocaleString()} pages</span>
                        </div>
                    </div>
                ) : (
                    /* When user has basic plan, show advanced processing with upgrade button */
                    <div className="p-3 rounded-md bg-senary">
                        <div className="display-flex flex-row justify-between items-center mb-1">
                            <span className="font-medium">Advanced Processing</span>
                            <Button variant="surface">Upgrade</Button>
                        </div>
                        <div className="text-sm font-color-secondary">
                            Upgrade to enable advanced document processing
                        </div>
                    </div>
                )}
            </div>
            

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