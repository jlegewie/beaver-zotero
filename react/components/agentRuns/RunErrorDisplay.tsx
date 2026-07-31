import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Icon, AlertIcon, RepeatIcon, ArrowDownIcon, ArrowRightIcon, LinkForwardIcon, DollarCircleIcon } from '../icons/icons';
import Button from '../ui/Button';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';
import { regenerateFromRunAtom, resumeFromRunAtom } from '../../atoms/agentRunAtoms';
import { runErrorVisibilityAtom, setRunErrorVisibilityAtom } from '../../atoms/messageUIState';
import { remainingBeaverCreditsAtom, errorCreditCheckAtom } from '../../atoms/profile';
import { beaverDefaultModelAtom, updateSelectedModelAtom, type ModelConfig } from '../../atoms/models';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { getRunErrorTitle } from '../../utils/runErrorCopy';

interface RunError {
    type: string;
    message: string;
    user_facing_details?: string;
    details?: string;
    is_retryable?: boolean;
    has_beaver_fallback?: boolean;
    retry_after?: number;
    is_resumable?: boolean;
}

interface RunErrorDisplayProps {
    runId: string;
    error: RunError;
    isLastRun: boolean;
}

/**
 * Displays an error message for a failed agent run.
 * Shows a collapsible error message with retry and resume buttons.
 */
