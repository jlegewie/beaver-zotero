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
    BEFORE_INPUT_COMMAND,
    COMMAND_PRIORITY_HIGH,
    COMMAND_PRIORITY_LOW,
    CONTROLLED_TEXT_INSERTION_COMMAND,
    KEY_ENTER_COMMAND,
    LexicalNode,
    PASTE_COMMAND,
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
import { isImeKeyEvent } from '../../../utils/ime';
import { getHost } from '@beaver/agent-ui/host';
import { getPref } from '../../../../src/utils/prefs';
import {
    createCompositionGatedEmitter,
    createImeCompositionTracker,
    registerCompositionEndDeferral,
    registerImeTrace,
    type ImeCompositionTracker,
} from './imeComposition';
import { collapsesToRangeEnd } from './caretNavigation';
import { SlashCommandHoverCardPlugin } from './SlashCommandHoverCardPlugin';
import {
    $getFlatSelectionOffsets,
    $selectFlatRange,
    $selectFlatSelection,
    type LexicalSelectionOffsets,
} from './selectionOffsets';

export type { SlashCommandDescriptor };

/**
 * How often a pending caret repair or restore re-checks whether the IME has
 * finished. Writing the selection with an input method open discards composed
 * text, so these paths wait for it rather than acting or dropping the work.
 */
const IME_REPAIR_RETRY_MS = 60;

/**
 * How many times a repair tied to one text update is postponed before giving
 * up. Bounded because a still-composing IME produces further updates, each of
 * which schedules a fresh repair (unlike the blur/focus restore, which has no
 * later trigger and therefore waits for the IME itself).
 */
const IME_REPAIR_RETRIES = 5;

/**
 * How long a caret restore may wait for an IME to finish before being dropped.
 * Unlike the composition state itself — which is never expired on a timer,
 * because that risks discarding composed text — giving up on a restore only
 * costs the caret position, so a generous bound keeps a pending timer from
 * outliving any plausible composition.
 */
const IME_RESTORE_MAX_WAIT_MS = 30_000;

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
                missing: node.isMissingAction() || undefined,
                persisted: node.isPersisted() || undefined,
            });
        } else if ($isElementNode(node)) {
            node.getChildren().forEach(visit);
        }
    };
    $getRoot().getChildren().forEach(visit);
    return result;
}

/** Remove the trailing `/query` the user typed (the `/` trigger plus the typed
 *  query) by character count from the end of the document. The slash menu
 *  closes on whitespace, so the query never spans nodes and always lives in the
 *  final plain-text node(s) — never inside an existing pill. Must be called
 *  inside an update context, while that text is still the tail of the document. */
