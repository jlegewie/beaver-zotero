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

type SelectionModifyParams = {
    alter: 'move' | 'extend';
    direction: 'backward' | 'forward';
    granularity: string;
};

/**
 * Map navigation key events to Selection.modify() parameters.
 * Returns null for non-navigation keys.
 */
function getNavigationParams(e: React.KeyboardEvent): SelectionModifyParams | null {
    const alter = e.shiftKey ? 'extend' : 'move';
    const isMac = Zotero.isMac;
    const modKey = isMac ? e.altKey : e.ctrlKey;

    switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
            const direction = e.key === 'ArrowLeft' ? 'backward' : 'forward';
            let granularity = 'character';
            if (modKey) granularity = 'word';
            else if (isMac && e.metaKey) granularity = 'lineboundary';
            return { alter, direction, granularity };
        }
        case 'ArrowUp':
        case 'ArrowDown': {
            const direction = e.key === 'ArrowUp' ? 'backward' : 'forward';
            let granularity = 'line';
            if (isMac && e.metaKey) granularity = 'documentboundary';
            else if (modKey) granularity = 'paragraph';
            return { alter, direction, granularity };
        }
        case 'Home':
            if ((isMac && e.metaKey) || (!isMac && e.ctrlKey)) {
                return { alter, direction: 'backward', granularity: 'documentboundary' };
            }
            return { alter, direction: 'backward', granularity: 'lineboundary' };
        case 'End':
            if ((isMac && e.metaKey) || (!isMac && e.ctrlKey)) {
                return { alter, direction: 'forward', granularity: 'documentboundary' };
            }
            return { alter, direction: 'forward', granularity: 'lineboundary' };
        default:
            return null;
    }
}

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
        // and manually handle navigation keys that XUL's focus manager intercepts.
        //
        // In Zotero's XUL document, the browser's default action for navigation keys
        // (arrows, Home, End) includes XUL focus navigation that moves focus between
        // chrome elements. We call preventDefault() to block this, then manually
        // handle cursor movement via Selection.modify().
        const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
            e.stopPropagation();

            const nav = getNavigationParams(e);
            if (nav) {
                e.preventDefault();
                const win = (e.target as HTMLElement).ownerDocument?.defaultView;
                const sel = win?.getSelection();
                if (sel) {
                    sel.modify(nav.alter, nav.direction, nav.granularity);
                }
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