export const RunErrorDisplay: React.FC<RunErrorDisplayProps> = ({ runId, error, isLastRun }) => {
    const regenerateFromRun = useSetAtom(regenerateFromRunAtom);
    const resumeFromRun = useSetAtom(resumeFromRunAtom);
    const updateSelectedModel = useSetAtom(updateSelectedModelAtom);
    const remainingCredits = useAtomValue(remainingBeaverCreditsAtom);
    const hasCredits = remainingCredits > 0;
    const defaultBeaverModel = useAtomValue(beaverDefaultModelAtom);
    const setErrorCreditCheck = useSetAtom(errorCreditCheckAtom);

    // Visibility state
    const runErrorVisibility = useAtomValue(runErrorVisibilityAtom);
    const setVisibility = useSetAtom(setRunErrorVisibilityAtom);
    const isExpanded = runErrorVisibility[runId] ?? isLastRun;

    const contentRef = useRef<HTMLDivElement | null>(null);

    // Trigger profile refresh when this error has the credit button so credit state is fresh
    useEffect(() => {
        if (error.has_beaver_fallback) {
            setErrorCreditCheck(true);
        }
    }, [error.has_beaver_fallback, setErrorCreditCheck]);

    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    const [isHovered, setIsHovered] = useState(false);

    const handleRetry = async () => {
        await regenerateFromRun(runId);
    };

    const handleResume = async () => {
        await resumeFromRun(runId);
    };

    const handleRetryWithBeaver = async () => {
        if (!defaultBeaverModel) return;
        updateSelectedModel({ ...defaultBeaverModel, access_mode: 'app_key' });
        await regenerateFromRun(runId);
    };

    const handleToggle = () => {
        setVisibility({ runId, visible: !isExpanded });
    };

    // Strip error type prefix if it exists in the message (e.g. "internal_error: message" -> "message")
    const displayMessage = error.message.startsWith(`${error.type}: `)
        ? error.message.substring(error.type.length + 2)
        : error.message;

    // Generic header title
    const headerTitle = getRunErrorTitle(error.type);
    const canTryWithBeaver = Boolean(error.has_beaver_fallback && hasCredits && isLastRun && defaultBeaverModel && error.type !== "usage_limit_exceeded");
    const canGetBeaverCredits = Boolean((error.has_beaver_fallback || error.type === "usage_limit_exceeded") && !hasCredits);
    const canResume = Boolean(error.is_resumable && isLastRun);
    const canRetry = isLastRun;
    const primaryErrorAction = canResume
        ? 'resume'
        : canTryWithBeaver
            ? 'try-with-beaver'
            : canGetBeaverCredits
                ? 'get-beaver-credits'
                : canRetry
                    ? 'retry'
                    : null;
    const primaryActionAttr = (action: string) => primaryErrorAction === action ? 'true' : undefined;

    return (
        <div className="px-4 user-select-text" ref={contentRef} onContextMenu={handleContextMenu}>
             <div
                id={`run-error-${runId}`}
                className={`
                    rounded-md flex flex-col min-w-0 border-error
                    ${isExpanded ? 'mb-2' : ''}
                `}
                style={{ background: 'var(--tag-red-quinary)' }}
            >
                <div
                    className="display-flex flex-row py-15"
                    style={{ 
                        borderBottom: isExpanded ? '1px solid var(--tag-red-quarternary)' : 'none'
                    }}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <button
                        type="button"
                        className="variant-ghost-secondary display-flex flex-row py-15 cursor-pointer gap-2 w-full text-left"
                        style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                        aria-expanded={isExpanded}
                        aria-controls={`run-error-content-${runId}`}
                        onClick={handleToggle}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className="display-flex mt-010 font-color-red">
                                <Icon icon={isHovered ? (isExpanded ? ArrowDownIcon : ArrowRightIcon) : AlertIcon} />
                            </div>
                            
                            <div className="display-flex font-color-red font-medium">
                                {headerTitle}
                            </div>
                        </div>
                    </button>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                    <div className="p-3" id={`run-error-content-${runId}`}>
                        <div className="display-flex flex-col gap-4">
                            <div className="display-flex flex-col gap-1">
                                <div className="text-base font-color-red">
                                    {parseTextWithLinksAndNewlines(displayMessage, "text-link-red")}
                                </div>
                                {error.user_facing_details && (
                                    <div
                                        className="text-base font-color-red user-select-text"
                                        style={{ opacity: 0.75 }}
                                    >
                                        {parseTextWithLinksAndNewlines(
                                            `${error.type === 'connection_error' ? 'Connection details' : 'Reason'}: ${error.user_facing_details}`,
                                            "text-link-red",
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="display-flex flex-row gap-3 items-center">
                                {canTryWithBeaver && (
                                    <Button
                                        variant="error"
                                        iconClassName="font-color-red"
                                        rightIcon={DollarCircleIcon}
                                        onClick={handleRetryWithBeaver}
                                        disabled={!defaultBeaverModel}
                                        data-run-error-action="try-with-beaver"
                                        data-run-error-primary-action={primaryActionAttr('try-with-beaver')}
                                    >
                                        Try with Beaver
                                    </Button>
                                )}
                                {canGetBeaverCredits && (
                                    <Button
                                        variant="error"
                                        iconClassName="font-color-red"
                                        onClick={() => openPreferencesWindow('billing')}
                                        data-run-error-action="get-beaver-credits"
                                        data-run-error-primary-action={primaryActionAttr('get-beaver-credits')}
                                    >
                                        Get Beaver Credits
                                    </Button>
                                )}
                                <div className="flex-1" />
                                {canResume && (
                                    <Button
                                        variant="error"
                                        iconClassName="font-color-red"
                                        rightIcon={LinkForwardIcon}
                                        onClick={handleResume}
                                        data-run-error-action="resume"
                                        data-run-error-primary-action={primaryActionAttr('resume')}
                                    >
                                        Resume
                                    </Button>
                                )}
                                {canRetry && (
                                    <Button
                                        variant="error"
                                        iconClassName="font-color-red"
                                        rightIcon={RepeatIcon}
                                        onClick={handleRetry}
                                        data-run-error-action="retry"
                                        data-run-error-primary-action={primaryActionAttr('retry')}
                                    >
                                        <span className="font-color-red">Retry</span>
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Text selection context menu */}
                <ContextMenu
                    menuItems={selectionMenuItems}
                    isOpen={isSelectionMenuOpen}
                    onClose={closeSelectionMenu}
                    position={selectionMenuPosition}
                    useFixedPosition={true}
                />
            </div>
        </div>
    );
};

export default RunErrorDisplay;
