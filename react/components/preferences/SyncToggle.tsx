import React from "react";

interface ZoteroSyncToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

const ZoteroSyncToggle: React.FC<ZoteroSyncToggleProps> = ({ checked, onChange, disabled }) => {
    const handleToggle = () => {
        onChange(!checked);
    };

    return (
        <div
            className={`display-flex flex-col rounded-md ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            onClick={disabled ? undefined : handleToggle}
            title={disabled
                ? "Requires Zotero account"
                : "When enabled, Beaver will build on Zotero sync for multi-device support and improved sync. When disabled, you can only use Beaver on this device."}
        >
            <div className="display-flex flex-row gap-2 items-start">
                <input
                    type="checkbox" 
                    className="mr-1 scale-90"
                    style={{minWidth: 'auto'}}
                    checked={checked}
                    onChange={handleToggle}
                    onClick={(e) => e.stopPropagation()}
                    disabled={disabled}
                />

                <div className="display-flex flex-col gap-1">
                    <div className="display-flex flex-col gap-2 items-start">
                        <div className="font-color-primary text-base">
                            Sync with Zotero
                        </div>
                        <div className="font-color-secondary text-sm">
                            Build on Zotero sync for multi-device support and improved sync.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ZoteroSyncToggle;