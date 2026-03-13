import React from "react";
import { useAtomValue } from "jotai";
import { fileStatusSummaryAtom, connectionStatusAtom } from "../../atoms/files";
import { Spinner, Icon, AlertIcon, TickIcon, InformationCircleIcon } from "../icons/icons";
import { openPreferencesWindow } from "../../../src/ui/openPreferencesWindow";
import { useFileStatus } from "../../hooks/useFileStatus";
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";
import { hasPopupsOrPreviewsAtom } from "../../atoms/ui";

/**
 * Minimal one-line file processing status indicator for the homepage footer.
 * Always visible once a connection has been attempted. Clicking opens the
 * preferences window on the sync tab.
 */
const FileStatusBar: React.FC = () => {
    useFileStatus(true);
    useIndexingCompleteMessage();

    const summary = useAtomValue(fileStatusSummaryAtom);
    const connectionStatus = useAtomValue(connectionStatusAtom);
    const hasPopupsOrPreviews = useAtomValue(hasPopupsOrPreviewsAtom);

    const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
    const isError = connectionStatus === 'error' || connectionStatus === 'disconnected';
    const isConnected = connectionStatus === 'connected';

    const hasFiles = summary.fileStatusAvailable && summary.totalFiles > 0;
    const isActivelyProcessing = hasFiles && (summary.activeCount > 0 || summary.queuedProcessingCount > 0);

    // Hidden only before any connection attempt
    if (connectionStatus === 'idle') return null;

    // Icon
    let icon: React.ReactNode;
    if (isConnecting || isActivelyProcessing) {
        icon = <Spinner size={11} />;
    } else if (isError) {
        icon = <Icon icon={AlertIcon} className="scale-90 font-color-yellow" />;
    } else if (isConnected) {
        icon = <Icon icon={TickIcon} />;
    } else {
        icon = <Icon icon={InformationCircleIcon} />;
    }

    // Text
    let text: string;
    if (isConnecting) {
        text = "Connecting...";
    } else if (isError) {
        text = "Unable to connect";
    } else if (isActivelyProcessing) {
        text = `Processing files... ${summary.indexingProgress}%`;
    } else if (isConnected) {
        text = "File processing complete. View status.";
    } else {
        text = "View file processing status";
    }

    return (
        <div
            className={`file-status-bar mt-2 -mb-1 ${hasPopupsOrPreviews ? 'opacity-50' : 'opacity-100'}`}
            onClick={() => openPreferencesWindow('sync')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openPreferencesWindow('sync'); }}
        >
            {icon}
            <span>{text}</span>
        </div>
    );
};

export default FileStatusBar;
