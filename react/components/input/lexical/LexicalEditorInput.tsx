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
    $isElementNode,
    $isRangeSelection,
    COMMAND_PRIORITY_HIGH,
    KEY_ENTER_COMMAND,
    LexicalNode,
    SKIP_SELECTION_FOCUS_TAG,
} from 'lexical';
import {
    $createSlashCommandNode,
    $isSlashCommandNode,
    SlashCommandNode,
} from './SlashCommandNode';

import {
    splitContentByCommandTokens,
    slashDescriptorsEqual,
    type SlashCommandDescriptor,
} from '../../../utils/slashCommands';

export type { SlashCommandDescriptor };

/** Collect the /command pills in the current editor state, in document order.
 *  Must be called inside an editor read/update context. */
function $collectSlashCommandDescriptors(): SlashCommandDescriptor[] {
    const result: SlashCommandDescriptor[] = [];
    const visit = (node: LexicalNode) => {
        if ($isSlashCommandNode(node)) {
            result.push({
                commandName: node.getCommandName(),
                actionId: node.getActionId(),
                targetType: node.getTargetType(),
                title: node.getTitle(),
            });
        } else if ($isElementNode(node)) {
            node.getChildren().forEach(visit);
        }
    };
    $getRoot().getChildren().forEach(visit);
    return result;
}

/** Build editor nodes for `text`, materializing known `/command` tokens as
 *  pill nodes (used when syncing the shared content string into this editor —
 *  the pill identity travels via the shared pill descriptors, so pills stay
 *  real in every mounted editor). Must be called inside an update context. */
function $buildContentNodes(text: string, pills: SlashCommandDescriptor[]): LexicalNode[] {
    return splitContentByCommandTokens(text, pills, p => p.commandName)
        .filter(segment => segment.text.length > 0)
        .map(segment => segment.match
            ? $createSlashCommandNode(
                segment.match.commandName,
                segment.match.actionId,
                segment.match.targetType,
                segment.match.title,
            )
            : $createTextNode(segment.text));
}

export type LexicalEditorInputHandle = {
    focus: () => void;
    clear: () => void;
    setText: (text: string, caretOffset?: number) => void;
    /** Delete the last character of the editor content in place (no full
     *  rebuild), leaving the caret at the end. Used to strip the `@` that opens
     *  the attachment menu without flattening colored command nodes. */
    deleteTrailingCharacter: () => void;
    selectRange: (start: number, end: number, options?: { skipFocus?: boolean }) => void;
    getSelectionOffset: () => number | null;
    /** Insert a styled command pill followed by a space, caret left at the
     *  end. With a numeric `queryLength`, the trailing `/query` (length
     *  `queryLength`, excluding the `/`) the user typed is replaced by the
     *  pill (slash-menu flow). With `null`, nothing is removed and the pill is
     *  appended after the existing content (programmatic staging flow). */
    insertSlashCommand: (descriptor: SlashCommandDescriptor, queryLength: number | null) => void;
    /** Returns the command pills currently in the editor, in document order. */
    getSlashCommands: () => SlashCommandDescriptor[];
};