function $deleteTrailingSlashQuery(queryLength: number): void {
    let remaining = queryLength + 1; // +1 for the leading '/'
    const textNodes = $getRoot().getAllTextNodes();
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
                segment.match.missing,
                segment.match.persisted,
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

/** Client rect of the selection's moving edge (its focus point). A collapsed
 *  range has no client rect at some node boundaries, so widen it by one
 *  character before falling back to the containing element's box. */
function getFocusRect(sel: Selection): DOMRect | null {
    const node = sel.focusNode;
    const doc = node?.ownerDocument;
    if (!node || !doc) return null;
    const offset = sel.focusOffset;
    const range = doc.createRange();
    try {
        range.setStart(node, offset);
        range.setEnd(node, offset);
    } catch {
        return null;
    }
    let rect: DOMRect | null = range.getClientRects()?.[0] ?? null;
    if (!rect && node.nodeType === Node.TEXT_NODE) {
        const length = (node as Text).length;
        try {
            if (offset < length) range.setEnd(node, offset + 1);
            else if (offset > 0) range.setStart(node, offset - 1);
            rect = range.getClientRects()?.[0] ?? null;
        } catch { /* the offsets may not be addressable */ }
    }
    if (!rect) {
        const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        rect = el?.getBoundingClientRect() ?? null;
    }
    return rect;
}

/** Scroll the caret (the selection's moving edge) back into view inside the
 *  editor's scroll host.
 *
 *  The browser does this automatically for native caret movement, but
 *  CaretNavigationPlugin moves the caret through the Selection API, which never
 *  scrolls, and Lexical only scrolls when it writes the DOM selection itself.
 *  Without this an Arrow/Cmd+Arrow/Home/End move in a scrolled editor leaves
 *  the viewport behind the caret. */
function scrollFocusIntoView(root: HTMLElement, sel: Selection): void {
    const scroller = root.closest('.beaver-lexical-scroll') as HTMLElement | null;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
    const rect = getFocusRect(sel);
    if (!rect) return;
    const view = scroller.getBoundingClientRect();
    // A sliver of margin keeps the caret clear of the host's edges.
    const margin = 2;
    if (rect.top < view.top + margin) {
        scroller.scrollTop -= view.top + margin - rect.top;
    } else if (rect.bottom > view.bottom - margin) {
        scroller.scrollTop += rect.bottom - (view.bottom - margin);
    }
}

/** Text-node-only offsets matching getDomFlatSelectionOffsets. This coordinate
 *  system intentionally excludes block separators and is only used by the DOM
 *  mutation guard when comparing two text-node selections. */
function $getDomComparableSelectionOffsets(): { anchor: number; focus: number } | null {
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

/** Restore offsets produced by $getDomComparableSelectionOffsets. */
function $selectDomComparableRange(start: number, end: number): void {
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
    /**
     * Publishes text that is still being withheld for an IME composition and
     * returns it; returns null when nothing is withheld, i.e. the `value` the
     * parent already holds is current.
     *
     * Text typed with an input method reaches the parent one composition at a
     * time rather than one keystroke at a time (see
     * createCompositionGatedEmitter), and the final emission follows the commit
     * by a short poll interval. Anything that acts on the composer's text at a
     * moment the user chose — sending, rejecting with instructions, saving an
     * edit — must call this first, or it can act on text that is missing the
     * candidate just committed.
     */
    flushPendingText: () => string | null;
    /**
     * Drops text still withheld for an IME composition and re-syncs the editor
     * to the parent's current `value`, instead of publishing it.
     *
     * For a composer that was reset programmatically (new thread, thread
     * switch): such a reset can write the same `value` the editor already has —
     * clearing an already-empty composer — which is invisible to the normal
     * value sync, so withheld text would otherwise reappear afterwards, in a
     * context the user has left.
     */
    discardPendingText: () => void;
};

/** The withheld-text operations PlainTextSync exposes to the handle. */
type PendingTextControls = {
    /** Publishes a withheld update now; true when one was withheld. */
    flush: () => boolean;
    /** Drops a withheld update and re-syncs the editor to the parent's value. */
    discard: () => void;
};

/**
 * Host-supplied handling for a paste that carries files rather than text (see
 * ClipboardAttachmentPlugin). Optional throughout: a host that cannot attach
 * files omits it and paste keeps its default text behavior.
 */
export interface ComposerPasteHandlers {
    /** Attach the files carried by a paste event. */
    onPasteFiles?: (files: File[]) => void;
    /**
     * Whether the clipboard holds a file that produces no paste event. Called
     * synchronously on every paste keystroke, so it must stay cheap.
     */
    hasClipboardFile?: () => boolean;
    /** Whether the clipboard holds an image, when a paste arrived without one. */
    hasClipboardImage?: () => boolean;
    /** Attach whatever attachable content the clipboard holds. */
    onPasteFromClipboard?: () => void;
}

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
    /**
     * Turns a paste that carries files into message attachments. Omit to leave
     * paste as plain text only.
     */
    pasteHandlers?: ComposerPasteHandlers;
}

// Exposes a textarea-like focus()/clear() API to the parent via ref so the
// surrounding InputArea can keep its existing imperative usage.
const EditorApi = forwardRef<LexicalEditorInputHandle, {
    pinnedEndCaretRef: React.MutableRefObject<boolean>;
    blurSelectionRef: React.MutableRefObject<LexicalSelectionOffsets | null>;
    selectionRepairGenerationRef: React.MutableRefObject<number>;
    pendingTextRef: React.MutableRefObject<PendingTextControls | null>;
}>(
    function EditorApi({ pinnedEndCaretRef, blurSelectionRef, selectionRepairGenerationRef, pendingTextRef }, ref) {
        const [editor] = useLexicalComposerContext();
        const setPlainText = useCallback((text: string, selectionStart = text.length, selectionEnd = selectionStart) => {
            selectionRepairGenerationRef.current++;
            pinnedEndCaretRef.current = false;
            blurSelectionRef.current = null;
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
        }, [editor, pinnedEndCaretRef, blurSelectionRef, selectionRepairGenerationRef]);

        useImperativeHandle(
            ref,
            () => ({
                focus: () => {
                    selectionRepairGenerationRef.current++;
                    const root = editor.getRootElement();
                    const doc = root?.ownerDocument;
                    const snap = blurSelectionRef.current;
                    if (root && doc && doc.activeElement !== root && snap) {
                        // While blurred, Lexical may have adopted a chrome-doc-collapsed
                        // (offset 0) selection into the editor state (see
                        // BlurSelectionSnapshotPlugin); editor.focus() would re-assert it.
                        // Restore the snapshot taken at blur instead.
                        blurSelectionRef.current = null;
                        pinnedEndCaretRef.current = false;
                        editor.update(
                            () => $selectFlatSelection(snap),
                            { discrete: true },
                        );
                    }
                    // Runs in both branches: on the restore path Lexical flushes the
                    // queued update first, so focus() re-asserts the restored
                    // selection; it also handles non-chrome documents where a
                    // selection update alone does not move DOM focus.
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
                    selectionRepairGenerationRef.current++;
                    pinnedEndCaretRef.current = false;
                    blurSelectionRef.current = null;
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
                    selectionRepairGenerationRef.current++;
                    pinnedEndCaretRef.current = false;
                    blurSelectionRef.current = null;
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
                    selectionRepairGenerationRef.current++;
                    blurSelectionRef.current = null;
                    editor.update(() => {
                        const root = $getRoot();
                        if (queryLength !== null) {
                            $deleteTrailingSlashQuery(queryLength);
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
                            descriptor.missing,
                            descriptor.persisted,
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
                    // Pin the caret to the end until the user interacts: the
                    // UI churn that follows a staged insert (sidebar opening,
                    // panels re-rendering, attachments mounting) can reset the
                    // chrome document's selection offsets to 0, dropping the
                    // caret behind the pill or to the start of the input. See
                    // PinnedEndCaretPlugin.
                    pinnedEndCaretRef.current = true;
                },
                getSlashCommands: () => {
                    let result: SlashCommandDescriptor[] = [];
                    editor.getEditorState().read(() => {
                        result = $collectSlashCommandDescriptors();
                    });
                    return result;
                },
                flushPendingText: () => {
                    // Only report text when something was actually withheld: the
                    // editor is not the source of truth for the parent's value
                    // (the parent may have just cleared it, with the clearing
                    // update still to run), so a caller must fall back to the
                    // value it holds whenever nothing is pending.
                    if (!pendingTextRef.current?.flush()) return null;
                    let text = '';
                    editor.getEditorState().read(() => {
                        text = $getRoot().getTextContent();
                    });
                    return text;
                },
                discardPendingText: () => {
                    pendingTextRef.current?.discard();
                },
            }),
            [editor, setPlainText, pinnedEndCaretRef, blurSelectionRef, selectionRepairGenerationRef, pendingTextRef],
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
    blurSelectionRef: React.MutableRefObject<LexicalSelectionOffsets | null>;
    ime: ImeCompositionTracker;
    pendingTextRef: React.MutableRefObject<PendingTextControls | null>;
}> = ({ value, onChange, pills, onPillsChange, blurSelectionRef, ime, pendingTextRef }) => {
    const [editor] = useLexicalComposerContext();
    // Tracks the last values we emitted upward to avoid echoes.
    const lastEmitted = useRef<string>('');
    const lastEmittedPills = useRef<SlashCommandDescriptor[] | null>(null);

    // Latest shared pill descriptors, readable from the value-sync effect
    // without retriggering it on descriptor identity churn. Assigned in
    // render so the sync effect below always sees the same-commit value.
    const pillsRef = useRef<SlashCommandDescriptor[]>([]);
    pillsRef.current = pills ?? [];

    // Latest external value, for the reset path (below), which runs outside
    // the sync effect and must use the value of the current commit.
    const valueRef = useRef(value);
    valueRef.current = value;

    // Id of a composition whose text a composer reset discarded, while that
    // composition was still open; null when nothing is suppressed. See
    // handleChange.
    const suppressedCompositionRef = useRef<number | null>(null);

    // Rebuild the editor's content from an external value.
    const applyExternalValue = useCallback((next: string) => {
        editor.update(() => {
            const root = $getRoot();
            if (root.getTextContent() === next) return;
            root.clear();
            const p = $createParagraphNode();
            $buildContentNodes(next, pillsRef.current).forEach(node => p.append(node));
            root.append(p);
        });
        lastEmitted.current = next;
        // A rebuild replaces the content wholesale, superseding any blur
        // snapshot the imperative focus() would otherwise restore.
        blurSelectionRef.current = null;
    }, [editor, blurSelectionRef]);

    // Sync external value -> editor (e.g. when parent clears after send)
    useEffect(() => {
        if (value === lastEmitted.current) return;
        applyExternalValue(value);
    }, [value, applyExternalValue]);

    const emit = useCallback(() => {
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

    // Read through a ref so the emitter can be built once per editor while
    // still calling the latest props.
    const emitRef = useRef(emit);
    emitRef.current = emit;

    // Composition updates are held back rather than published per keystroke —
    // publishing re-renders every consumer of the composer text, and a consumer
    // that mounts or unmounts a node breaks the running composition (see
    // createCompositionGatedEmitter).
    const emitterRef = useRef<ReturnType<typeof createCompositionGatedEmitter> | null>(null);
    useEffect(() => {
        const emitter = createCompositionGatedEmitter({
            // Keep the parent value insulated through Gecko's short
            // post-composition cleanup window. Zotero's chrome document can
            // remove the composition DOM node just after the final input; the
            // deferred recovery replaces it on the next task.
            isComposing: () => ime.isImeActive(),
            emit: () => emitRef.current(),
            getWindow: () => (editor.getRootElement()?.ownerDocument.defaultView ?? null) as
                (Window & typeof globalThis) | null,
        });
        emitterRef.current = emitter;
        // Lets the imperative handle reach the withheld text (see
        // flushPendingText / discardPendingText).
        pendingTextRef.current = {
            flush: () => emitter.flush(),
            discard: () => {
                const hadWithheld = emitter.discard();
                // A composition that is still open belongs to the discarded
                // draft as well: it goes on producing updates, and publishing
                // any of them would put the abandoned text into the new
                // context. Suppress the REST of that composition too, keyed to
                // its id so a composition the user starts afterwards is
                // unaffected (see handleChange).
                //
                // Deliberately the strict check, NOT the post-composition grace
                // window: a composition whose text has already been published
                // is finished business, and suppressing on the strength of the
                // grace alone would swallow ordinary typing that follows it.
                // The strict check still covers a commit that is in flight —
                // Lexical stays composing until it has processed the
                // composition's final input, which is exactly the window in
                // which a reset can outrun the committed text.
                const composing = ime.isComposing();
                suppressedCompositionRef.current = composing ? ime.compositionId() : null;
                if (!hadWithheld && !composing) return;
                // The editor still holds text the parent never saw. After an
                // explicit reset the parent's value is the authoritative one,
                // so the withheld text goes rather than surfacing later.
                applyExternalValue(valueRef.current);
            },
        };
        return () => {
            emitterRef.current = null;
            pendingTextRef.current = null;
            emitter.dispose();
        };
    }, [editor, ime, pendingTextRef, applyExternalValue]);

    const handleChange = useCallback(() => {
        const suppressed = suppressedCompositionRef.current;
        if (suppressed !== null) {
            if (ime.compositionId() !== suppressed) {
                // A new composition — the user is typing into the reset
                // composer, which publishes normally.
                suppressedCompositionRef.current = null;
            } else if (ime.isComposing()) {
                // Still the composition that spanned the reset. Its text was
                // discarded; swallow the rest of it.
                return;
            } else if (ime.isImeActive()) {
                // It has just finished, so this update carries its committed
                // text. Drop that text and put the editor back on the parent's
                // value, which is what a reset composer holds. Disarms itself,
                // so it can only ever consume the one update that follows the
                // composition it was armed for.
                suppressedCompositionRef.current = null;
                applyExternalValue(valueRef.current);
                return;
            } else {
                // The composition is long over and produced no further update:
                // this one is unrelated (the user typing into the new thread),
                // so it publishes normally.
                suppressedCompositionRef.current = null;
            }
        }
        // Before the effect has run (first commit) there is nothing composing
        // yet, so publishing directly matches the gated path.
        if (!emitterRef.current) {
            emitRef.current();
            return;
        }
        emitterRef.current.handleUpdate();
    }, [ime, applyExternalValue]);

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
const SlashCommandRevertPlugin: React.FC<{ ime: ImeCompositionTracker }> = ({ ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        return editor.registerNodeTransform(SlashCommandNode, (node) => {
            const text = node.getTextContent();
            if (text === `/${node.getCommandName()}`) return; // unchanged - keep colored

            // Don't rip the node out mid-IME-composition.
            if (ime.isComposing()) return;

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
    }, [editor, ime]);
    return null;
};

/**
 * Renders an action's argument hint as greyed-out ghost text after a freshly
 * inserted /command pill ("/summarize-paper |hint…", caret before the hint),
 * mimicking placeholder text for the argument slot.
 *
 * The hint shows while a pill carrying an argumentHint is the last
 * non-whitespace content of the editor's last line, and disappears as soon as
 * the user types an argument (or breaks to a new line). It is rendered as a
 * positioned pseudo-element on the pill's paragraph, so long hints can be
 * truncated without changing the editor height.
 */
const ArgumentHintPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        let decoratedEl: HTMLElement | null = null;
        const clearDecoration = (el: HTMLElement | null) => {
            if (!el) return;
            el.removeAttribute('data-argument-hint');
            el.style.removeProperty('--beaver-argument-hint-left');
            el.style.removeProperty('--beaver-argument-hint-top');
        };
        const apply = () => {
            let hint: string | null = null;
            let paragraphKey: string | null = null;
            let pillKey: string | null = null;
            editor.getEditorState().read(() => {
                const last = $getRoot().getLastChild();
                if (!$isElementNode(last)) return;
                const children = last.getChildren();
                for (let i = children.length - 1; i >= 0; i--) {
                    const node = children[i];
                    if ($isSlashCommandNode(node)) {
                        hint = node.getArgumentHint() || null;
                        paragraphKey = last.getKey();
                        pillKey = node.getKey();
                        return;
                    }
                    // A line break or any non-whitespace content after the
                    // pill means the user has moved on — no hint.
                    if ($isLineBreakNode(node) || node.getTextContent().trim().length > 0) return;
                }
            });
            const el = hint && paragraphKey ? editor.getElementByKey(paragraphKey) : null;
            const pillEl = hint && pillKey ? editor.getElementByKey(pillKey) : null;
            if (decoratedEl && decoratedEl !== el) {
                clearDecoration(decoratedEl);
            }
            if (el && pillEl && hint) {
                const paragraphRect = el.getBoundingClientRect();
                const pillRect = pillEl.getBoundingClientRect();
                const left = Math.max(0, pillRect.right - paragraphRect.left + 4);
                const top = Math.max(0, pillRect.top - paragraphRect.top);
                el.style.setProperty('--beaver-argument-hint-left', `${left}px`);
                el.style.setProperty('--beaver-argument-hint-top', `${top}px`);
                el.setAttribute('data-argument-hint', hint);
            } else if (el) {
                clearDecoration(el);
            }
            decoratedEl = el && pillEl && hint ? el : null;
        };
        const unregister = editor.registerUpdateListener(apply);
        apply();
        return () => {
            unregister();
            clearDecoration(decoratedEl);
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
                // An Enter owned by an active IME composition (e.g. confirming
                // a candidate) must not submit; the next Enter, once the
                // composition is committed, does.
                if (editor.isComposing() || isImeKeyEvent(event)) return false;
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
 * Turns pasted files and images into message attachments.
 *
 * The two clipboard shapes arrive differently, so this plugin hooks both a
 * command and a raw key:
 *
 * - **Images** arrive as a normal paste with the bytes on `clipboardData`. Such
 *   a clipboard carries no text, so without this handler the plain-text paste
 *   inserts nothing and the paste looks ignored. PASTE_COMMAND is registered
 *   above the plain-text handler so an attachment paste can consume the event.
 * - **Files copied in a file manager** carry only the platform's file flavor,
 *   which editors do not consider pasteable — *no paste event is dispatched*.
 *   They are only visible by inspecting the clipboard when the paste key is
 *   pressed, so Cmd/Ctrl+V is watched on keydown too. That check is false for
 *   any text clipboard, leaving ordinary paste untouched.
 *
 * Both routes come from the host (`pasteHandlers`); with none registered the
 * plugin stands down.
 */
const ClipboardAttachmentPlugin: React.FC<{
    handlers?: ComposerPasteHandlers;
    ime: ImeCompositionTracker;
}> = ({ handlers, ime }) => {
    const [editor] = useLexicalComposerContext();

    // Read through a ref so the listeners register once per editor rather than
    // re-registering on every host re-render.
    const handlersRef = useRef<ComposerPasteHandlers | undefined>(handlers);
    handlersRef.current = handlers;

    useEffect(() => {
        return editor.registerCommand<ClipboardEvent>(
            PASTE_COMMAND,
            (event) => {
                const { onPasteFiles, hasClipboardImage, onPasteFromClipboard } = handlersRef.current ?? {};
                const files = event?.clipboardData?.files;
                if (files && files.length > 0) {
                    if (!onPasteFiles) return false;
                    event.preventDefault();
                    onPasteFiles(Array.from(files));
                    return true;
                }
                // Some platforms dispatch the paste for a clipboard image but
                // leave the image out of the payload.
                if (onPasteFromClipboard && hasClipboardImage?.()) {
                    event.preventDefault();
                    onPasteFromClipboard();
                    return true;
                }
                return false;
            },
            COMMAND_PRIORITY_HIGH,
        );
    }, [editor]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'v' && e.key !== 'V') return;
            const accel = Zotero.isMac ? e.metaKey : e.ctrlKey;
            if (!accel || e.altKey || e.shiftKey) return;
            // An input method may use the same chord.
            if (isImeKeyEvent(e) || ime.isComposing()) return;
            // Only the no-paste-event case is claimed here; a clipboard image
            // does fire a paste and is left to the command handler above.
            const { hasClipboardFile, onPasteFromClipboard } = handlersRef.current ?? {};
            if (!hasClipboardFile || !onPasteFromClipboard) return;
            if (!hasClipboardFile()) return;
            e.preventDefault();
            onPasteFromClipboard();
        };

        return editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) prevRootElement.removeEventListener('keydown', handler, true);
            if (rootElement) rootElement.addEventListener('keydown', handler, true);
        });
    }, [editor, ime]);

    return null;
};

/**
 * Publishes this editor's IME composition state (see ImeCompositionTracker),
 * which every plugin that writes the selection or rewrites nodes consults
 * before acting. Registered ahead of those plugins.
 */
const ImeCompositionTrackerPlugin: React.FC<{ ime: ImeCompositionTracker }> = ({ ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => ime.register(editor), [editor, ime]);
    return null;
};

/**
 * Applies the Windows IME composition-order workaround to this editor (see
 * registerCompositionEndDeferral). Windows-only; the `imeCompositionOrderFix`
 * pref is a kill-switch in case an IME interacts badly with the deferral.
 */
const WindowsImeCompositionOrderPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        if (!Zotero.isWin) return;
        if (getPref('imeCompositionOrderFix') === false) return;
        return registerCompositionEndDeferral(editor, {
            trace: getPref('debugImeTrace') === true,
        });
    }, [editor]);
    return null;
};

/**
 * Compact IME event tracing (pref `debugImeTrace`), for diagnosing
 * composition issues without a local reproduction.
 */
const ImeTracePlugin: React.FC<{ ime: ImeCompositionTracker }> = ({ ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        if (!getPref('debugImeTrace')) return;
        return registerImeTrace(editor, ime);
    }, [editor, ime]);
    return null;
};

/**
 * Replaces a non-collapsed selection with typed text through Lexical's
 * controlled insertion path instead of the browser's native contenteditable
 * edit.
 */
const TypeOverSelectionPlugin: React.FC<{ ime: ImeCompositionTracker }> = ({ ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        return editor.registerCommand<InputEvent>(
            BEFORE_INPUT_COMMAND,
            (event) => {
                if (event.inputType !== 'insertText') return false;
                const data = event.data;
                // Line breaks have dedicated commands; let Lexical route them.
                if (data == null || data === '\n' || data === '\n\n') return false;
                // An IME can deliver its commit as a plain insertText; taking
                // it over here would drop the composed text.
                if (ime.isImeActive()) return false;
                const selection = $getSelection();
                if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
                event.preventDefault();
                editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, data);
                return true;
            },
            COMMAND_PRIORITY_LOW,
        );
    }, [editor, ime]);
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
 *
 * Because the caret moves through the Selection API rather than natively, the
 * editor's scroll host never follows it; every handled key therefore ends with
 * an explicit scrollFocusIntoView().
 */
