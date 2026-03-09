import React from "react";
import { useAtomValue } from "jotai";
import { fileStatusSummaryAtom, connectionStatusAtom } from "../../atoms/files";
import { Spinner, SyncIcon, Icon, AlertIcon } from "../icons/icons";
import { openPreferencesWindow } from "../../../src/ui/openPreferencesWindow";
import { useFileStatus } from "../../hooks/useFileStatus";
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";

/**
 * Minimal one-line file processing status indicator for the homepage footer.
 * Visible during active processing, when there are errors, or during connection issues.
 * Clicking opens the preferences window on the sync tab.
 */
const FileStatusBar: React.FC = () => {
    // Realtime listening for file status updates
    useFileStatus(true);
    useIndexingCompleteMessage();

    const summary = useAtomValue(fileStatusSummaryAtom);
    const connectionStatus = useAtomValue(connectionStatusAtom);

    // Determine visibility
    const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
    const isError = connectionStatus === 'error' || connectionStatus === 'disconnected';
    const isConnected = connectionStatus === 'connected';

    const hasFiles = summary.fileStatusAvailable && summary.totalFiles > 0;
    const isActivelyProcessing = hasFiles && (summary.activeCount > 0 || summary.queuedProcessingCount > 0);
    const hasFailed = hasFiles && summary.failedCount > 0;
    const isFullyComplete = hasFiles && !isActivelyProcessing && !hasFailed;

    // Hidden when: no files exist, or everything is fully complete with no errors, or idle
    if (connectionStatus === 'idle') return null;
    if (isConnected && !hasFiles) return null;
    if (isConnected && isFullyComplete) return null;

    // Determine icon
    let icon: React.ReactNode;
    if (isConnecting || isActivelyProcessing) {
        icon = <Spinner size={11} />;
    } else if (isError || hasFailed) {
        icon = <Icon icon={AlertIcon} className="scale-90 font-color-yellow" />;
    } else {
        icon = <Icon icon={SyncIcon} className="scale-90" />;
    }

    // Determine text
    let text: string;
    if (isConnecting) {
        text = "Connecting...";
    } else if (isError) {
        text = "File sync issue";
    } else if (isActivelyProcessing) {
        text = `Processing files... ${summary.indexingProgress}%`;
    } else if (hasFailed) {
        text = `${summary.failedCount} file${summary.failedCount !== 1 ? 's' : ''} failed`;
    } else {
        text = "File processing";
    }

    return (
        <div
            className="file-status-bar mt-2"
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