export interface LexicalEditorInputProps {
    value: string;
    onChange: (text: string) => void;
    /**
     * Shared /command pill descriptors for the message (in document order).
     * Used to rebuild real pill nodes when syncing an external `value` into
     * this editor; `onPillsChange` reports this editor's pills after local
     * edits. Together they keep pills consistent across multiple mounted
     * editors (main-window sidebar + separate Beaver window).
     */
    pills?: SlashCommandDescriptor[];
    onPillsChange?: (pills: SlashCommandDescriptor[]) => void;
    onSubmit: () => void;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    /**
     * When true, the built-in caret-navigation handling is suspended so an open
     * menu (slash / attachment) can own the arrow keys. See CaretNavigationPlugin.
     */
    suspendKeyboardNavigation?: boolean;
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
                deleteTrailingCharacter: () => {
                    editor.update(() => {
                        const root = $getRoot();
                        const textNodes = root.getAllTextNodes();
                        const last = textNodes[textNodes.length - 1];
                        if (!last) return;
                        const text = last.getTextContent();
                        if (text.length <= 1) {
                            last.remove();
                        } else {
                            last.setTextContent(text.slice(0, -1));
                        }
                        root.selectEnd();
                    });
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
                insertSlashCommand: (descriptor, queryLength) => {
                    editor.update(() => {
                        const root = $getRoot();
                        if (queryLength !== null) {
                            // Remove the trailing "/query" the user typed (the `/`
                            // trigger plus the typed query). The slash menu closes on
                            // whitespace, so the query never spans nodes and always
                            // lives in the final plain-text node(s) - never inside an
                            // existing pill.
                            let remaining = queryLength + 1; // +1 for the leading '/'
                            const textNodes = root.getAllTextNodes();
                            for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i--) {
                                const node = textNodes[i];
                                if ($isSlashCommandNode(node)) break;
                                const text = node.getTextContent();
                                if (text.length <= remaining) {
                                    remaining -= text.length;
                                    node.remove();
                                } else {
                                    node.setTextContent(text.slice(0, text.length - remaining));
                                    remaining = 0;
                                }
                            }
                        }

                        // Resolve token collisions against pills already in the
                        // editor: two different actions whose titles collapse to
                        // the same token get a numeric suffix, so the visible
                        // token (and the wire `command` derived from it) stays
                        // unambiguous. Repeated pills of the SAME action keep
                        // the same token (deduped at send).
                        const existingPills = $collectSlashCommandDescriptors();
                        let commandName = descriptor.commandName;
                        let suffix = 2;
                        while (existingPills.some(p =>
                            p.commandName === commandName && p.actionId !== descriptor.actionId
                        )) {
                            commandName = `${descriptor.commandName}-${suffix++}`;
                        }

                        // Separate the pill from preceding text when appending
                        // programmatically (the slash-menu flow already ends at
                        // the typed-`/` position, which follows whitespace).
                        const needsLeadingSpace = queryLength === null
                            && root.getTextContent().length > 0
                            && !/\s$/.test(root.getTextContent());

                        // Append the pill + a trailing space so the caret can
                        // continue typing after it.
                        const slashNode = $createSlashCommandNode(
                            commandName,
                            descriptor.actionId,
                            descriptor.targetType,
                            descriptor.title,
                        );
                        const spaceNode = $createTextNode(' ');
                        const lastChild = root.getLastChild();
                        const paragraph = $isElementNode(lastChild)
                            ? lastChild
                            : $createParagraphNode();
                        if (!$isElementNode(lastChild)) {
                            root.append(paragraph);
                        }
                        if (needsLeadingSpace) {
                            paragraph.append($createTextNode(' '));
                        }
                        paragraph.append(slashNode);
                        slashNode.insertAfter(spaceNode);
                        spaceNode.selectEnd();
                    });
                    // Re-focus (the selection may have been lost to the menu on a
                    // mouse click) and land the caret at the end, right after the
                    // inserted pill + space.
                    editor.focus(() => { /* noop */ }, { defaultSelection: 'rootEnd' });
                },
                getSlashCommands: () => {
                    let result: SlashCommandDescriptor[] = [];
                    editor.getEditorState().read(() => {
                        result = $collectSlashCommandDescriptors();
                    });
                    return result;
                },
            }),
            [editor, setPlainText],
        );
        return null;
    },
);

/**
 * Propagates the editor's plain text (and its /command pills) to the parent
 * when it changes, and syncs external `value` changes back into the editor
 * when they drift (e.g. parent clears `messageContent` after sending, or
 * another mounted editor — main sidebar vs separate Beaver window — edited
 * the shared content).
 *
 * On external rebuilds, known `/command` tokens are materialized as real pill
 * nodes from the shared `pills` descriptors, so a pill staged in one editor
 * renders (and submits) as a pill in every other mounted editor.
 */
const PlainTextSync: React.FC<{
    value: string;
    onChange: (text: string) => void;
    pills?: SlashCommandDescriptor[];
    onPillsChange?: (pills: SlashCommandDescriptor[]) => void;
}> = ({ value, onChange, pills, onPillsChange }) => {
    const [editor] = useLexicalComposerContext();
    // Tracks the last values we emitted upward to avoid echoes.
    const lastEmitted = useRef<string>('');
    const lastEmittedPills = useRef<SlashCommandDescriptor[] | null>(null);

    // Latest shared pill descriptors, readable from the value-sync effect
    // without retriggering it on descriptor identity churn. Assigned in
    // render so the sync effect below always sees the same-commit value.
    const pillsRef = useRef<SlashCommandDescriptor[]>([]);
    pillsRef.current = pills ?? [];

    // Sync external value -> editor (e.g. when parent clears after send)
    useEffect(() => {
        if (value === lastEmitted.current) return;
        editor.update(() => {
            const root = $getRoot();
            if (root.getTextContent() === value) return;
            root.clear();
            const p = $createParagraphNode();
            $buildContentNodes(value, pillsRef.current).forEach(node => p.append(node));
            root.append(p);
        });
        lastEmitted.current = value;
    }, [editor, value]);

    const handleChange = useCallback(() => {
        let text = '';
        let currentPills: SlashCommandDescriptor[] = [];
        editor.getEditorState().read(() => {
            text = $getRoot().getTextContent();
            currentPills = $collectSlashCommandDescriptors();
        });
        // Pills can only change together with the text (they ARE text), so a
        // single text-echo guard covers both emissions.
        if (text === lastEmitted.current) return;
        lastEmitted.current = text;
        onChange(text);
        if (onPillsChange && (
            lastEmittedPills.current === null ||
            !slashDescriptorsEqual(currentPills, lastEmittedPills.current)
        )) {
            lastEmittedPills.current = currentPills;
            onPillsChange(currentPills);
        }
    }, [editor, onChange, onPillsChange]);

    return <OnChangePlugin onChange={handleChange} ignoreSelectionChange />;
};