const CaretNavigationPlugin: React.FC<{
    suspendedRef: React.MutableRefObject<boolean>;
    pendingDomSelectionRef: React.MutableRefObject<DomSelectionSnapshot | null>;
    ime: ImeCompositionTracker;
}> = ({ suspendedRef, pendingDomSelectionRef, ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // While a menu (slash / attachment) is open, let it own the keys.
            if (suspendedRef.current) return;
            // While an IME composition is active the IME owns the navigation
            // keys (candidate-window movement); moving the DOM selection here
            // would force Gecko to commit the composition. Not every IME flags
            // the key events it consumes, so the composition state is checked
            // alongside the per-event flags.
            //
            // Deliberately the strict check, not the post-composition grace
            // window used by the selection-repair paths: standing down here
            // means the key is left unhandled, and an unhandled navigation key
            // lets Zotero's focus manager pull focus out of the editor (the
            // reason this plugin exists). A finished composition does not
            // consume plain arrow keys, so the grace period must not suppress
            // them — dead-key and accent input would hit that window too.
            if (isImeKeyEvent(e) || ime.isComposing()) return;
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
            // Collapse a range selection to its leading (start) or trailing
            // (end) edge in document order. Returns whether a range was
            // actually collapsed.
            const collapseRangeTo = (toEnd: boolean): boolean => {
                if (sel.isCollapsed || sel.rangeCount === 0) return false;
                const range = sel.getRangeAt(0);
                try {
                    if (toEnd) sel.collapse(range.endContainer, range.endOffset);
                    else sel.collapse(range.startContainer, range.startOffset);
                } catch { /* boundary point may be unresolvable */ }
                return true;
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

            // An unmodified caret move out of a range selection starts from the
            // selection's leading/trailing edge, as in the platform's native
            // text fields. Selection.modify('move', ...) instead moves relative
            // to the focus edge, so a forward selection (e.g. select-all) would
            // land one step short of the intended edge.
            const collapsedRange = alter === 'move' && collapseRangeTo(collapsesToRangeEnd(key));

            switch (key) {
                case 'ArrowLeft':
                case 'ArrowRight': {
                    const fwd = key === 'ArrowRight';
                    if (isMac && e.metaKey) modifySkippingPills(fwd ? 'forward' : 'backward', 'lineboundary');
                    else if ((isMac && e.altKey) || (!isMac && e.ctrlKey)) modifySkippingPills(fwd ? 'right' : 'left', 'word');
                    // Plain left/right out of a range selection only collapses
                    // to that edge - it does not additionally step a character.
                    else if (!collapsedRange) modifySkippingPills(fwd ? 'right' : 'left', 'character');
                    else if (isStrictlyInsidePill()) modifySkippingPills(fwd ? 'right' : 'left', 'character');
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
            // The Selection API moves above never scroll (the browser only does
            // that for native caret movement, which preventDefault suppresses),
            // so follow the caret ourselves.
            scrollFocusIntoView(root, sel);
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
    }, [editor, suspendedRef, pendingDomSelectionRef, ime]);
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
    ime: ImeCompositionTracker;
}> = ({ pendingDomSelectionRef, ime }) => {
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
            // XUL popups and drag capture can swallow the pointerup that would
            // normally clear the flag; a stuck `pointerDown` would disable the
            // repair below indefinitely.
            const onPointerCancel = () => {
                pointerDown = false;
            };
            // A pointer sequence can be cut off when the OS deactivates the
            // window, leaving no pointerup/pointercancel in this document. A
            // stuck flag would disable caret repair on the first mutation
            // after reactivation (notably the placeholder disappearing).
            const onWindowBlur = () => {
                pointerDown = false;
                pendingDomSelectionRef.current = null;
            };
            // Runs after Lexical's own selectionchange listener (registered at
            // editor creation, so earlier), i.e. once Lexical has adopted the
            // current DOM selection and the snapshot is no longer needed.
            const onSelectionChange = () => {
                pendingDomSelectionRef.current = null;
            };

            const onMutations = (records: MutationRecord[]) => {
                // Editor-internal records are the reconciler's own work — it
                // sets the selection itself after them. Only mutations outside
                // the editor can clobber the caret via the chrome document's
                // selection reset, so a batch with no external record needs no
                // repair. Mixed batches DO get repaired: the comparison below
                // runs against the already-committed editor state, so a
                // reconciler-placed selection compares equal and is left alone.
                if (records.every(record => root.contains(record.target))) return;
                if (pointerDown) return;
                if (ime.isImeActive()) return;
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
                    state = $getDomComparableSelectionOffsets();
                });
                if (!state) return;
                const stateOffsets = state as { anchor: number; focus: number };
                if (live.anchor === stateOffsets.anchor && live.focus === stateOffsets.focus) return;
                // Re-select the committed state's offsets, read above in a
                // read context (which returns the stored selection, not the
                // DOM). We must NOT clone $getSelection() here: at the start of
                // a non-headless editor.update() Lexical rebuilds the pending
                // selection FROM the live DOM (see $internalCreateSelection), so
                // $getSelection() would return the just-collapsed caret (offset
                // 0) and the "repair" would cement that collapse into the editor
                // state. $selectFlatRange sets the anchor/focus points
                // explicitly, overriding that DOM-derived selection. The
                // discrete update reconciles the corrected selection to the DOM
                // synchronously, still ahead of the queued selectionchange task.
                // (Range direction is not preserved; a collapsed caret — the
                // common case — is unaffected.)
                editor.update(() => {
                    $selectDomComparableRange(
                        Math.min(stateOffsets.anchor, stateOffsets.focus),
                        Math.max(stateOffsets.anchor, stateOffsets.focus),
                    );
                }, { discrete: true });
            };

            const observer = new (win as typeof globalThis & Window).MutationObserver(onMutations);
            observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
            doc.addEventListener('pointerdown', onPointerDown, true);
            doc.addEventListener('pointerup', onPointerUp, true);
            doc.addEventListener('pointercancel', onPointerCancel, true);
            doc.addEventListener('selectionchange', onSelectionChange);
            win.addEventListener('blur', onWindowBlur);
            return () => {
                observer.disconnect();
                doc.removeEventListener('pointerdown', onPointerDown, true);
                doc.removeEventListener('pointerup', onPointerUp, true);
                doc.removeEventListener('pointercancel', onPointerCancel, true);
                doc.removeEventListener('selectionchange', onSelectionChange);
                win.removeEventListener('blur', onWindowBlur);
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
    }, [editor, pendingDomSelectionRef, ime]);
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
 *
 * Only the restore is held back for an active IME: writing the selection while
 * an input method is open (some host their candidate window in a separate OS
 * window) makes Gecko commit or discard the composed text. Taking the snapshot
 * on blur is a read and always runs — skipping it is what loses the caret,
 * since the fallback on the way back in can only observe the already-collapsed
 * selection.
 *
 * A held restore waits for the IME to actually go inactive rather than for a
 * fixed number of attempts: a composition can still be open when the window
 * comes back (returning from a candidate window or alt-tab) and may stay open
 * indefinitely. Three things end the wait instead of a short budget — the
 * snapshot is dropped as soon as the content changes (an IME committing text at
 * the clobbered caret makes the saved offsets describe different content), a
 * pointer interaction or a key the IME does not own cancels it, because from
 * then on the caret is wherever the user put it, and another window
 * deactivation supersedes it with a fresh snapshot.
 */
