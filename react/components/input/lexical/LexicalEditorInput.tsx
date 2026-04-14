import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isRangeSelection,
    COMMAND_PRIORITY_HIGH,
    KEY_ENTER_COMMAND,
    LexicalEditor,
} from 'lexical';
import { MentionNode } from './MentionNode';
import { SlashCommandNode } from './SlashCommandNode';
import { MentionsPlugin } from './MentionsPlugin';
import { SlashCommandsPlugin } from './SlashCommandsPlugin';

export type LexicalEditorInputHandle = {
    focus: () => void;
    clear: () => void;
};

export interface LexicalEditorInputProps {
    value: string;
    onChange: (text: string) => void;
    onSubmit: () => void;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    /**
     * Callback fired with the contenteditable root element when it mounts /
     * unmounts. Useful for parents that keep an HTMLElement ref around (e.g.
     * to call `.focus()` imperatively from elsewhere).
     */
    onContentEditableRef?: (el: HTMLElement | null) => void;
}

// Exposes a textarea-like focus()/clear() API to the parent via ref so the
// surrounding InputArea can keep its existing imperative usage.
const EditorApi = forwardRef<LexicalEditorInputHandle, { contentEditableRef: React.RefObject<HTMLElement | null> }>(
    function EditorApi({ contentEditableRef }, ref) {
        const [editor] = useLexicalComposerContext();
        useImperativeHandle(
            ref,
            () => ({
                focus: () => {
                    // Prefer the editor's focus() to restore selection state;
                    // fall back to DOM focus if the editor hasn't mounted yet.
                    editor.focus(
                        () => {
                            /* noop */
                        },
                        { defaultSelection: 'rootEnd' },
                    );
                    contentEditableRef.current?.focus();
                },
                clear: () => {
                    editor.update(() => {
                        const root = $getRoot();
                        root.clear();
                        const p = $createParagraphNode();
                        root.append(p);
                        p.select();
                    });
                },
            }),
            [editor, contentEditableRef],
        );
        return null;
    },
);

/**
 * Propagates the editor's plain text to the parent when it changes, and syncs
 * external `value` changes back into the editor when they drift (e.g. parent
 * clears `messageContent` after sending).
 */
const PlainTextSync: React.FC<{
    value: string;
    onChange: (text: string) => void;
}> = ({ value, onChange }) => {
    const [editor] = useLexicalComposerContext();
    // Tracks the last text value we emitted upward to avoid echoes.
    const lastEmitted = useRef<string>('');

    // Sync external value -> editor (e.g. when parent clears after send)
    useEffect(() => {
        if (value === lastEmitted.current) return;
        editor.update(() => {
            const root = $getRoot();
            if (root.getTextContent() === value) return;
            root.clear();
            const p = $createParagraphNode();
            if (value.length > 0) p.append($createTextNode(value));
            root.append(p);
        });
        lastEmitted.current = value;
    }, [editor, value]);

    const handleChange = useCallback(() => {
        editor.getEditorState().read(() => {
            const text = $getRoot().getTextContent();
            if (text === lastEmitted.current) return;
            lastEmitted.current = text;
            onChange(text);
        });
    }, [editor, onChange]);

    return <OnChangePlugin onChange={handleChange} ignoreSelectionChange />;
};

/**
 * Registers a KEY_ENTER handler so the host form can submit on Enter
 * (and newline on Shift+Enter, matching the textarea behavior).
 */
const SubmitOnEnterPlugin: React.FC<{ onSubmit: () => void }> = ({ onSubmit }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        return editor.registerCommand<KeyboardEvent | null>(
            KEY_ENTER_COMMAND,
            (event) => {
                if (!event) return false;
                if (event.shiftKey) return false;
                event.preventDefault();
                onSubmit();
                return true;
            },
            COMMAND_PRIORITY_HIGH,
        );
    }, [editor, onSubmit]);
    return null;
};

// Disables Lexical's default rich formatting shortcuts (bold/italic/underline
// etc) so the editor behaves like a plain textarea - but keeps decorator and
// text-entity nodes, which is what makes rich pills possible.
const editorConfig = {
    namespace: 'beaver-input',
    nodes: [MentionNode, SlashCommandNode],
    // Plain text editors still need a theme object; we leave it empty.
    theme: {},
    onError(error: Error) {
        // eslint-disable-next-line no-console
        console.error('[LexicalEditorInput]', error);
    },
};

export const LexicalEditorInput = forwardRef<LexicalEditorInputHandle, LexicalEditorInputProps>(
    function LexicalEditorInput(
        { value, onChange, onSubmit, placeholder, ariaLabel, disabled = false, onContentEditableRef },
        ref,
    ) {
        // Portal anchor for typeahead menus. Positioned relative to the editor
        // container so the menu follows the caret naturally.
        const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
        const contentEditableRef = useRef<HTMLDivElement | null>(null);

        const handleContentEditableRef = useCallback(
            (el: HTMLDivElement | null) => {
                contentEditableRef.current = el;
                onContentEditableRef?.(el);
            },
            [onContentEditableRef],
        );

        return (
            <LexicalComposer initialConfig={{ ...editorConfig, editable: !disabled }}>
                <div className="beaver-lexical-root" ref={setAnchorElement}>
                    <PlainTextPlugin
                        contentEditable={
                            <ContentEditable
                                ref={handleContentEditableRef}
                                className="chat-input beaver-lexical-content"
                                aria-label={ariaLabel ?? 'Message'}
                                aria-multiline="true"
                                role="textbox"
                                spellCheck={true}
                            />
                        }
                        placeholder={
                            <div
                                className="beaver-lexical-placeholder"
                                aria-hidden="true"
                            >
                                {placeholder}
                            </div>
                        }
                        ErrorBoundary={LexicalErrorBoundary}
                    />
                    <HistoryPlugin />
                    <PlainTextSync value={value} onChange={onChange} />
                    <SubmitOnEnterPlugin onSubmit={onSubmit} />
                    <MentionsPlugin anchorElement={anchorElement} />
                    <SlashCommandsPlugin anchorElement={anchorElement} />
                    <EditorApi ref={ref} contentEditableRef={contentEditableRef} />
                </div>
            </LexicalComposer>
        );
    },
);