/**
 * Reverts a SlashCommandNode back to plain text once the user edits its interior
 * so it no longer reads "/<commandName>" - the moment a command is edited, it
 * loses its color (like a hashtag losing its `#`).
 *
 * This is a one-way transform on purpose: we never auto-color arbitrary typed
 * "/text" (commands are only ever created via the slash menu, which supplies the
 * exact actionId/targetType/title), we only strip color on edit. Because the
 * replacement is a plain TextNode and no TextNode transform is registered, there
 * is no recursion.
 */
const SlashCommandRevertPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        return editor.registerNodeTransform(SlashCommandNode, (node) => {
            const text = node.getTextContent();
            if (text === `/${node.getCommandName()}`) return; // unchanged - keep colored

            // Don't rip the node out mid-IME-composition.
            if (editor.isComposing()) return;

            // LexicalNode.replace() snaps the selection to the END of the new
            // node, so capture any caret offsets pointing into this node first
            // and restore them afterward (identical text length keeps them valid).
            const selection = $getSelection();
            let anchorOffset: number | null = null;
            let focusOffset: number | null = null;
            if ($isRangeSelection(selection)) {
                if (selection.anchor.key === node.getKey()) anchorOffset = selection.anchor.offset;
                if (selection.focus.key === node.getKey()) focusOffset = selection.focus.offset;
            }

            const plain = $createTextNode(text);
            plain.setFormat(node.getFormat());
            plain.setDetail(node.getDetail());
            const newNode = node.replace(plain);

            if (anchorOffset !== null || focusOffset !== null) {
                const sel = $getSelection();
                if ($isRangeSelection(sel)) {
                    if (anchorOffset !== null) sel.anchor.set(newNode.getKey(), anchorOffset, 'text');
                    if (focusOffset !== null) sel.focus.set(newNode.getKey(), focusOffset, 'text');
                }
            }
        });
    }, [editor]);
    return null;
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

/**
 * Caret navigation for the contenteditable.
 *
 * Beaver's editor lives directly in Zotero's chrome (XUL) document, where the
 * native focus manager treats un-consumed navigation keys (arrows / Home / End /
 * Page) as *focus movement* and pulls focus out of the editor. We therefore
 * consume every caret-navigation key here (preventDefault stops the focus
 * theft) and move the caret ourselves via the Selection API; Lexical
 * then syncs its model from the resulting selectionchange.
 *
 * Mappings follow the host platform: on macOS Cmd = line/document boundary and
 * Option = word / line-boundary walk; elsewhere Ctrl = word and Home/End =
 * line/document boundary. Vertical document-boundary and paragraph movement is
 * done by hand because Gecko's Selection.modify() silently ignores the
 * 'documentboundary' and 'paragraph' granularities.
 */