const SelectionPersistencePlugin: React.FC<{ ime: ImeCompositionTracker }> = ({ ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        let saved: LexicalSelectionOffsets | null = null;
        let savedText = '';
        let rootEl: HTMLElement | null = null;
        let restoreTimer: number | null = null;
        const isEditorActive = () =>
            !!rootEl && rootEl.ownerDocument.activeElement === rootEl;

        const cancelRestore = () => {
            if (restoreTimer === null) return;
            rootEl?.ownerDocument.defaultView?.clearTimeout(restoreTimer);
            restoreTimer = null;
        };

        // A pointer interaction always places the caret, so it supersedes a
        // pending restore. Key events only do when they are the user's own:
        // candidate navigation and confirmation keys belong to the IME and
        // place no caret, so discarding the snapshot for them would leave the
        // chrome-collapsed selection in place. Composed text landing instead
        // invalidates the restore through its expected-text check.
        const cancelRestoreOnKeyDown = (e: KeyboardEvent) => {
            if (isImeKeyEvent(e) || ime.isComposing()) return;
            cancelRestore();
        };

        // Applies the restore once the IME is no longer open. `expectedText`
        // scopes it to the content the offsets were captured against, so a
        // composition that lands text in the meantime invalidates it instead of
        // moving the caret into unrelated text.
        const applyRestore = (
            offsets: LexicalSelectionOffsets,
            expectedText: string,
            deadline: number,
        ) => {
            restoreTimer = null;
            const root = rootEl;
            if (!root || !isEditorActive()) return;
            let currentText = '';
            editor.getEditorState().read(() => {
                currentText = $getRoot().getTextContent();
            });
            if (currentText !== expectedText) return;
            // Wait for the IME to finish AND for the window to actually hold
            // focus. activeElement stays on the editor across OS window
            // deactivation (the very reason this plugin exists), so writing on
            // the strength of it alone could clobber the snapshot just taken on
            // blur or disturb a still-open IME. Both conditions are waited on
            // rather than treated as a hard bail, so a focus event that lands
            // before the document reports focus still restores the caret.
            if (ime.isImeActive() || !root.ownerDocument.hasFocus()) {
                const win = root.ownerDocument.defaultView;
                if (!win || Date.now() >= deadline) return;
                restoreTimer = win.setTimeout(
                    () => applyRestore(offsets, expectedText, deadline),
                    IME_REPAIR_RETRY_MS,
                );
                return;
            }
            editor.update(
                () => $selectFlatSelection(offsets),
                { discrete: true },
            );
        };

        const onWindowBlur = (e: FocusEvent) => {
            // Only window deactivation - element-level blurs don't bubble to
            // the window, but be defensive about synthesized events.
            if (e.target !== e.currentTarget) return;
            if (!isEditorActive()) return;
            // A restore still waiting for the IME belongs to the previous
            // activation; the snapshot taken below supersedes it.
            cancelRestore();
            editor.getEditorState().read(() => {
                saved = $getFlatSelectionOffsets();
                savedText = $getRoot().getTextContent();
            });
        };
        const onWindowFocus = (e: FocusEvent) => {
            if (e.target !== e.currentTarget) return;
            let restore = saved;
            let restoreText = savedText;
            saved = null;
            if (!isEditorActive()) return;
            let isEmpty = false;
            editor.getEditorState().read(() => {
                isEmpty = $getRoot().getTextContentSize() === 0;
                // Some Gecko focus transitions change activeElement before the
                // blur listener runs. The active editor's current model point
                // is still a useful fallback, especially when it is empty.
                if (!restore) {
                    restore = $getFlatSelectionOffsets();
                    restoreText = $getRoot().getTextContent();
                }
            });
            if (!restore && isEmpty) {
                restore = {
                    anchor: 0,
                    focus: 0,
                    anchorType: 'element',
                    focusType: 'element',
                };
                restoreText = '';
            }
            if (!restore) return;
            cancelRestore();
            applyRestore(restore, restoreText, Date.now() + IME_RESTORE_MAX_WAIT_MS);
        };

        const unregisterRoot = editor.registerRootListener((rootElement, prevRootElement) => {
            const prevWin = prevRootElement?.ownerDocument.defaultView;
            if (prevWin) {
                prevWin.removeEventListener('blur', onWindowBlur);
                prevWin.removeEventListener('focus', onWindowFocus);
                prevRootElement?.ownerDocument.removeEventListener('pointerdown', cancelRestore, true);
                prevRootElement?.removeEventListener('keydown', cancelRestoreOnKeyDown, true);
            }
            cancelRestore();
            rootEl = rootElement;
            const win = rootElement?.ownerDocument.defaultView;
            if (rootElement && win) {
                win.addEventListener('blur', onWindowBlur);
                win.addEventListener('focus', onWindowFocus);
                rootElement.ownerDocument.addEventListener('pointerdown', cancelRestore, true);
                rootElement.addEventListener('keydown', cancelRestoreOnKeyDown, true);
            }
        });
        return () => {
            cancelRestore();
            unregisterRoot();
        };
    }, [editor, ime]);
    return null;
};

