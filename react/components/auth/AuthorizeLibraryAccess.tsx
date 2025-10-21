import React, { Dispatch, SetStateAction } from "react";
import { AlertIcon, Icon } from "../icons/icons";
import { LibraryStatistics } from "../../../src/utils/libraries";
import ZoteroSyncToggle from "../preferences/SyncToggle";
import ConsentToggle from "../preferences/ConsentToggle";
import SelectLibraries from "../SelectLibraries";
import { planNameAtom } from "../../atoms/profile";
import { useAtomValue } from "jotai";
import Button from "../ui/Button";

interface AuthorizeLibraryAccessProps {
    selectedLibraryIds: number[];
    setSelectedLibraryIds: Dispatch<SetStateAction<number[]>>;
    libraryStatistics: LibraryStatistics[];
    setLibraryStatistics: (statistics: LibraryStatistics[]) => void;
    useZoteroSync: boolean;
    handleSyncToggleChange: (checked: boolean) => void;
    disableSyncToggle: boolean;
    consentToShare: boolean;
    handleConsentChange: (checked: boolean) => void;
}

const AuthorizeLibraryAccess: React.FC<AuthorizeLibraryAccessProps> = ({
    selectedLibraryIds,
    setSelectedLibraryIds,
    libraryStatistics,
    setLibraryStatistics,
    useZoteroSync,
    handleSyncToggleChange,
    disableSyncToggle,
    consentToShare,
    handleConsentChange
}) => {
    const planName = useAtomValue(planNameAtom);

    return (
        <div className="display-flex flex-col gap-3 flex-1 min-h-0">

            {/* Library Selection */}
            <SelectLibraries
                selectedLibraryIds={selectedLibraryIds}
                setSelectedLibraryIds={setSelectedLibraryIds}
                libraryStatistics={libraryStatistics}
                setLibraryStatistics={setLibraryStatistics}
                useZoteroSync={useZoteroSync}
            />

            {/* Beta Account */}
            {planName === 'beta' && (
                <div className="display-flex flex-row gap-1 items-start">
                    <Icon icon={AlertIcon} className="font-color-secondary scale-11  mt-020" />
                    <div className="font-color-secondary text-sm px-2">
                        Beta accounts are limited to 75,000 pages total, with PDFs up to 500 pages (50MB) per file. If you have large libraries, start by selecting just one or two smaller ones.
                    </div>
                </div>
            )}

            {/* Free Account */}
            {planName === 'free' && (
                <div className="display-flex flex-col gap-5">
                    <div className="font-color-tertiary text-sm px-2">
                        Free accounts supports unlimited metadata and related item search.
                    </div>
                    <div className="p-3 rounded-md bg-senary">
                        <div className="display-flex flex-col gap-2">
                            <div className="display-flex flex-row justify-between items-center mb-1">
                                <div className="font-medium">Upgrade Account</div>
                                <Button variant="outline">Upgrade</Button>
                            </div>
                            <div className="text-sm font-color-secondary">
                                Full-document search, sentence-level citations, etc...
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Sync Toggle & Consent Toggle */}
            <div className="flex-1" />
            <div className="display-flex flex-col gap-4">
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
            
        </div>
    );
};

export default AuthorizeLibraryAccess;