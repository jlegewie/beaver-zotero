import React, { useEffect, useState, useMemo } from "react";
import { Icon, Spinner, CSSIcon, TickIcon, InformationCircleIcon } from "../icons/icons";
import { getLibraryStatistics, LibraryStatistics } from "../../../src/utils/libraries";
import { planFeaturesAtom, profileBalanceAtom, planNameAtom, planDisplayNameAtom} from "../../atoms/profile";
import ZoteroSyncToggle from "../preferences/SyncToggle";
import { useAtomValue } from "jotai";
import Button from "../ui/Button";
import ConsentToggle from "../preferences/ConsentToggle";

interface AuthorizeLibraryAccessProps {
    onSelectionChange?: (selectedLibraries: number[]) => void;
    libraryStatistics: LibraryStatistics[];
    setLibraryStatistics: (statistics: LibraryStatistics[]) => void;
    useZoteroSync: boolean;
    handleSyncToggleChange: (checked: boolean) => void;
    disableSyncToggle: boolean;
    consentToShare: boolean;
    handleConsentChange: (checked: boolean) => void;
}

const AuthorizeLibraryAccess: React.FC<AuthorizeLibraryAccessProps> = ({
    onSelectionChange,
    libraryStatistics,
    setLibraryStatistics,
    useZoteroSync,
    handleSyncToggleChange,
    disableSyncToggle,
    consentToShare,
    handleConsentChange
}) => {
    // Plan and profile balance
    const planFeatures = useAtomValue(planFeaturesAtom);
    const profileBalance = useAtomValue(profileBalanceAtom);
    const planName = useAtomValue(planNameAtom);
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
                const userLibraries = allLibraries.filter(library => library.libraryType === 'user' || library.libraryType === 'group');
                
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

    const getExceedsBalanceText = (page_limit: number) => {
        return `Your library exceeds your available page credits. The page count is an estimate and may include pages that won't be processed. If the final count exceeds the limit, some documents won't be searchable, but you can still add them manually`;
    };
    
    // Check if selected libraries exceed the page balance
    const exceedsBalance = selectedLibraryTotals.pageCount > profileBalance.pagesRemaining;
    
    return (
        <div className="display-flex flex-col gap-4 flex-1 min-h-0">
            <div className="text-lg font-semibold">Step 1: Select Libraries</div>
            <div className="display-flex flex-col flex-1 min-h-0 gap-3">

                {/* Library list */}
                <div className="display-flex flex-col gap-1">
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
                <div className="display-flex flex-row gap-2">
                    <Button variant="outline" onClick={() => handleLibraryToggle(0)}>Select Group Libraries</Button>
                </div>

                {isLoading && (
                    <div className="font-color-tertiary text-sm">
                        Loading library statistics may take a few minutes...
                    </div>
                )}

                {/* Beta Account */}
                {!isLoading && (planName === 'beta') && (
                    <div className="mt-4 display-flex flex-col gap-3">
                        <div className="p-3 rounded-md bg-senary border-popup">
                            <div className="display-flex flex-row items-center mb-1">
                                <div className="font-medium">{planDisplayName} Account (free)</div>
                                <div className="flex-1"/>
                                {!exceedsBalance && ( <Icon className="scale-12" icon={TickIcon}/>)}
                                {exceedsBalance && (
                                    // <div className="display-flex flex-row gap-1" title="Pages in selected libraries exceed plan limits. Some documents won't be searchable.">
                                    <div className="display-flex flex-row gap-1" title={getExceedsBalanceText(profileBalance.pagesRemaining)}>
                                        <div className='text-sm font-color-red'>
                                            Page limit exceeded
                                        </div>
                                        <Icon className="font-color-red mt-015" icon={InformationCircleIcon}/>
                                    </div>
                                )}
                            </div>
                            <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                                <div>Basic processing and search ({profileBalance.pagesRemaining.toLocaleString()} pages)</div>
                            </div>
                        </div>
                        <div className="p-3 rounded-md bg-senary">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <div className="font-medium">Coming soon</div>
                            </div>
                            <div className="text-sm font-color-secondary">
                                Better search with semantic document understanding.
                            </div>
                        </div>
                    </div>
                )}
                
                {/* Free Account */}
                {!isLoading && (planName === 'free') && (
                    <div className="mt-4 display-flex flex-col gap-3">
                        <div className="p-3 rounded-md bg-senary border-popup">
                            <div className="display-flex flex-row items-center mb-1">
                                <div className="font-medium">Free Account</div>
                                <div className="flex-1"/>
                                <Icon className="scale-12" icon={TickIcon}/>
                            </div>
                            <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                                <div>Unlimited metadata and related item search</div>
                            </div>
                        </div>
                        <div className="p-3 rounded-md bg-senary">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <div className="font-medium">Upgrade Account</div>
                                <Button variant="surface">Upgrade</Button>
                            </div>
                            <div className="text-sm font-color-secondary">
                                Full-text search and more...
                            </div>
                        </div>
                    </div>
                )}

                {/* Core Account */}
                {!isLoading && planName === 'core' && (
                    <div className="mt-4 display-flex flex-col gap-3">
                        <div className="p-3 rounded-md bg-senary border-popup">
                            <div className="display-flex flex-row items-center mb-1">
                                <div className="font-medium">{planDisplayName} Account</div>
                                <div className="flex-1"/>
                                {!exceedsBalance && ( <Icon className="scale-12" icon={TickIcon}/>)}
                                {exceedsBalance && (
                                    <div className="display-flex flex-row gap-1" title={getExceedsBalanceText(profileBalance.pagesRemaining)}>
                                        <div className='text-sm font-medium font-color-yellow'>
                                            Account limit exceeded
                                        </div>
                                        <Icon className="font-color-yellow mt-015" icon={InformationCircleIcon}/>
                                    </div>
                                )}
                            </div>
                            <div className="display-flex flex-row justify-between items-center text-sm font-color-secondary">
                                <div>Better processing & semantic search ({profileBalance.pagesRemaining.toLocaleString()} pages)</div>
                            </div>
                        </div>
                        <div className="p-3 rounded-md bg-senary">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <div className="font-medium">Upgrade Account</div>
                                <Button variant="surface">Upgrade</Button>
                            </div>
                            <div className="text-sm font-color-secondary">
                                Unlimited pages and advanced semantic search
                            </div>
                        </div>
                    </div>
                )}

                {/* {!isLoading && exceedsBalance && (
                    <div className="font-color-red p-2 display-flex flex-row gap-3 items-start">
                        <Icon icon={AlertIcon} className="scale-12 mt-1"/>
                        <div className="display-flex flex-col gap-2">
                            {`Pages in selected libraries exceed plan limits. Some documents won't be searchable.`}
                        </div>
                    </div>
                )} */}
                <div className="flex-1" />
                {!isLoading && (
                    <div className="display-flex flex-col gap-3">
                        <div className="h-1 border-top-quinary" />
                        <ZoteroSyncToggle 
                            checked={useZoteroSync}
                            onChange={handleSyncToggleChange}
                            disabled={disableSyncToggle}
                        />
                        <ConsentToggle
                            checked={consentToShare}
                            onChange={handleConsentChange}
                        />
                    </div>
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
        </div>
    );
};

export default AuthorizeLibraryAccess;