/**
 * Normalizes every first ordinary insertion into an empty editor through
 * Lexical's controlled insertion path. An empty contenteditable can carry a
 * Gecko root-level DOM point even though Lexical expects the caret in its empty
 * paragraph; native insertion at that mismatched point is the common trigger
 * for a first-character jump after stop, send, focus changes, and similar UI
 * transitions.
 */
const EmptyEditorInsertionPlugin: React.FC<{ ime: ImeCompositionTracker }> = ({ ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => editor.registerCommand<InputEvent>(
        BEFORE_INPUT_COMMAND,
        (event) => {
            if (
                event.inputType !== 'insertText'
                || event.data == null
                || event.data === '\n'
                || event.data === '\n\n'
                // An IME commit can arrive as insertText; let it through
                // natively rather than re-inserting it through Lexical.
                || ime.isImeActive()
                || $getRoot().getTextContentSize() !== 0
            ) {
                return false;
            }
            const selection = $getFlatSelectionOffsets() ?? {
                anchor: 0,
                focus: 0,
                anchorType: 'element' as const,
                focusType: 'element' as const,
            };
            event.preventDefault();
            $selectFlatSelection(selection);
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, event.data);
            return true;
        },
        COMMAND_PRIORITY_HIGH,
    ), [editor, ime]);
    return null;
};

