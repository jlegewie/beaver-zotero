import React, { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    firstRunReturnRequestedAtom,
    firstRunOriginRunIdAtom,
} from '../../../atoms/firstRun';
import { currentMessageContentAtom } from '../../../atoms/messageComposition';
import { PlusSignIcon } from '../../icons/icons';
import ArrowLeftIcon from '../../icons/ArrowLeftIcon';
import Button from '../../ui/Button';


interface BackToSuggestionsProps {
    onDismiss: () => void;
}

/**
 * Rendered once below the first agent run that originated from a
 * first-run suggestion card (matched by run id). "Back to suggestions"
 * re-renders the FirstRunPage from the persisted
 * `profile.library_suggestions` (no regeneration, no second `complete`
 * call).
 *
 * Auto-dismisses when:
 *   - the back link is clicked
 *   - the user types in the input (follow-up path)
 *   - parent stops rendering it (origin run id changes / new run starts)
 */
const BackToSuggestions: React.FC<BackToSuggestionsProps> = ({ onDismiss }) => {
    const setReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const setOriginRunId = useSetAtom(firstRunOriginRunIdAtom);
    const messageContent = useAtomValue(currentMessageContentAtom);

    // Auto-dismiss when the user types a follow-up. Capture the initial value
    // so we don't dismiss on the first render if the input is already non-empty
    // (rare but possible if state leaks across re-mounts).
    const initialContentRef = useRef<string>(messageContent);
    useEffect(() => {
        if (messageContent && messageContent !== initialContentRef.current) {
            onDismiss();
        }
    }, [messageContent, onDismiss]);

    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';

    const handleBack = () => {
        // Clear the origin marker so the just-finished run no longer shows
        // this panel even if the user navigates back to its thread.
        setOriginRunId(null);
        setReturnRequested(true);
        onDismiss();
    };

    return (
        <div className="px-4 pt-3">
            <div className="font-color-tertiary text-sm display-flex flex-col gap-1">
                <Button
                    variant="ghost-secondary"
                    icon={ArrowLeftIcon}
                    onClick={handleBack}
                    className="-ml-2"
                    style={{ fontSize: '1rem' }}
                >
                    Back to suggestions
                </Button>
                <div className="ml-1">
                    Tip: Start a new chat with{' '}
                    <PlusSignIcon
                        width={12}
                        height={12}
                        style={{ verticalAlign: 'middle', color: 'var(--fill-tertiary)' }}
                    />
                    {' '}(top left) or{' '}
                    <span
                        style={{
                            background: 'var(--fill-quinary)',
                            padding: '2px 4px',
                            borderRadius: '3px',
                            fontSize: '0.85em',
                        }}
                    >
                        {newChatShortcut}
                    </span>
                </div>
            </div>
        </div>
    );
};

export default BackToSuggestions;
