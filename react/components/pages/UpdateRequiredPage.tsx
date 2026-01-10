import React from "react";
import { useAtomValue } from "jotai";
import { minimumFrontendVersionAtom } from "../../atoms/profile";
import { OnboardingHeader } from "./onboarding";
import { Icon, DownloadIcon, SettingsIcon, SyncIcon } from "../icons/icons";

/**
 * Update Required page - blocks access until user updates the plugin
 * 
 * Shows when the backend requires a newer frontend version than currently installed.
 * Provides clear instructions on how to update via Zotero's plugin manager.
 */
const UpdateRequiredPage: React.FC = () => {
    const minimumVersion = useAtomValue(minimumFrontendVersionAtom);
    const currentVersion = Zotero.Beaver?.pluginVersion || "unknown";

    const getHeaderMessage = () => {
        return (
            <div className="display-flex flex-col gap-2 py-2 mt-2">
                <div>
                    A new version of Beaver is required to continue.
                </div>
                <div className="font-color-secondary text-sm">
                    Current version: <span className="font-mono">{currentVersion}</span>
                    <br />
                    Required version: <span className="font-mono">{minimumVersion}</span>
                </div>
            </div>
        );
    };

    return (
        <div 
            id="update-required-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader 
                    title="Update Required" 
                    message={getHeaderMessage()} 
                />

                {/* Main content */}
                <div className="display-flex flex-col gap-4 mt-4">
                    {/* Update instructions */}
                    <div className="display-flex flex-col gap-3 p-4 rounded-lg bg-senary">
                        <div className="display-flex flex-row gap-3 items-start">
                            <Icon icon={DownloadIcon} className="mt-020 scale-11" />
                            <div className="display-flex flex-col gap-3">
                                <div className="font-semibold">How to update Beaver</div>
                                <ol className="display-flex flex-col gap-3 font-color-secondary pl-4">
                                    <li className="display-flex flex-row gap-2 items-start">
                                        <span className="font-semibold">1.</span>
                                        <span>
                                            In Zotero, select <span className="font-semibold">Tools → Plugins</span>
                                        </span>
                                    </li>
                                    <li className="display-flex flex-row gap-2 items-start">
                                        <span className="font-semibold">2.</span>
                                        <span className="display-flex flex-row gap-1 items-center flex-wrap">
                                            Click on the settings icon
                                            <Icon icon={SettingsIcon} className="scale-85 mx-05" />
                                            and select <span className="font-semibold">"Check for Updates"</span>
                                        </span>
                                    </li>
                                    <li className="display-flex flex-row gap-2 items-start">
                                        <span className="font-semibold">3.</span>
                                        <span>Install the update and restart Zotero</span>
                                    </li>
                                </ol>
                            </div>
                        </div>
                    </div>

                    {/* Alternative: Manual download */}
                    <div className="display-flex flex-col gap-3 p-4 rounded-lg border-quinary">
                        <div className="display-flex flex-row gap-3 items-start">
                            <Icon icon={SyncIcon} className="mt-020 scale-11 font-color-secondary" />
                            <div className="display-flex flex-col gap-2">
                                <div className="font-semibold">Already updated?</div>
                                <div className="font-color-secondary">
                                    If you've already updated, try restarting Zotero or{" "}
                                    <a 
                                        className="text-link cursor-pointer" 
                                        onClick={() => Zotero.launchURL('https://www.beaverapp.ai/download')}
                                    >
                                        download the latest version manually
                                    </a>.
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Spacer */}
                    <div className="flex-1" />
                </div>
            </div>
        </div>
    );
};

export default UpdateRequiredPage;
