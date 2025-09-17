import React, { useEffect, useState, useMemo, Dispatch, SetStateAction } from "react";
import { Spinner, CSSIcon } from "./icons/icons";
import { getLibraryItemCounts, LibraryStatistics } from "../../src/utils/libraries";
import { profileBalanceAtom, planNameAtom} from "../atoms/profile";
import { useAtomValue } from "jotai";
import Button from "./ui/Button";

interface LibrarySelectionProps {
    libraryStatistics: LibraryStatistics[];
    setLibraryStatistics: (statistics: LibraryStatistics[]) => void;
    selectedLibraryIds: number[];
    setSelectedLibraryIds: Dispatch<SetStateAction<number[]>>;
    note?: string;
}

const LibrarySelection: React.FC<LibrarySelectionProps> = ({
    libraryStatistics,
    setLibraryStatistics,
    selectedLibraryIds,
    setSelectedLibraryIds,
    note
}) => {
    // Plan and profile balance
    const profileBalance = useAtomValue(profileBalanceAtom);
    const planName = useAtomValue(planNameAtom);
    // State for basic library information (available immediately)
    const [libraries, setLibraries] = useState<{ libraryID: number, name: string, isGroup: boolean }[]>([]);
    // Loading state
    const [isLoading, setIsLoading] = useState(true);

    // Load basic library info immediately
    useEffect(() => {
        const loadBasicLibraryInfo = async () => {
            try {
                // Get all libraries
                const allLibraries = await Zotero.Libraries.getAll();
                // Filter to user libraries
                const userLibraries = allLibraries.filter(library => library.libraryType === 'user' || library.libraryType === "group");
                
                // Create a simple array with just id, name, isGroup
                const basicInfo = userLibraries.map(library => ({
                    libraryID: library.libraryID,
                    groupID: library.isGroup ? library.id : null,
                    name: library.name,
                    isGroup: library.isGroup
                }));
                
                setLibraries(basicInfo);
            } catch (error) {
                console.error("Error loading library info:", error);
            }
        };
        
        loadBasicLibraryInfo();
    }, []);

    // Load detailed library statistics in a separate effect
    useEffect(() => {
        if (libraries.length === 0) return;
        const fetchLibraryStatistics = async () => {
            try {
                setIsLoading(true);
                const promises = libraries.map(library => getLibraryItemCounts(library.libraryID));
                const stats = await Promise.all(promises);
                setLibraryStatistics(stats);
                setIsLoading(false);
            } catch (error) {
                console.error("Error fetching library statistics:", error);
                setIsLoading(false);
            }
        };
        
        fetchLibraryStatistics();
    }, [libraries]);

    // Calculate totals for selected libraries
    const selectedLibraryTotals = useMemo(() => {
        return (libraryStatistics || [])
            .filter(lib => selectedLibraryIds.includes(lib.libraryID))
            .reduce((totals, lib) => {
                return {
                    itemCount: totals.itemCount + lib.itemCount,
                    attachmentCount: totals.attachmentCount + lib.attachmentCount,
                    pdfCount: totals.pdfCount + lib.pdfCount,
                    imageCount: totals.imageCount + lib.imageCount,
                    pageCount: totals.pageCount + (lib.pageCount || 0)
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
        <div className="display-flex flex-col flex-1 min-h-0 gap-3">

            {/* Library list */}
            <div className="display-flex flex-col gap-1 border-popup rounded-md p-2" style={{ minHeight: '108px', maxHeight: '300px', overflowY: 'auto' }}>
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

                                <div className="display-flex flex-col gap-3">
                                    <div className="display-flex flex-row gap-3 items-center">
                                        <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16" />
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
                                                {[
                                                    statistics.itemCount.toLocaleString()  + ' items',
                                                    statistics.attachmentCount.toLocaleString() + ' attachments',
                                                    statistics.pageCount ? statistics.pageCount.toLocaleString() + ' pages' : ''
                                                ].filter(Boolean).join(', ')}
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
            {/* <div className="display-flex flex-row gap-2">
                <Button variant="outline" onClick={() => handleLibraryToggle(0)}>Select Group Libraries</Button>
            </div> */}

            {/* Beta Account */}
            {planName !== 'free' && (
                <div className="font-color-tertiary text-sm px-2">
                    {/* Your beta account includes unlimited metadata and related reference search. */}
                    {note ? note : 'Beta accounts include unlimited metadata and related reference search. Full-document search is limited to 75,000 pages total, with PDFs up to 500 pages (50MB) per file.'}
                </div>
            )}
            
            {/* Free Account */}
            {planName === 'free' && (
                <div className="display-flex flex-col gap-3">
                    <div className="font-color-tertiary text-sm px-2">
                        Free accounts supports unlimited metadata and related item search.
                    </div>
                    <div className="mt-4 display-flex flex-col gap-3">
                        <div className="p-3 rounded-md bg-senary">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <div className="font-medium">Upgrade Account</div>
                                <Button variant="surface">Upgrade</Button>
                            </div>
                            <div className="text-sm font-color-secondary">
                                Full-document search, sentence-level citations, etc...
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default LibrarySelection;
