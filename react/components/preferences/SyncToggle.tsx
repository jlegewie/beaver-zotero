import React from "react";
import PreferenceToggle from "./PreferenceToggle";

interface ZoteroSyncToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    error?: boolean;
}

const ZoteroSyncToggle: React.FC<ZoteroSyncToggleProps> = ({ checked, onChange, disabled, error }) => {
    return (
        <PreferenceToggle
            checked={checked}
            onChange={onChange}
            disabled={disabled}
            error={error}
            title="Coordinate with Zotero Sync"
            description="Builds on Zotero sync for multi-device support."
            tooltip="When enabled, Beaver will build on Zotero sync for multi-device support and improved sync. When disabled, you can only use Beaver on this device."
            disabledTooltip="Enable Zotero sync for your main library to use this feature."
            errorTooltip="Unable to sync with Beaver. Please enable Zotero sync in Zotero preferences, sign into your Zotero account or disable the Beaver preference 'Sync with Zotero'."
            showRecommended={true}
        />
    );
};

export default ZoteroSyncToggle;