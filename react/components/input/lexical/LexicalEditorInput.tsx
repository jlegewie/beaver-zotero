import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
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
    SKIP_SELECTION_FOCUS_TAG,
} from 'lexical';

export type LexicalEditorInputHandle = {
    focus: () => void;
    clear: () => void;
    setText: (text: string, caretOffset?: number) => void;
    selectRange: (start: number, end: number, options?: { skipFocus?: boolean }) => void;
    getSelectionOffset: () => number | null;
};

export interface LexicalEditorInputProps {
    value: string;
    onChange: (text: string) => void;
    onSubmit: () => void;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    /**
     * Callback fired with the contenteditable root element when it mounts /
     * unmounts. Useful for parents that keep an HTMLElement ref around (e.g.
     * to call `.focus()` imperatively from elsewhere).
     */
    onContentEditableRef?: (el: HTMLElement | null) => void;
}

// Exposes a textarea-like focus()/clear() API to the parent via ref so the
// surrounding InputArea can keep its existing imperative usage.
const EditorApi = forwardRef<LexicalEditorInputHandle>(
    function EditorApi(_props, ref) {
        const [editor] = useLexicalComposerContext();
        const setPlainText = useCallback((text: string, selectionStart = text.length, selectionEnd = selectionStart) => {
            editor.update(() => {
                const root = $getRoot();
                root.clear();
                const p = $createParagraphNode();
                const textNode = $createTextNode(text);
                if (text.length > 0) {
                    p.append(textNode);
                }
                root.append(p);
                const safeStart = Math.max(0, Math.min(selectionStart, text.length));
                const safeEnd = Math.max(0, Math.min(selectionEnd, text.length));
                if (text.length > 0) {
                    textNode.select(safeStart, safeEnd);
                } else {
                    p.select();
                }
            });
        }, [editor]);

        useImperativeHandle(
            ref,
            () => ({
                focus: () => {
                    editor.focus(
                        () => {
                            /* noop */
                        },
                        { defaultSelection: 'rootEnd' },
                    );
                },
                clear: () => {
                    setPlainText('', 0);
                },
                setText: (text, caretOffset = text.length) => {
                    setPlainText(text, caretOffset);
                },
                selectRange: (start, end, options) => {
                    editor.update(() => {
                        const root = $getRoot();
                        const textLength = root.getTextContent().length;
                        const safeStart = Math.max(0, Math.min(start, textLength));
                        const safeEnd = Math.max(0, Math.min(end, textLength));
                        const textNodes = root.getAllTextNodes();
                        if (textNodes.length === 0) {
                            root.selectEnd();
                            return;
                        }

                        let startNode = textNodes[0];
                        let endNode = textNodes[textNodes.length - 1];
                        let startOffset = 0;
                        let endOffset = endNode.getTextContentSize();
                        let runningOffset = 0;

                        for (const textNode of textNodes) {
                            const nodeLength = textNode.getTextContentSize();
                            const nodeStart = runningOffset;
                            const nodeEnd = nodeStart + nodeLength;
                            if (safeStart >= nodeStart && safeStart <= nodeEnd) {
                                startNode = textNode;
                                startOffset = safeStart - nodeStart;
                            }
                            if (safeEnd >= nodeStart && safeEnd <= nodeEnd) {
                                endNode = textNode;
                                endOffset = safeEnd - nodeStart;
                                break;
                            }
                            runningOffset = nodeEnd;
                        }

                        startNode.select(startOffset, startOffset);
                        const selection = $getSelection();
                        if ($isRangeSelection(selection)) {
                            selection.focus.set(endNode.getKey(), endOffset, 'text');
                        }
                    }, options?.skipFocus ? { tag: SKIP_SELECTION_FOCUS_TAG } : undefined);
                },
                getSelectionOffset: () => {
                    let offset: number | null = null;
                    editor.getEditorState().read(() => {
                        const selection = $getSelection();
                        if (!$isRangeSelection(selection)) return;
                        const anchorNode = selection.anchor.getNode();
                        let runningOffset = 0;
                        for (const textNode of $getRoot().getAllTextNodes()) {
                            if (textNode.getKey() === anchorNode.getKey()) {
                                offset = runningOffset + selection.anchor.offset;
                                return;
                            }
                            runningOffset += textNode.getTextContentSize();
                        }
                    });
                    return offset;
                },
            }),
            [editor, setPlainText],
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
        let text = '';
        editor.getEditorState().read(() => {
            text = $getRoot().getTextContent();
        });
        if (text === lastEmitted.current) return;
        lastEmitted.current = text;
        onChange(text);
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

// Keep the composer configured as a plain-text editor. Menu orchestration stays
// in InputArea so the source and slash menus share the same behavior as the
// rest of the app.
const editorConfig = {
    namespace: 'beaver-input',
    nodes: [],
    // Plain text editors still need a theme object; we leave it empty.
    theme: {},
    onError(error: Error) {
        // eslint-disable-next-line no-console
        console.error('[LexicalEditorInput]', error);
    },
};

export const LexicalEditorInput = forwardRef<LexicalEditorInputHandle, LexicalEditorInputProps>(
    function LexicalEditorInput(
        { value, onChange, onSubmit, placeholder, ariaLabel, disabled = false, onKeyDown, onContentEditableRef },
        ref,
    ) {
        const contentEditableRef = useRef<HTMLDivElement | null>(null);

        // The ContentEditable ref callback MUST keep a stable identity across
        // renders. Lexical memoizes its root-element ref on this callback, so a
        // changing identity makes it re-run editor.setRootElement() on every
        // render; that re-reads the DOM selection (collapsed at offset 0) back
        // into the editor, pinning the caret to the start and freezing input.
        // We stash the latest onContentEditableRef in a ref so the callback can
        // stay stable while still forwarding to the most recent prop.
        const onContentEditableRefCb = useRef(onContentEditableRef);
        onContentEditableRefCb.current = onContentEditableRef;

        const handleContentEditableRef = useCallback(
            (el: HTMLDivElement | null) => {
                contentEditableRef.current = el;
                onContentEditableRefCb.current?.(el);
            },
            [],
        );

        return (
            <LexicalComposer initialConfig={{ ...editorConfig, editable: !disabled }}>
                <div className="beaver-lexical-root">
                    {/* Scroll host carries the height cap and textarea-like scrolling. */}
                    <div className="beaver-lexical-scroll">
                        <PlainTextPlugin
                            contentEditable={
                                <ContentEditable
                                    ref={handleContentEditableRef}
                                    className="chat-input beaver-lexical-content"
                                    aria-label={ariaLabel ?? 'Message'}
                                    aria-multiline="true"
                                    role="textbox"
                                    spellCheck={true}
                                    onKeyDown={onKeyDown}
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
                    </div>
                    <HistoryPlugin />
                    <PlainTextSync value={value} onChange={onChange} />
                    <SubmitOnEnterPlugin onSubmit={onSubmit} />
                    <EditorApi ref={ref} />
                </div>
            </LexicalComposer>
        );
    },
);