const CaretNavigationPlugin: React.FC<{ suspendedRef: React.MutableRefObject<boolean> }> = ({ suspendedRef }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // While a menu (slash / attachment) is open, let it own the keys.
            if (suspendedRef.current) return;
            const key = e.key;
            const isNavKey =
                key === 'ArrowLeft' || key === 'ArrowRight' ||
                key === 'ArrowUp' || key === 'ArrowDown' ||
                key === 'Home' || key === 'End' ||
                key === 'PageUp' || key === 'PageDown';
            if (!isNavKey) return;

            const root = e.currentTarget as HTMLElement;
            const win = root.ownerDocument.defaultView;
            if (!win) return;
            const sel = win.getSelection();
            if (!sel) return;

            const isMac = Zotero.isMac;
            const shift = e.shiftKey;
            const alter = shift ? 'extend' : 'move';

            const modify = (dir: string, gran: string) => {
                try {
                    (sel as unknown as { modify: (a: string, d: string, g: string) => void }).modify(alter, dir, gran);
                } catch { /* Selection.modify is best-effort */ }
            };
            // Jump to the very start/end of the editable content - used for the
            // document-boundary moves Gecko's Selection.modify() can't perform.
            const docEdge = (forward: boolean) => {
                const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                let first: Text | null = null;
                let last: Text | null = null;
                let cur: Node | null;
                while ((cur = walker.nextNode())) {
                    if (!first) first = cur as Text;
                    last = cur as Text;
                }
                let node: Node = root;
                let offset = forward ? root.childNodes.length : 0;
                if (forward && last) { node = last; offset = last.length; }
                else if (!forward && first) { node = first; offset = 0; }
                try {
                    if (shift) sel.extend(node, offset);
                    else sel.collapse(node, offset);
                } catch { /* boundary point may be unresolvable in an empty editor */ }
            };
            // Walk line boundaries: to this line's boundary, or - if already
            // there - one line up/down and to that line's boundary.
            const lineWalk = (forward: boolean) => {
                const vdir = forward ? 'forward' : 'backward';
                const bn = sel.focusNode;
                const bo = sel.focusOffset;
                modify(vdir, 'lineboundary');
                if (sel.focusNode === bn && sel.focusOffset === bo) {
                    modify(vdir, 'line');
                    modify(vdir, 'lineboundary');
                }
            };

            switch (key) {
                case 'ArrowLeft':
                case 'ArrowRight': {
                    const fwd = key === 'ArrowRight';
                    if (isMac && e.metaKey) modify(fwd ? 'forward' : 'backward', 'lineboundary');
                    else if ((isMac && e.altKey) || (!isMac && e.ctrlKey)) modify(fwd ? 'right' : 'left', 'word');
                    else modify(fwd ? 'right' : 'left', 'character');
                    break;
                }
                case 'ArrowUp':
                case 'ArrowDown': {
                    const fwd = key === 'ArrowDown';
                    if (isMac && e.metaKey) docEdge(fwd);
                    else if (isMac && e.altKey) lineWalk(fwd);
                    else modify(fwd ? 'forward' : 'backward', 'line');
                    break;
                }
                case 'Home':
                    if (isMac || e.ctrlKey) docEdge(false);
                    else modify('backward', 'lineboundary');
                    break;
                case 'End':
                    if (isMac || e.ctrlKey) docEdge(true);
                    else modify('forward', 'lineboundary');
                    break;
                case 'PageUp':
                    docEdge(false);
                    break;
                case 'PageDown':
                    docEdge(true);
                    break;
            }
            e.preventDefault();
        };

        return editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) prevRootElement.removeEventListener('keydown', handler, true);
            if (rootElement) rootElement.addEventListener('keydown', handler, true);
        });
    }, [editor, suspendedRef]);
    return null;
};

// Keep the composer configured as a plain-text editor. Menu orchestration stays
// in InputArea so the source and slash menus share the same behavior as the
// rest of the app.
const editorConfig = {
    namespace: 'beaver-input',
    nodes: [SlashCommandNode],
    // Plain text editors still need a theme object; we leave it empty.
    theme: {},
    onError(error: Error) {
        // eslint-disable-next-line no-console
        console.error('[LexicalEditorInput]', error);
    },
};

export const LexicalEditorInput = forwardRef<LexicalEditorInputHandle, LexicalEditorInputProps>(
    function LexicalEditorInput(
        { value, onChange, pills, onPillsChange, onSubmit, placeholder, ariaLabel, disabled = false, onKeyDown, suspendKeyboardNavigation = false, onContentEditableRef },
        ref,
    ) {
        const contentEditableRef = useRef<HTMLDivElement | null>(null);

        // Mirror the latest suspend flag into a ref so CaretNavigationPlugin can
        // read it without re-registering its keydown listener on every change.
        const suspendNavRef = useRef(false);
        suspendNavRef.current = suspendKeyboardNavigation;

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
                    <PlainTextSync value={value} onChange={onChange} pills={pills} onPillsChange={onPillsChange} />
                    <SlashCommandRevertPlugin />
                    <CaretNavigationPlugin suspendedRef={suspendNavRef} />
                    <SubmitOnEnterPlugin onSubmit={onSubmit} />
                    <EditorApi ref={ref} />
                </div>
            </LexicalComposer>
        );
    },
);
