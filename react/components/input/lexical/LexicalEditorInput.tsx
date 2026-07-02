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
    $isLineBreakNode,
    $isRangeSelection,
    $setSelection,
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
import { openPreferencesWindow } from '../../../../src/ui/openPreferencesWindow';

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
                argumentHint: node.getArgumentHint(),
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
                segment.match.argumentHint,
            )
            : $createTextNode(segment.text));
}

/** A raw DOM selection (nodes + offsets), captured to re-assert a
 *  user-placed caret that Lexical has not adopted yet. */
type DomSelectionSnapshot = {
    anchorNode: Node;
    anchorOffset: number;
    focusNode: Node;
    focusOffset: number;
};

/** Snapshot the DOM selection if both of its ends are inside `root`. */
function captureDomSelection(sel: Selection, root: HTMLElement): DomSelectionSnapshot | null {
    const { anchorNode, focusNode } = sel;
    if (!anchorNode || !focusNode) return null;
    if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
    return {
        anchorNode,
        anchorOffset: sel.anchorOffset,
        focusNode,
        focusOffset: sel.focusOffset,
    };
}

/** Flattened plain-text offsets of the live DOM selection within `root`, or
 *  null when the selection is not a text-to-text range inside it. Mirrors
 *  $getFlatSelectionOffsets so the two sides can be compared. */
function getDomFlatSelectionOffsets(root: HTMLElement, sel: Selection): { anchor: number; focus: number } | null {
    const { anchorNode, focusNode } = sel;
    if (!anchorNode || !focusNode) return null;
    if (anchorNode.nodeType !== Node.TEXT_NODE || focusNode.nodeType !== Node.TEXT_NODE) return null;
    if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
    let anchor: number | null = null;
    let focus: number | null = null;
    let running = 0;
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (node === anchorNode) anchor = running + sel.anchorOffset;
        if (node === focusNode) focus = running + sel.focusOffset;
        running += (node as Text).length;
    }
    if (anchor === null || focus === null) return null;
    return { anchor, focus };
}

/** Flattened plain-text offsets of the current selection's anchor and focus
 *  points (offsets are relative to the concatenated text-node content), or
 *  null when there is no range selection or a point sits outside the text
 *  nodes. Must be called inside an editor read/update context. */
function $getFlatSelectionOffsets(): { anchor: number; focus: number } | null {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    const anchorKey = selection.anchor.getNode().getKey();
    const focusKey = selection.focus.getNode().getKey();
    let anchor: number | null = null;
    let focus: number | null = null;
    let runningOffset = 0;
    for (const textNode of $getRoot().getAllTextNodes()) {
        const key = textNode.getKey();
        if (key === anchorKey) anchor = runningOffset + selection.anchor.offset;
        if (key === focusKey) focus = runningOffset + selection.focus.offset;
        runningOffset += textNode.getTextContentSize();
    }
    if (anchor === null || focus === null) return null;
    return { anchor, focus };
}

/** Map a flattened plain-text [start, end] range (start <= end) back onto the
 *  editor's text nodes and select it. Must be called inside an update context. */