/**
 * Holds on to Lexical's selection after each committed text update until
 * surrounding React/XUL mutations have settled. Zotero's chrome document can
 * reset selection offsets when unrelated child nodes mount/unmount; repairing
 * in the next task covers mutations that land after MutationObserver-based
 * SelectionGuardPlugin has already run. The first insertion is always
 * re-asserted because the churn around the first keystroke can clobber the DOM
 * selection before this listener gets a reliable snapshot. Later updates only
 * write when the live selection actually drifted. A newer edit or user action
 * cancels it.
 *
 * While an IME may still be composing the repair is postponed rather than
 * dropped: writing the selection then would discard the composed text, but the
 * text update that follows a commit still needs its caret protected.
 */
const DeferredSelectionRepairPlugin: React.FC<{
    selectionRepairGenerationRef: React.MutableRefObject<number>;
    ime: ImeCompositionTracker;
}> = ({ selectionRepairGenerationRef, ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        let rootEl: HTMLElement | null = null;
        let repairTimer: number | null = null;

        const isEditorActiveInFocusedWindow = (root: HTMLElement) =>
            root.ownerDocument.hasFocus()
            && root.ownerDocument.activeElement === root;

        const clearRepair = () => {
            if (repairTimer === null) return;
            rootEl?.ownerDocument.defaultView?.clearTimeout(repairTimer);
            repairTimer = null;
        };

        // Composition-owned updates are NOT filtered out here. With the Windows
        // composition-order deferral the update that carries the committed text
        // arrives while Lexical is deliberately still composing, and the
        // composition-end update that follows it leaves the text unchanged — so
        // skipping composing updates would drop the one update an IME commit
        // needs repaired. Instead every text change schedules a repair that
        // waits for the IME (see runRepair); superseded schedules are cancelled
        // below, and a schedule whose text no longer matches is discarded.
        const unregisterUpdate = editor.registerUpdateListener(({ editorState, prevEditorState }) => {
            if (!rootEl || !isEditorActiveInFocusedWindow(rootEl)) return;
            let previousText = '';
            let nextText = '';
            let expectedSelection: LexicalSelectionOffsets | null = null;
            prevEditorState.read(() => {
                previousText = $getRoot().getTextContent();
            });
            editorState.read(() => {
                nextText = $getRoot().getTextContent();
                expectedSelection = $getFlatSelectionOffsets();
            });
            if (previousText === nextText || !expectedSelection) return;

            const root = rootEl;
            const win = root.ownerDocument.defaultView;
            if (!win) return;
            const domSelection = win.getSelection();
            const expectedDom = domSelection ? captureDomSelection(domSelection, root) : null;
            const expectedText = nextText;
            const expectedModel = expectedSelection;
            const isFirstInsertion = previousText.length === 0 && nextText.length > 0;
            const repairGeneration = selectionRepairGenerationRef.current;
            clearRepair();
            // Attempts left for postponing the repair past an IME that is
            // still open. Bounded so a wedged composition cannot keep a timer
            // alive indefinitely.
            let imeRetriesLeft = IME_REPAIR_RETRIES;
            const runRepair = () => {
                repairTimer = null;
                if (
                    selectionRepairGenerationRef.current !== repairGeneration
                    || !isEditorActiveInFocusedWindow(root)
                ) return;
                if (ime.isImeActive()) {
                    if (imeRetriesLeft-- <= 0) return;
                    repairTimer = win.setTimeout(runRepair, IME_REPAIR_RETRY_MS);
                    return;
                }
                let currentText = '';
                editor.getEditorState().read(() => {
                    currentText = $getRoot().getTextContent();
                });
                if (currentText !== expectedText) return;
                const live = win.getSelection();
                if (!live) return;
                if (!isFirstInsertion && expectedDom) {
                    const unchanged =
                        root.contains(expectedDom.anchorNode)
                        && root.contains(expectedDom.focusNode)
                        && live.anchorNode === expectedDom.anchorNode
                        && live.anchorOffset === expectedDom.anchorOffset
                        && live.focusNode === expectedDom.focusNode
                        && live.focusOffset === expectedDom.focusOffset;
                    if (unchanged) return;
                }
                editor.update(
                    () => $selectFlatSelection(expectedModel),
                    { discrete: true },
                );
            };
            repairTimer = win.setTimeout(runRepair, 0);
        });

        const unregisterRoot = editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) {
                prevRootElement.removeEventListener('keydown', clearRepair, true);
                prevRootElement.ownerDocument.removeEventListener('pointerdown', clearRepair, true);
                prevRootElement.ownerDocument.defaultView?.removeEventListener('blur', clearRepair);
            }
            clearRepair();
            rootEl = rootElement;
            if (rootElement) {
                rootElement.addEventListener('keydown', clearRepair, true);
                rootElement.ownerDocument.addEventListener('pointerdown', clearRepair, true);
                rootElement.ownerDocument.defaultView?.addEventListener('blur', clearRepair);
            }
        });

        return () => {
            clearRepair();
            unregisterUpdate();
            unregisterRoot();
        };
    }, [editor, selectionRepairGenerationRef, ime]);
    return null;
};

