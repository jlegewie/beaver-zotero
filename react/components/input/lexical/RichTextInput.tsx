import React, { useRef, useImperativeHandle, useCallback, forwardRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { LexicalEditor } from 'lexical';

import { ZoteroItemNode } from './ZoteroItemNode';
import PlainTextValuePlugin from './PlainTextValuePlugin';
import ZoteroItemTransformPlugin from './ZoteroItemTransformPlugin';
import KeyboardShortcutsPlugin from './KeyboardShortcutsPlugin';
import EditorRefPlugin from './EditorRefPlugin';
import { EditorHandle } from './types';
import { logger } from '../../../../src/utils/logger';

interface RichTextInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onNewThread: () => void;
    onCustomPrompt: (i: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) => void;
    onAtTrigger: () => void;
    placeholder?: string;
    disabled?: boolean;
    isAwaitingApproval?: boolean;
    className?: string;
}

const RichTextInput = forwardRef<EditorHandle, RichTextInputProps>(
    (
        {
            value,
            onChange,
            onSubmit,
            onNewThread,
            onCustomPrompt,
            onAtTrigger,
            placeholder,
            disabled = false,
            isAwaitingApproval = false,
            className = 'chat-input',
        },
        ref,
    ) => {
        const editorRef = useRef<LexicalEditor | null>(null);

        useImperativeHandle(ref, () => ({
            focus: () => {
                editorRef.current?.focus();
            },
            blur: () => {
                editorRef.current?.blur();
            },
        }));

        // Stop keyboard events from bubbling to Zotero's document-level handlers
        // (e.g., arrow keys navigating collections instead of the editor text)
        const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
            e.stopPropagation();

            // In Zotero's XUL document, the browser's default action for arrow keys
            // includes XUL focus navigation (moving focus between chrome elements).
            // We must preventDefault() to stop this, then manually handle cursor
            // movement via Selection.modify() since Lexical relies on the browser's
            // default action for contentEditable cursor movement.
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();

                const win = (e.target as HTMLElement).ownerDocument?.defaultView;
                const sel = win?.getSelection();
                if (!sel) return;

                const alter = e.shiftKey ? 'extend' : 'move';
                const isHorizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
                const direction = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? 'backward' : 'forward';

                let granularity: string;
                if (isHorizontal) {
                    if ((Zotero.isMac && e.altKey) || (!Zotero.isMac && e.ctrlKey)) {
                        granularity = 'word';
                    } else if (Zotero.isMac && e.metaKey) {
                        granularity = 'lineboundary';
                    } else {
                        granularity = 'character';
                    }
                } else {
                    if (Zotero.isMac && e.metaKey) {
                        granularity = 'documentboundary';
                    } else if ((Zotero.isMac && e.altKey) || (!Zotero.isMac && e.ctrlKey)) {
                        granularity = 'paragraph';
                    } else {
                        granularity = 'line';
                    }
                }

                sel.modify(alter, direction, granularity);
            }
        }, []);

        const initialConfig = {
            namespace: 'BeaverInput',
            nodes: [ZoteroItemNode],
            theme: {
                paragraph: 'lexical-paragraph',
            },
            onError: (error: Error) => {
                logger(`Lexical error: ${error.message}`, 1);
            },
        };

        return (
            <LexicalComposer initialConfig={initialConfig}>
                <div className="lexical-editor-container" onKeyDown={handleKeyDown}>
                    <PlainTextPlugin
                        contentEditable={
                            placeholder ? (
                                <ContentEditable
                                    className={className}
                                    aria-placeholder={placeholder}
                                    placeholder={
                                        <div className="lexical-placeholder">{placeholder}</div>
                                    }
                                />
                            ) : (
                                <ContentEditable
                                    className={className}
                                />
                            )
                        }
                        ErrorBoundary={LexicalErrorBoundary}
                    />
                    <PlainTextValuePlugin value={value} onChange={onChange} />
                    <ZoteroItemTransformPlugin />
                    <KeyboardShortcutsPlugin
                        onSubmit={onSubmit}
                        onNewThread={onNewThread}
                        onCustomPrompt={onCustomPrompt}
                        onAtTrigger={onAtTrigger}
                        disabled={disabled}
                        isAwaitingApproval={isAwaitingApproval}
                    />
                    <EditorRefPlugin editorRef={editorRef} />
                </div>
            </LexicalComposer>
        );
    },
);

RichTextInput.displayName = 'RichTextInput';

export default RichTextInput;