function $selectFlatRange(start: number, end: number): void {
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
                    editor.update(
                        () => $selectFlatRange(start, end),
                        options?.skipFocus ? { tag: SKIP_SELECTION_FOCUS_TAG } : undefined,
                    );
                },
                getSelectionOffset: () => {
                    let offset: number | null = null;
                    editor.getEditorState().read(() => {
                        offset = $getFlatSelectionOffsets()?.anchor ?? null;
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
                            descriptor.argumentHint,
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
 * Renders an action's argument hint as greyed-out ghost text after a freshly
 * inserted /command pill ("/summarize-paper |hint…", caret before the hint),
 * mimicking placeholder text for the argument slot.
 *
 * The hint shows while a pill carrying an argumentHint is the last
 * non-whitespace content of the editor's last line, and disappears as soon as
 * the user types an argument (or breaks to a new line). It is rendered purely
 * via a `data-argument-hint` attribute on the pill's paragraph plus a CSS
 * ::after rule, so it is never part of the editor content. Attribute-only DOM
 * writes are safe here: Lexical's reconciler ignores foreign attributes, and
 * attribute mutations don't trigger the chrome document's selection reset
 * (see SelectionGuardPlugin).
 */
const ArgumentHintPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        let decoratedEl: HTMLElement | null = null;
        const apply = () => {
            let hint: string | null = null;
            let paragraphKey: string | null = null;
            editor.getEditorState().read(() => {
                const last = $getRoot().getLastChild();
                if (!$isElementNode(last)) return;
                const children = last.getChildren();
                for (let i = children.length - 1; i >= 0; i--) {
                    const node = children[i];
                    if ($isSlashCommandNode(node)) {
                        hint = node.getArgumentHint() || null;
                        paragraphKey = last.getKey();
                        return;
                    }
                    // A line break or any non-whitespace content after the
                    // pill means the user has moved on — no hint.
                    if ($isLineBreakNode(node) || node.getTextContent().trim().length > 0) return;
                }
            });
            const el = hint && paragraphKey ? editor.getElementByKey(paragraphKey) : null;
            if (decoratedEl && decoratedEl !== el) {
                decoratedEl.removeAttribute('data-argument-hint');
            }
            if (el && hint && el.getAttribute('data-argument-hint') !== hint) {
                el.setAttribute('data-argument-hint', hint);
            }
            decoratedEl = el;
        };
        const unregister = editor.registerUpdateListener(apply);
        apply();
        return () => {
            unregister();
            decoratedEl?.removeAttribute('data-argument-hint');
            decoratedEl = null;
        };
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
const CaretNavigationPlugin: React.FC<{
    suspendedRef: React.MutableRefObject<boolean>;
    pendingDomSelectionRef: React.MutableRefObject<DomSelectionSnapshot | null>;
}> = ({ suspendedRef, pendingDomSelectionRef }) => {
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

            // A caret strictly inside a /command pill's text (not at either
            // edge). Pills are atomic (token-mode nodes), so horizontal moves
            // must not rest mid-pill; the boundary positions are fine - they
            // are visually before/after the pill.
            const isStrictlyInsidePill = (): boolean => {
                const node = sel.focusNode;
                if (!node || node.nodeType !== Node.TEXT_NODE) return false;
                if (!node.parentElement?.closest('.beaver-slash-command')) return false;
                return sel.focusOffset > 0 && sel.focusOffset < (node as Text).length;
            };
            const modify = (dir: string, gran: string) => {
                try {
                    (sel as unknown as { modify: (a: string, d: string, g: string) => void }).modify(alter, dir, gran);
                } catch { /* Selection.modify is best-effort */ }
            };
            // Horizontal movement treats /command pills as atomic: after the
            // native step, keep stepping in the same direction until the
            // moving edge exits the pill, or no progress is possible
            // (document boundary). Only used for ArrowLeft/Right - a vertical
            // move landing mid-pill must not be pushed a whole extra line.
            const modifySkippingPills = (dir: string, gran: string) => {
                modify(dir, gran);
                let guard = 0;
                while (isStrictlyInsidePill() && guard++ < 64) {
                    const prevNode = sel.focusNode;
                    const prevOffset = sel.focusOffset;
                    modify(dir, gran);
                    if (sel.focusNode === prevNode && sel.focusOffset === prevOffset) break;
                }
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
                    if (isMac && e.metaKey) modifySkippingPills(fwd ? 'forward' : 'backward', 'lineboundary');
                    else if ((isMac && e.altKey) || (!isMac && e.ctrlKey)) modifySkippingPills(fwd ? 'right' : 'left', 'word');
                    else modifySkippingPills(fwd ? 'right' : 'left', 'character');
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
            // Lexical only adopts this native caret move on the next (async)
            // selectionchange. Snapshot it so SelectionGuardPlugin re-asserts
            // THIS position - not the stale editor-state one - if a document
            // mutation clobbers the selection in the meantime.
            pendingDomSelectionRef.current = captureDomSelection(sel, root);
            e.preventDefault();
        };

        return editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) prevRootElement.removeEventListener('keydown', handler, true);
            if (rootElement) rootElement.addEventListener('keydown', handler, true);
        });
    }, [editor, suspendedRef, pendingDomSelectionRef]);
    return null;
};

