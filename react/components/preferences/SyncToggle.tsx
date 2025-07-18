import React from "react";

interface ZoteroSyncToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    error?: boolean;
}

const ZoteroSyncToggle: React.FC<ZoteroSyncToggleProps> = ({ checked, onChange, disabled, error }) => {
    const handleToggle = () => {
        onChange(!checked);
    };

    return (
        <div
            className={`display-flex flex-col rounded-md ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            onClick={disabled ? undefined : handleToggle}
            title={disabled
                ? "Enable Zotero sync for your main library to use this feature."
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
                        <div className="display-flex flex-row gap-4 items-center">
                            <div className="font-color-primary text-base">
                                Sync with Zotero
                            </div>
                            {!disabled && !error && (
                                <div className="font-color-secondary scale-90 px-15 py-05 mt-020 text-sm rounded-md bg-quinary border-quinary">
                                    Recommended
                                </div>
                            )}
                            {error && (
                                <div
                                    className="scale-90 px-15 py-05 mt-020 text-sm rounded-md bg-quinary border-error"
                                    style={{ color: 'var(--tag-red-secondary)', borderColor: 'var(--tag-red-tertiary)', background: 'var(--tag-red-quinary)' }}
                                    title="Unable to sync with Beaver. Please enable Zotero sync in Zotero preferences, sign into your Zotero account or disable the Beaver preference 'Sync with Zotero'."
                                >
                                    Error
                                </div>
                            )}
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