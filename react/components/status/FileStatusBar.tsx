import React, { useRef, useState, useEffect } from "react";
import { useAtomValue } from "jotai";
import { fileStatusSummaryAtom, connectionStatusAtom } from "../../atoms/files";
import { Spinner, Icon, AlertIcon, TickIcon } from "../icons/icons";
import { openPreferencesWindow } from "../../../src/ui/openPreferencesWindow";
import { useFileStatus } from "../../hooks/useFileStatus";
import { useIndexingCompleteMessage } from "../../hooks/useIndexingCompleteMessage";
import { hasPopupsOrPreviewsAtom } from "../../atoms/ui";

const COMPLETION_DISPLAY_MS = 15_000;

/**
 * Minimal one-line file processing status indicator for the homepage footer.
 * Shows during active processing and briefly after completion, then hides.
 * Clicking opens the preferences window on the sync tab.
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
    const isFullyComplete = hasFiles && !isActivelyProcessing;

    // Track processing→complete transition for auto-hide
    const wasProcessingRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [showComplete, setShowComplete] = useState(false);

    useEffect(() => {
        if (isActivelyProcessing) {
            wasProcessingRef.current = true;
            // Cancel any pending completion timer
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            setShowComplete(false);
        } else if (wasProcessingRef.current && isFullyComplete) {
            // Processing just finished — show completion briefly
            setShowComplete(true);
            timerRef.current = setTimeout(() => {
                setShowComplete(false);
                timerRef.current = null;
            }, COMPLETION_DISPLAY_MS);
        }
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [isActivelyProcessing, isFullyComplete]);

    // Visibility
    if (connectionStatus === 'idle') return null;
    if (isConnected && !hasFiles) return null;
    if (isConnected && isFullyComplete && !showComplete) return null;
    if (isConnected && !isActivelyProcessing && !isFullyComplete && !isConnecting && !isError) return null;

    // Icon
    let icon: React.ReactNode;
    if (isConnecting || isActivelyProcessing) {
        icon = <Spinner size={11} />;
    } else if (isError) {
        icon = <Icon icon={AlertIcon} className="scale-90 font-color-yellow" />;
    } else if (showComplete) {
        icon = <Icon icon={TickIcon} />;
    } else {
        icon = <Spinner size={11} />;
    }

    // Text
    let text: string;
    if (isConnecting) {
        text = "Connecting...";
    } else if (isError) {
        text = "Unable to connect";
    } else if (isActivelyProcessing) {
        text = `Processing files... ${summary.indexingProgress}%`;
    } else if (showComplete) {
        text = "Processing complete. View status.";
    } else {
        text = "File processing";
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