/**
 * Guards the caret against Zotero's chrome-document selection resets.
 *
 * In Zotero's main window (a chrome document), any childList or characterData
 * DOM mutation ANYWHERE in the document synchronously resets the document
 * selection's offsets to 0 (the anchor/focus nodes are kept; attribute/style
 * mutations are harmless). Ordinary web documents preserve the selection;
 * Zotero's own note editor avoids the issue by living in an iframe with its
 * own document, but Beaver's editor sits directly in the chrome document. So
 * a tooltip mounting, a menu re-rendering while the user types, or streaming
 * output re-rendering the thread all clobber the caret - Lexical then adopts
 * the collapsed selection on the next selectionchange and the caret visibly
 * jumps to the start.
 *
 * The repair runs in a MutationObserver callback: observer callbacks are
 * microtasks, so they fire after the mutation but BEFORE the queued
 * selectionchange task - restoring here means Lexical never sees the bogus
 * selection at all.
 *
 * Restore target, in priority order:
 * 1. A pending user-placed DOM selection (mouse release / caret-nav key) that
 *    Lexical has not adopted yet - re-asserted verbatim. Cleared on the next
 *    selectionchange (which runs after Lexical's own listener has adopted it).
 * 2. The editor state's selection, re-applied through the reconciler when the
 *    live DOM selection no longer matches it.
 *
 * Skipped while: the mutation batch touches the editor's own subtree (the
 * reconciler manages those), a pointer is down (don't fight an in-progress
 * click/drag), IME composition is active, or the editor is not the active
 * element (re-asserting a DOM selection while a menu input has focus would
 * trigger the XUL focus manager's selection-based focus theft).
 */
const SelectionGuardPlugin: React.FC<{
    pendingDomSelectionRef: React.MutableRefObject<DomSelectionSnapshot | null>;
}> = ({ pendingDomSelectionRef }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        let pointerDown = false;

        const setup = (root: HTMLElement): (() => void) => {
            const doc = root.ownerDocument;
            const win = doc.defaultView;
            if (!win) return () => {};

            const onPointerDown = () => {
                pointerDown = true;
            };
            const onPointerUp = () => {
                pointerDown = false;
                const sel = win.getSelection();
                pendingDomSelectionRef.current = sel ? captureDomSelection(sel, root) : null;
            };
            // Runs after Lexical's own selectionchange listener (registered at
            // editor creation, so earlier), i.e. once Lexical has adopted the
            // current DOM selection and the snapshot is no longer needed.
            const onSelectionChange = () => {
                pendingDomSelectionRef.current = null;
            };

            const onMutations = (records: MutationRecord[]) => {
                for (const record of records) {
                    // Editor-internal (or mixed) batch: Lexical's reconciler
                    // sets the selection itself after its own mutations.
                    if (root.contains(record.target)) return;
                }
                if (pointerDown) return;
                if (editor.isComposing()) return;
                if (doc.activeElement !== root) return;
                const sel = win.getSelection();
                if (!sel) return;

                const pending = pendingDomSelectionRef.current;
                if (pending && root.contains(pending.anchorNode) && root.contains(pending.focusNode)) {
                    const unchanged =
                        sel.anchorNode === pending.anchorNode &&
                        sel.anchorOffset === pending.anchorOffset &&
                        sel.focusNode === pending.focusNode &&
                        sel.focusOffset === pending.focusOffset;
                    if (!unchanged) {
                        try {
                            sel.setBaseAndExtent(
                                pending.anchorNode,
                                pending.anchorOffset,
                                pending.focusNode,
                                pending.focusOffset,
                            );
                        } catch { /* nodes may have become unresolvable */ }
                    }
                    return;
                }

                const live = getDomFlatSelectionOffsets(root, sel);
                if (!live) return;
                let state: { anchor: number; focus: number } | null = null;
                editor.getEditorState().read(() => {
                    state = $getFlatSelectionOffsets();
                });
                if (!state) return;
                const stateOffsets = state as { anchor: number; focus: number };
                if (live.anchor === stateOffsets.anchor && live.focus === stateOffsets.focus) return;
                // Discrete update: the reconciler re-applies the state
                // selection to the DOM synchronously, still ahead of the
                // queued selectionchange task.
                editor.update(() => {
                    const s = $getSelection();
                    if ($isRangeSelection(s)) {
                        const clone = s.clone();
                        clone.dirty = true;
                        $setSelection(clone);
                    }
                }, { discrete: true });
            };

            const observer = new (win as typeof globalThis & Window).MutationObserver(onMutations);
            observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
            doc.addEventListener('pointerdown', onPointerDown, true);
            doc.addEventListener('pointerup', onPointerUp, true);
            doc.addEventListener('selectionchange', onSelectionChange);
            return () => {
                observer.disconnect();
                doc.removeEventListener('pointerdown', onPointerDown, true);
                doc.removeEventListener('pointerup', onPointerUp, true);
                doc.removeEventListener('selectionchange', onSelectionChange);
            };
        };

        let cleanupDom: (() => void) | null = null;
        const unregister = editor.registerRootListener((rootElement) => {
            cleanupDom?.();
            cleanupDom = rootElement ? setup(rootElement) : null;
        });
        return () => {
            unregister();
            cleanupDom?.();
            cleanupDom = null;
        };
    }, [editor, pendingDomSelectionRef]);
    return null;
};

