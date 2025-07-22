import React, { useEffect, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { 
    isErrorReportDialogVisibleAtom, 
    errorReportTextAtom, 
    isErrorReportSendingAtom 
} from '../atoms/ui';
import { CancelIcon } from './icons/icons';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import { getJotaiState } from '../utils/getJotaiState';
import { accountService } from '../../src/services/accountService';
import { getPref } from '../../src/utils/prefs';

/**
 * Get all plugin preferences for debugging
 */
const getPluginPreferences = () => {
    const prefs: Record<string, any> = {};
    
    // Get all plugin preferences defined in prefs.d.ts
    const prefKeys = [
        'userId', 'userEmail', 'currentPlanId', 'installedVersion', 
        'showIndexingCompleteMessage', 'keyboardShortcut', 'updateSourcesFromZoteroSelection',
        'statefulChat', 'addSelectedItemsOnOpen', 'addSelectedItemsOnNewThread',
        'maxAttachments', 'customInstructions', 'googleGenerativeAiApiKey',
        'openAiApiKey', 'anthropicApiKey', 'lastUsedModel', 'recentItems',
        'citationFormat', 'citationStyle', 'citationLocale', 'customPrompts'
    ] as const;
    
    prefKeys.forEach(key => {
        try {
            // Mask sensitive keys
            if (key.includes('ApiKey')) {
                const value = getPref(key);
                prefs[key] = value ? '[MASKED]' : null;
            } else {
                prefs[key] = getPref(key);
            }
        } catch (error) {
            prefs[key] = `Error reading pref: ${error}`;
        }
    });
    
    return prefs;
};

/**
 * Error reporting dialog component that allows users to report bugs
 */
const ErrorReportDialog: React.FC = () => {
    const [isVisible, setIsVisible] = useAtom(isErrorReportDialogVisibleAtom);
    const [errorText, setErrorText] = useAtom(errorReportTextAtom);
    const [isSending, setIsSending] = useAtom(isErrorReportSendingAtom);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Focus textarea when dialog opens
    useEffect(() => {
        if (isVisible && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isVisible]);

    // Handle ESC key to close dialog
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isVisible && !isSending) {
                handleClose();
            }
        };

        if (isVisible) {
            Zotero.getMainWindow().document.addEventListener('keydown', handleKeyDown);
            return () => Zotero.getMainWindow().document.removeEventListener('keydown', handleKeyDown);
        }
    }, [isVisible, isSending]);

    const handleClose = () => {
        if (!isSending) {
            setIsVisible(false);
            setErrorText('');
        }
    };

    const handleSend = async () => {
        if (errorText.trim().length === 0 || isSending) return;

        setIsSending(true);
        try {
            // Collect debugging information
            const jotaiState = getJotaiState();
            const preferences = getPluginPreferences();
            
            // Send error report to backend
            await accountService.reportError(
                errorText.trim(),
                jotaiState,
                preferences
                // localDbState can be added later if needed
            );
            
            // Close dialog after successful send
            setIsVisible(false);
            setErrorText('');
        } catch (error) {
            console.error('Failed to send error report:', error);
            // TODO: Could show an error message to the user here
        } finally {
            setIsSending(false);
        }
    };

    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setErrorText(e.target.value);
        
        // Auto-resize textarea
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
    };

    if (!isVisible) return null;

    return (
        <div className="absolute inset-0 z-50">
            {/* Overlay backdrop - positioned absolutely within the sidebar */}
            <div 
                className="absolute inset-0 opacity-80 bg-quaternary"
                onClick={(e) => {
                    // Close dialog if clicking on backdrop (but not if sending)
                    if (!isSending) {
                        handleClose();
                    }
                }}
            />
            {/* Dialog container - constrained to sidebar width with padding */}
            <div className="absolute inset-0 display-flex items-center justify-center pointer-events-none">
            <div 
                className="bg-sidepane border-popup rounded-lg shadow-lg mx-3 w-full"
                style={{
                    background: 'var(--material-mix-quarternary)',
                    border: '1px solid var(--fill-quinary)',
                    borderRadius: '8px',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="display-flex flex-row items-center justify-between p-4 pb-3">
                    <div className="text-lg font-semibold">Report Error</div>
                    <IconButton
                        icon={CancelIcon}
                        onClick={handleClose}
                        disabled={isSending}
                        className="scale-12"
                        ariaLabel="Close dialog"
                    />
                </div>

                {/* Content */}
                <div className="px-4 pb-4 display-flex flex-col gap-4">
                    
                    {/* Textarea - styled similar to InputArea */}
                    <div className="user-message-display">
                        <textarea
                            ref={textareaRef}
                            value={errorText}
                            onChange={handleTextareaChange}
                            placeholder="Describe the issue you encountered..."
                            className="chat-input"
                            rows={4}
                            disabled={isSending}
                            style={{ minHeight: '100px' }}
                        />
                    </div>

                    {/* Info note */}
                    <div className="text-sm opacity-60">
                        The current state of your application will be shared with the developers.
                    </div>

                    {/* Buttons */}
                    <div className="display-flex flex-row gap-4 justify-end">
                        <Button
                            variant="outline"
                            onClick={handleClose}
                            disabled={isSending}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="solid"
                            onClick={handleSend}
                            disabled={errorText.trim().length === 0 || isSending}
                            loading={isSending}
                        >
                            {isSending ? 'Sending...' : 'Send'}
                        </Button>
                    </div>
                </div>
            </div>
            </div>
        </div>
    );
};

export default ErrorReportDialog; 