import React from "react";
import { LibraryStatistics } from "../../../src/utils/libraries";
import ZoteroSyncToggle from "../preferences/SyncToggle";
import ConsentToggle from "../preferences/ConsentToggle";
import LibrarySelection from "../LibrarySelection";

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
    
    return (
        <div className="display-flex flex-col gap-4 flex-1 min-h-0">
            <div className="text-lg font-semibold">Step 1: Select Libraries</div>
            <div className="display-flex flex-col flex-1 min-h-0 gap-3">

                {/* Library Selection */}
                <LibrarySelection
                    onSelectionChange={onSelectionChange}
                    libraryStatistics={libraryStatistics}
                    setLibraryStatistics={setLibraryStatistics}
                />

                {/* Sync Toggle & Consent Toggle */}
                <div className="flex-1" />
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
                
            </div>
        </div>
    );
};

export default AuthorizeLibraryAccess;