/**
 * Preserves the caret position across OS-level window deactivation.
 *
 * When the chrome window loses OS focus, Gecko can collapse the native
 * selection to the start of the contenteditable; Lexical's document-level
 * selectionchange listener then adopts that collapsed selection, so the caret
 * sits at offset 0 when the window is refocused. The editor element never
 * loses *document* focus in this scenario (document.activeElement is
 * unchanged), so element-level blur/focus can't observe it - we listen on the
 * window instead. The snapshot/restore only runs while the editor is the
 * active element, so focus legitimately parked elsewhere (e.g. a menu's
 * search input) is never clobbered.
 */
const SelectionPersistencePlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        let saved: { anchor: number; focus: number } | null = null;
        let rootEl: HTMLElement | null = null;
        const isEditorActive = () =>
            !!rootEl && rootEl.ownerDocument.activeElement === rootEl;

        const onWindowBlur = (e: FocusEvent) => {
            // Only window deactivation - element-level blurs don't bubble to
            // the window, but be defensive about synthesized events.
            if (e.target !== e.currentTarget) return;
            if (!isEditorActive()) return;
            editor.getEditorState().read(() => {
                saved = $getFlatSelectionOffsets();
            });
        };
        const onWindowFocus = (e: FocusEvent) => {
            if (e.target !== e.currentTarget) return;
            const restore = saved;
            saved = null;
            if (!restore || !isEditorActive()) return;
            // Selection direction is not preserved; restore the range
            // forward-ordered (collapsed carets are unaffected).
            const start = Math.min(restore.anchor, restore.focus);
            const end = Math.max(restore.anchor, restore.focus);
            editor.update(() => $selectFlatRange(start, end));
        };

        return editor.registerRootListener((rootElement, prevRootElement) => {
            const prevWin = prevRootElement?.ownerDocument.defaultView;
            if (prevWin) {
                prevWin.removeEventListener('blur', onWindowBlur);
                prevWin.removeEventListener('focus', onWindowFocus);
            }
            rootEl = rootElement;
            const win = rootElement?.ownerDocument.defaultView;
            if (win) {
                win.addEventListener('blur', onWindowBlur);
                win.addEventListener('focus', onWindowFocus);
            }
        });
    }, [editor]);
    return null;
};

/**
 * Opens the preferences window (Actions tab) with the clicked /command pill's
 * action revealed in edit mode. The pill's DOM carries the action id via the
 * data-action-id attribute (see SlashCommandNode.createDOM).
 */
const SlashCommandClickPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            const target = e.target as Element | null;
            const pill = target?.closest?.('.beaver-slash-command');
            if (!pill) return;
            const actionId = pill.getAttribute('data-action-id');
            if (!actionId) return;
            openPreferencesWindow('actions', undefined, actionId);
        };
        return editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) prevRootElement.removeEventListener('click', handler);
            if (rootElement) rootElement.addEventListener('click', handler);
        });
    }, [editor]);
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

        // A user-placed DOM selection Lexical hasn't adopted yet, shared between
        // CaretNavigationPlugin (writes after nav-key moves) and
        // SelectionGuardPlugin (writes on pointer-up, clears on selectionchange,
        // reads when repairing chrome-document selection resets).
        const pendingDomSelectionRef = useRef<DomSelectionSnapshot | null>(null);

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
                    <ArgumentHintPlugin />
                    <CaretNavigationPlugin suspendedRef={suspendNavRef} pendingDomSelectionRef={pendingDomSelectionRef} />
                    <SelectionGuardPlugin pendingDomSelectionRef={pendingDomSelectionRef} />
                    <SelectionPersistencePlugin />
                    <SlashCommandClickPlugin />
                    <SubmitOnEnterPlugin onSubmit={onSubmit} />
                    <EditorApi ref={ref} />
                </div>
            </LexicalComposer>
        );
    },
);