/**
 * Snapshots the editor's selection offsets on element blur (focusout), for
 * the imperative focus() handle to restore.
 */
const BlurSelectionSnapshotPlugin: React.FC<{
    blurSelectionRef: React.MutableRefObject<LexicalSelectionOffsets | null>;
}> = ({ blurSelectionRef }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        const onFocusOut = () => {
            editor.getEditorState().read(() => {
                blurSelectionRef.current = $getFlatSelectionOffsets();
            });
        };
        return editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) prevRootElement.removeEventListener('focusout', onFocusOut);
            if (rootElement) rootElement.addEventListener('focusout', onFocusOut);
        });
    }, [editor, blurSelectionRef]);
    return null;
};

/**
 * Keeps the caret pinned to the end of the content after a programmatic
 * /command pill insert, until the user interacts with the editor.
 *
 * A staged pill always ends as "pill + space" with the caret at the very end
 * (`/action |`). But the insert is followed by heavy UI churn — the sidebar
 * opening, launcher panels re-rendering, attachment chips mounting — and in
 * Zotero's chrome document every one of those mutations can reset the
 * selection offsets to 0 (see SelectionGuardPlugin), leaving the caret right
 * behind the pill or at the start of the input. The MutationObserver repair
 * in SelectionGuardPlugin covers the common cases, but it must stand down
 * while the editor is not the active element or a pointer is down, and once
 * Lexical adopts a clobbered selection the state matches the DOM and no later
 * repair fires.
 *
 * This plugin closes that gap deterministically: while pinned, any
 * selectionchange that leaves the selection inside the editor but NOT at the
 * end of the content is corrected back to the end. The pin is released on the
 * first real user interaction (keydown in the editor, pointerdown anywhere,
 * IME composition) and whenever the caret is placed explicitly through the
 * imperative handle (setText / selectRange / clear / deleteTrailingCharacter).
 */
const PinnedEndCaretPlugin: React.FC<{
    pinnedRef: React.MutableRefObject<boolean>;
    ime: ImeCompositionTracker;
}> = ({ pinnedRef, ime }) => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        const setup = (root: HTMLElement): (() => void) => {
            const doc = root.ownerDocument;
            const win = doc.defaultView;
            if (!win) return () => {};

            const unpin = () => {
                pinnedRef.current = false;
            };

            const onSelectionChange = () => {
                if (!pinnedRef.current) return;
                if (ime.isImeActive()) return;
                // Correcting the caret writes the selection, which pulls DOM
                // focus back to the editor; never do that while focus is
                // parked elsewhere (e.g. an open menu's search input).
                if (doc.activeElement !== root) return;
                const sel = win.getSelection();
                if (!sel || !sel.anchorNode || !sel.focusNode) return;
                // Only correct selections that landed inside the editor — a
                // selection elsewhere means another surface owns it (and the
                // editor state selection is restored by focus() on return).
                if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;
                let textLength = 0;
                editor.getEditorState().read(() => {
                    textLength = $getRoot().getTextContent().length;
                });
                const live = getDomFlatSelectionOffsets(root, sel);
                if (live && live.anchor === textLength && live.focus === textLength) return;
                editor.update(() => $selectFlatRange(textLength, textLength));
            };

            doc.addEventListener('selectionchange', onSelectionChange);
            doc.addEventListener('pointerdown', unpin, true);
            root.addEventListener('keydown', unpin, true);
            root.addEventListener('compositionstart', unpin, true);
            return () => {
                doc.removeEventListener('selectionchange', onSelectionChange);
                doc.removeEventListener('pointerdown', unpin, true);
                root.removeEventListener('keydown', unpin, true);
                root.removeEventListener('compositionstart', unpin, true);
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
    }, [editor, pinnedRef, ime]);
    return null;
};

/**
 * Toggles placeholder visibility through an attribute instead of mounting and
 * unmounting the placeholder element.
 *
 * Lexical's own placeholder is rendered conditionally, so it is removed from
 * the DOM on the first keystroke — and, because a composing editor reads as
 * non-empty, exactly when an IME composition starts. In Zotero's chrome
 * document any childList mutation resets the contenteditable's selection
 * offsets to 0, which destroys the composition anchor the IME is holding, and
 * the caret repairs must stand down while composing. Attribute mutations do
 * not have that effect, so the element stays mounted and CSS hides it.
 *
 * The attribute is written straight to the DOM (not via React state) so that
 * typing never re-renders the composer subtree.
 */
const PlaceholderVisibilityPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        let host: HTMLElement | null = null;
        const apply = () => {
            if (!host) return;
            let isEmpty = false;
            editor.getEditorState().read(() => {
                isEmpty = $getRoot().getTextContent() === '';
            });
            // A composing editor already shows the composed text in the DOM
            // even while its model can still read as empty.
            const visible = isEmpty && !editor.isComposing();
            host.setAttribute('data-placeholder-visible', visible ? 'true' : 'false');
        };
        const unregisterUpdate = editor.registerUpdateListener(apply);
        const unregisterRoot = editor.registerRootListener((rootElement) => {
            host = (rootElement?.closest('.beaver-lexical-scroll') as HTMLElement | null) ?? null;
            apply();
        });
        return () => {
            unregisterUpdate();
            unregisterRoot();
        };
    }, [editor]);
    return null;
};

/**
 * Opens the host's action editor (for Zotero, the preferences window's Actions
 * tab) with the clicked /command pill's action revealed in edit mode. The
 * pill's DOM carries the action id via the data-action-id attribute (see
 * SlashCommandNode.createDOM).
 *
 * A plain left-click on a pill is an "open the action" command, not a text
 * interaction, so the browser's default caret placement is suppressed on
 * mousedown (the click event still fires with a prevented mousedown) — the
 * caret stays exactly where it was instead of landing mid-token. Modified
 * clicks (e.g. shift = extend selection) keep native text behavior and do not
 * activate the pill.
 */
const SlashCommandClickPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        const activatedPill = (e: MouseEvent): HTMLElement | null => {
            if (e.button !== 0 || e.shiftKey) return null;
            const pill = ((e.target as Element | null)?.closest?.('.beaver-slash-command') ?? null) as HTMLElement | null;
            // Missing actions have nothing to open in preferences; keep native
            // text behavior for them.
            if (pill?.getAttribute('data-missing') === 'true') return null;
            return pill;
        };
        const onMouseDown = (e: MouseEvent) => {
            if (activatedPill(e)) e.preventDefault();
        };
        const onClick = (e: MouseEvent) => {
            const pill = activatedPill(e);
            if (!pill) return;
            const actionId = pill.getAttribute('data-action-id');
            if (!actionId) return;
            getHost().navigation?.openActionSettings?.(actionId);
        };
        return editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) {
                prevRootElement.removeEventListener('mousedown', onMouseDown);
                prevRootElement.removeEventListener('click', onClick);
            }
            if (rootElement) {
                rootElement.addEventListener('mousedown', onMouseDown);
                rootElement.addEventListener('click', onClick);
            }
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
        console.error('[LexicalEditorInput]', error);
    },
};

export const LexicalEditorInput = forwardRef<LexicalEditorInputHandle, LexicalEditorInputProps>(
    function LexicalEditorInput(
        { value, onChange, pills, onPillsChange, onSubmit, placeholder, ariaLabel, disabled = false, onKeyDown, suspendKeyboardNavigation = false, onContentEditableRef, pasteHandlers },
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

        // True after a programmatic /command pill insert, until the first user
        // interaction: while set, PinnedEndCaretPlugin holds the caret at the
        // end of the content ("/action |") against chrome-document selection
        // resets. Written by EditorApi, read by PinnedEndCaretPlugin.
        const pinnedEndCaretRef = useRef(false);

        // The editor state's selection offsets captured at the last element
        // blur (focusout), used by EditorApi's imperative focus() to restore
        // the caret if Lexical adopted a chrome-doc-collapsed selection while
        // blurred. Written by BlurSelectionSnapshotPlugin, consumed and
        // invalidated by EditorApi; also invalidated by PlainTextSync's
        // external rebuild path.
        const blurSelectionRef = useRef<LexicalSelectionOffsets | null>(null);

        // Incremented by imperative caret APIs so a deferred repair scheduled
        // by an earlier text update cannot overwrite an intentional selection.
        const selectionRepairGenerationRef = useRef(0);

        // This editor's IME composition state. Every plugin that writes the
        // selection or rewrites nodes consults it, so all of them see the same
        // view of the composition (see ImeCompositionTracker).
        const imeRef = useRef<ImeCompositionTracker | null>(null);
        if (imeRef.current === null) imeRef.current = createImeCompositionTracker();
        const ime = imeRef.current;

        // Set by PlainTextSync, read by the imperative handle: reaches text
        // still withheld for a composition (see flushPendingText /
        // discardPendingText).
        const pendingTextRef = useRef<PendingTextControls | null>(null);

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

        // Expose the placeholder to screen readers
        useEffect(() => {
            const el = contentEditableRef.current;
            if (!el) return;
            if (placeholder) el.setAttribute('aria-placeholder', placeholder);
            else el.removeAttribute('aria-placeholder');
        }, [placeholder]);

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
                            ErrorBoundary={LexicalErrorBoundary}
                        />
                        {/* Stays mounted for the editor's whole lifetime and is
                            hidden with CSS - see PlaceholderVisibilityPlugin.
                            The text lives in an attribute so the placeholder
                            holds no text node that could change either. */}
                        <div
                            className="beaver-lexical-placeholder"
                            aria-hidden="true"
                            data-placeholder={placeholder ?? ''}
                        />
                    </div>
                    <HistoryPlugin />
                    <ImeCompositionTrackerPlugin ime={ime} />
                    <PlainTextSync value={value} onChange={onChange} pills={pills} onPillsChange={onPillsChange} blurSelectionRef={blurSelectionRef} ime={ime} pendingTextRef={pendingTextRef} />
                    <SlashCommandRevertPlugin ime={ime} />
                    <TypeOverSelectionPlugin ime={ime} />
                    <ArgumentHintPlugin />
                    <PlaceholderVisibilityPlugin />
                    <CaretNavigationPlugin suspendedRef={suspendNavRef} pendingDomSelectionRef={pendingDomSelectionRef} ime={ime} />
                    <SelectionGuardPlugin pendingDomSelectionRef={pendingDomSelectionRef} ime={ime} />
                    <SelectionPersistencePlugin ime={ime} />
                    <EmptyEditorInsertionPlugin ime={ime} />
                    <DeferredSelectionRepairPlugin selectionRepairGenerationRef={selectionRepairGenerationRef} ime={ime} />
                    <BlurSelectionSnapshotPlugin blurSelectionRef={blurSelectionRef} />
                    <PinnedEndCaretPlugin pinnedRef={pinnedEndCaretRef} ime={ime} />
                    <SlashCommandClickPlugin />
                    <SlashCommandHoverCardPlugin />
                    <SubmitOnEnterPlugin onSubmit={onSubmit} />
                    <ClipboardAttachmentPlugin handlers={pasteHandlers} ime={ime} />
                    <WindowsImeCompositionOrderPlugin />
                    <ImeTracePlugin ime={ime} />
                    <EditorApi
                        ref={ref}
                        pinnedEndCaretRef={pinnedEndCaretRef}
                        blurSelectionRef={blurSelectionRef}
                        selectionRepairGenerationRef={selectionRepairGenerationRef}
                        pendingTextRef={pendingTextRef}
                    />
                </div>
            </LexicalComposer>
        );
    },
);
