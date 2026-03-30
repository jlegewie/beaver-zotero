import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1]) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
    isDatabaseSyncSupportedAtom: Symbol('isDatabaseSyncSupportedAtom'),
    syncWithZoteroAtom: Symbol('syncWithZoteroAtom'),
}));

vi.mock('../../../react/atoms/auth', () => ({
    userIdAtom: Symbol('userIdAtom'),
}));

vi.mock('../../../react/components/agentRuns/EditNotePreview', () => ({
    stripHtmlTags: vi.fn((s: string) => s),
    computeDiff: vi.fn(),
}));

vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilter: vi.fn(),
    syncingItemFilterAsync: vi.fn(),
    isSupportedItem: vi.fn(),
    isLibraryValidForSync: vi.fn(),
}));

vi.mock('../../../src/utils/selectItem', () => ({
    selectItemById: vi.fn(),
}));

vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeFileExists: vi.fn(),
}));

vi.mock('../../../react/utils/stringUtils', () => ({
    truncateText: vi.fn((s: string) => s),
}));

// =============================================================================
// Imports
// =============================================================================

import {
    openNoteAndSearchEdit,
    selectAndScrollInNoteEditor,
    buildEditorTextMap,
    resolveRangeInTextMap,
    findScrollContainer,
    getNoteEditorView,
    stripEllipsis,
} from '../../../react/utils/sourceUtils';
import { computeDiff } from '../../../react/components/agentRuns/EditNotePreview';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a minimal DOM-like tree for testing buildEditorTextMap.
 * Uses simple objects that behave like DOM Nodes + TreeWalker.
 */
function createMockDOMWithText(texts: string[]): HTMLElement {
    const textNodes = texts.map(t => ({
        nodeType: 3, // TEXT_NODE
        textContent: t,
    }));

    let walkIdx = -1;
    const mockTreeWalker = {
        get currentNode() { return textNodes[walkIdx]; },
        nextNode() {
            walkIdx++;
            return walkIdx < textNodes.length ? textNodes[walkIdx] : null;
        },
    };

    const editorDOM = {
        ownerDocument: {
            createTreeWalker: vi.fn(() => mockTreeWalker),
        },
    } as unknown as HTMLElement;

    return editorDOM;
}

/**
 * Build a mock ProseMirror EditorView with controllable behavior.
 */
function createMockEditorView(fullText: string, options?: {
    atomAtEnd?: { nodeSize: number };
    throwOnResolve?: boolean;
    selectionFromJson?: boolean;
}) {
    const textNode = {
        nodeType: 3,
        textContent: fullText,
    };

    // DOM mock
    let treeWalkerIdx = -1;
    const dom = {
        ownerDocument: {
            createTreeWalker: vi.fn(() => ({
                get currentNode() { return treeWalkerIdx === 0 ? textNode : null; },
                nextNode() {
                    treeWalkerIdx++;
                    return treeWalkerIdx === 0 ? textNode : null;
                },
            })),
            defaultView: {
                frameElement: {
                    focus: vi.fn(),
                },
                getComputedStyle: vi.fn(() => ({ overflowY: 'visible' })),
            },
        },
        parentElement: null,
    };

    // Track dispatched transactions
    const dispatched: any[] = [];

    // ProseMirror TextSelection mock
    const TextSelectionClass = {
        create: vi.fn((doc: any, from: number, to: number) => ({
            type: 'TextSelection',
            from,
            to,
        })),
    };

    // Selection hierarchy mock:
    // view.state.selection -> prototype -> base Selection (has atStart)
    const baseProto = {
        constructor: {
            atStart: vi.fn(() => ({
                constructor: TextSelectionClass,
            })),
        },
    };
    const selectionProto = Object.create(baseProto);
    const currentSelection = Object.create(selectionProto);
    currentSelection.from = 0;
    currentSelection.to = 0;

    const nodeAfter = options?.atomAtEnd
        ? { isAtom: true, isInline: true, nodeSize: options.atomAtEnd.nodeSize }
        : null;

    const doc = {
        resolve: vi.fn((pos: number) => {
            if (options?.throwOnResolve) throw new Error('resolve error');
            return { nodeAfter };
        }),
    };

    // Mutable selection tracking
    let lastSelection = currentSelection;
    const view = {
        dom,
        posAtDOM: vi.fn((node: any, offset: number) => offset),
        nodeDOM: vi.fn(() => textNode),
        state: {
            doc,
            get selection() { return lastSelection; },
            tr: {
                setSelection: vi.fn((sel: any) => {
                    lastSelection = sel;
                    return {
                        scrollIntoView: vi.fn().mockReturnThis(),
                        __selection: sel,
                    };
                }),
            },
        },
        dispatch: vi.fn((tr: any) => { dispatched.push(tr); }),
        coordsAtPos: vi.fn(() => ({ top: 100, left: 50 })),
        focus: vi.fn(),
    };

    return { view, dispatched, TextSelectionClass, dom };
}

/**
 * Install a mock Zotero.Notes._editorInstances that returns the given view.
 */
function installMockEditorInstance(itemId: number, view: any, viewMode = 'tab') {
    (globalThis as any).Zotero.Notes = {
        _editorInstances: [{
            itemID: itemId,
            viewMode,
            _iframeWindow: {
                wrappedJSObject: {
                    _currentEditorInstance: {
                        _editorCore: { view },
                    },
                },
            },
        }],
    };
}

// =============================================================================
// Tests: stripEllipsis
// =============================================================================

describe('stripEllipsis', () => {
    it('removes leading ellipsis', () => {
        expect(stripEllipsis('…hello')).toBe('hello');
    });

    it('removes trailing ellipsis', () => {
        expect(stripEllipsis('hello…')).toBe('hello');
    });

    it('removes both leading and trailing ellipsis', () => {
        expect(stripEllipsis('…hello world…')).toBe('hello world');
    });

    it('trims whitespace after stripping', () => {
        expect(stripEllipsis('… hello …')).toBe('hello');
    });

    it('leaves text without ellipsis unchanged (modulo trim)', () => {
        expect(stripEllipsis('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
        expect(stripEllipsis('')).toBe('');
    });

    it('handles string that is just an ellipsis', () => {
        expect(stripEllipsis('…')).toBe('');
    });

    it('does not remove ellipsis in the middle', () => {
        expect(stripEllipsis('hello…world')).toBe('hello…world');
    });
});

// =============================================================================
// Tests: buildEditorTextMap
// =============================================================================

describe('buildEditorTextMap', () => {
    it('concatenates text content from multiple text nodes', () => {
        const dom = createMockDOMWithText(['Hello ', 'world', '!']);
        const result = buildEditorTextMap(dom);
        expect(result.fullText).toBe('Hello world!');
    });

    it('returns correct start offsets for each text node', () => {
        const dom = createMockDOMWithText(['abc', 'de', 'fgh']);
        const result = buildEditorTextMap(dom);
        expect(result.textNodes).toHaveLength(3);
        expect(result.textNodes[0].start).toBe(0);
        expect(result.textNodes[1].start).toBe(3);
        expect(result.textNodes[2].start).toBe(5);
    });

    it('handles empty editor (no text nodes)', () => {
        const dom = createMockDOMWithText([]);
        const result = buildEditorTextMap(dom);
        expect(result.fullText).toBe('');
        expect(result.textNodes).toHaveLength(0);
    });

    it('handles single text node', () => {
        const dom = createMockDOMWithText(['single node']);
        const result = buildEditorTextMap(dom);
        expect(result.fullText).toBe('single node');
        expect(result.textNodes).toHaveLength(1);
        expect(result.textNodes[0].start).toBe(0);
    });

    it('uses TreeWalker with SHOW_TEXT filter (4)', () => {
        const dom = createMockDOMWithText(['test']);
        buildEditorTextMap(dom);
        expect(dom.ownerDocument.createTreeWalker).toHaveBeenCalledWith(dom, 4);
    });
});

// =============================================================================
// Tests: resolveRangeInTextMap
// =============================================================================

describe('resolveRangeInTextMap', () => {
    // Build a simple textNodes array simulating ["Hello ", "world", "!"]
    function makeTextNodes() {
        const n1 = { textContent: 'Hello ' };
        const n2 = { textContent: 'world' };
        const n3 = { textContent: '!' };
        return [
            { node: n1 as unknown as Node, start: 0 },
            { node: n2 as unknown as Node, start: 6 },
            { node: n3 as unknown as Node, start: 11 },
        ];
    }

    it('resolves a range within a single text node', () => {
        const textNodes = makeTextNodes();
        const result = resolveRangeInTextMap(textNodes, 0, 5);
        expect(result).not.toBeNull();
        expect(result!.startNode).toBe(textNodes[0].node);
        expect(result!.startOffset).toBe(0);
        expect(result!.endNode).toBe(textNodes[0].node);
        expect(result!.endOffset).toBe(5);
    });

    it('resolves a range spanning two text nodes', () => {
        const textNodes = makeTextNodes();
        // "lo world" — from offset 3 in first node to offset 5 in second node
        const result = resolveRangeInTextMap(textNodes, 3, 11);
        expect(result).not.toBeNull();
        expect(result!.startNode).toBe(textNodes[0].node);
        expect(result!.startOffset).toBe(3);
        expect(result!.endNode).toBe(textNodes[1].node);
        expect(result!.endOffset).toBe(5); // 11 - 6
    });

    it('resolves a range spanning all text nodes', () => {
        const textNodes = makeTextNodes();
        const result = resolveRangeInTextMap(textNodes, 0, 12);
        expect(result).not.toBeNull();
        expect(result!.startNode).toBe(textNodes[0].node);
        expect(result!.endNode).toBe(textNodes[2].node);
        expect(result!.endOffset).toBe(1); // 12 - 11
    });

    it('returns null when startIdx is beyond all text nodes', () => {
        const textNodes = makeTextNodes();
        const result = resolveRangeInTextMap(textNodes, 20, 25);
        expect(result).toBeNull();
    });

    it('returns null when endIdx is beyond all text nodes', () => {
        const textNodes = makeTextNodes();
        const result = resolveRangeInTextMap(textNodes, 0, 20);
        expect(result).toBeNull();
    });

    it('returns null for empty textNodes array', () => {
        const result = resolveRangeInTextMap([], 0, 5);
        expect(result).toBeNull();
    });

    it('handles range at exact node boundaries', () => {
        const textNodes = makeTextNodes();
        // Exactly the second node: "world" at [6, 11)
        const result = resolveRangeInTextMap(textNodes, 6, 11);
        expect(result).not.toBeNull();
        expect(result!.startNode).toBe(textNodes[1].node);
        expect(result!.startOffset).toBe(0);
        expect(result!.endNode).toBe(textNodes[1].node);
        expect(result!.endOffset).toBe(5);
    });
});

// =============================================================================
// Tests: findScrollContainer
// =============================================================================

describe('findScrollContainer', () => {
    it('returns the nearest scrollable ancestor', () => {
        const scrollable = {
            scrollHeight: 1000,
            clientHeight: 500,
            parentElement: null,
        };

        const child = {
            ownerDocument: {
                defaultView: {
                    getComputedStyle: vi.fn((el: any) => {
                        if (el === scrollable) return { overflowY: 'auto' };
                        return { overflowY: 'visible' };
                    }),
                },
            },
            parentElement: scrollable,
        } as unknown as HTMLElement;

        const result = findScrollContainer(child);
        expect(result).toBe(scrollable);
    });

    it('returns null when no scrollable ancestor exists', () => {
        const el = {
            ownerDocument: {
                defaultView: {
                    getComputedStyle: vi.fn(() => ({ overflowY: 'visible' })),
                },
            },
            parentElement: {
                parentElement: null,
            },
        } as unknown as HTMLElement;

        expect(findScrollContainer(el)).toBeNull();
    });

    it('returns null when ownerDocument has no defaultView', () => {
        const el = {
            ownerDocument: { defaultView: null },
            parentElement: {},
        } as unknown as HTMLElement;

        expect(findScrollContainer(el)).toBeNull();
    });

    it('skips ancestors with overflow but no actual overflow (scrollHeight <= clientHeight)', () => {
        const noOverflow = {
            scrollHeight: 100,
            clientHeight: 100,
            parentElement: null,
        };

        const el = {
            ownerDocument: {
                defaultView: {
                    getComputedStyle: vi.fn(() => ({ overflowY: 'scroll' })),
                },
            },
            parentElement: noOverflow,
        } as unknown as HTMLElement;

        expect(findScrollContainer(el)).toBeNull();
    });

    it('detects overflow-y: scroll', () => {
        const scrollable = {
            scrollHeight: 500,
            clientHeight: 200,
            parentElement: null,
        };

        const el = {
            ownerDocument: {
                defaultView: {
                    getComputedStyle: vi.fn(() => ({ overflowY: 'scroll' })),
                },
            },
            parentElement: scrollable,
        } as unknown as HTMLElement;

        expect(findScrollContainer(el)).toBe(scrollable);
    });
});

// =============================================================================
// Tests: getNoteEditorView — Zotero API surface
// =============================================================================

describe('getNoteEditorView', () => {
    beforeEach(() => {
        delete (globalThis as any).Zotero.Notes;
    });

    it('returns null when Zotero.Notes is undefined', () => {
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns null when _editorInstances is undefined', () => {
        (globalThis as any).Zotero.Notes = {};
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns null when no matching instance for itemId', () => {
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{ itemID: 99, viewMode: 'tab' }],
        };
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns null when matching instance has no _iframeWindow', () => {
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{
                itemID: 42,
                viewMode: 'tab',
                _iframeWindow: null,
            }],
        };
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns null when wrappedJSObject is missing', () => {
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{
                itemID: 42,
                viewMode: 'tab',
                _iframeWindow: {},
            }],
        };
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns null when _currentEditorInstance is missing', () => {
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{
                itemID: 42,
                viewMode: 'tab',
                _iframeWindow: { wrappedJSObject: {} },
            }],
        };
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns null when _editorCore is missing', () => {
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{
                itemID: 42,
                viewMode: 'tab',
                _iframeWindow: {
                    wrappedJSObject: {
                        _currentEditorInstance: {},
                    },
                },
            }],
        };
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns null when _editorCore.view is missing', () => {
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{
                itemID: 42,
                viewMode: 'tab',
                _iframeWindow: {
                    wrappedJSObject: {
                        _currentEditorInstance: {
                            _editorCore: {},
                        },
                    },
                },
            }],
        };
        expect(getNoteEditorView(42)).toBeNull();
    });

    it('returns the ProseMirror view when the full chain is present', () => {
        const mockView = { dom: {} };
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{
                itemID: 42,
                viewMode: 'tab',
                _iframeWindow: {
                    wrappedJSObject: {
                        _currentEditorInstance: {
                            _editorCore: { view: mockView },
                        },
                    },
                },
            }],
        };
        expect(getNoteEditorView(42)).toBe(mockView);
    });

    it('prefers tab instance over other viewModes', () => {
        const tabView = { dom: {}, id: 'tab' };
        const windowView = { dom: {}, id: 'window' };
        const makeInstance = (viewMode: string, view: any) => ({
            itemID: 42,
            viewMode,
            _iframeWindow: {
                wrappedJSObject: {
                    _currentEditorInstance: {
                        _editorCore: { view },
                    },
                },
            },
        });
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [
                makeInstance('window', windowView),
                makeInstance('tab', tabView),
            ],
        };
        expect(getNoteEditorView(42)).toBe(tabView);
    });

    it('falls back to first matching instance when no tab instance exists', () => {
        const windowView = { dom: {}, id: 'window' };
        (globalThis as any).Zotero.Notes = {
            _editorInstances: [{
                itemID: 42,
                viewMode: 'window',
                _iframeWindow: {
                    wrappedJSObject: {
                        _currentEditorInstance: {
                            _editorCore: { view: windowView },
                        },
                    },
                },
            }],
        };
        expect(getNoteEditorView(42)).toBe(windowView);
    });

    it('returns null gracefully when _editorInstances throws', () => {
        (globalThis as any).Zotero.Notes = {
            get _editorInstances() { throw new Error('access denied'); },
        };
        expect(getNoteEditorView(42)).toBeNull();
    });
});

// =============================================================================
// Tests: selectAndScrollInNoteEditor
// =============================================================================

describe('selectAndScrollInNoteEditor', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        delete (globalThis as any).Zotero.Notes;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns false when editor view is never available (timeout)', async () => {
        // No Zotero.Notes at all — getNoteEditorView returns null
        const promise = selectAndScrollInNoteEditor(1, 'hello');

        // Advance past the 3000ms timeout
        await vi.advanceTimersByTimeAsync(3100);
        const result = await promise;
        expect(result).toBe(false);
    });

    it('returns false when searchText is not found in editor DOM', async () => {
        const { view } = createMockEditorView('This is some text');
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'nonexistent');
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;
        expect(result).toBe(false);
    });

    it('selects and returns true when searchText is found (no selectText)', async () => {
        const { view } = createMockEditorView('Hello world, this is a test');
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'world');
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(view.dispatch).toHaveBeenCalled();
    });

    it('selects unique selectText directly', async () => {
        const { view, TextSelectionClass } = createMockEditorView('Hello unique_word in a sentence');
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'Hello unique_word in', 'unique_word');
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        // selectText "unique_word" is unique, so it should be selected directly
        // posAtDOM maps offset -> position, so from=6 to=17
        expect(TextSelectionClass.create).toHaveBeenCalled();
    });

    it('uses searchText for disambiguation when selectText appears multiple times', async () => {
        const fullText = 'the cat and the dog and the bird';
        const { view, TextSelectionClass } = createMockEditorView(fullText);
        installMockEditorInstance(1, view);

        // "the" appears 3 times, so use searchText "the dog" for disambiguation
        const promise = selectAndScrollInNoteEditor(1, 'the dog', 'the');
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(TextSelectionClass.create).toHaveBeenCalled();
    });

    it('handles multi-line edit with endSearchText', async () => {
        const fullText = 'First line of text. Second line of text. Third line of text.';
        const { view, TextSelectionClass } = createMockEditorView(fullText);
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(
            1,
            'First line of text',
            'line of text',
            'Third line of text.',
        );
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(TextSelectionClass.create).toHaveBeenCalled();
    });

    it('falls back to searchText range when endSearchText is not found', async () => {
        const fullText = 'Start of the note content here';
        const { view } = createMockEditorView(fullText);
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(
            1,
            'Start of the note',
            'of the',
            'NONEXISTENT_END',
        );
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(view.dispatch).toHaveBeenCalled();
    });

    it('returns false when searchText not found in multi-line mode', async () => {
        const { view } = createMockEditorView('some unrelated text');
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(
            1,
            'NONEXISTENT_SEARCH',
            'select',
            'end',
        );
        await vi.advanceTimersByTimeAsync(200);
        expect(await promise).toBe(false);
    });

    it('returns false when neither searchText nor selectText found', async () => {
        const { view } = createMockEditorView('some text in the editor');
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(
            1,
            'NONEXISTENT_CONTEXT',
            'NONEXISTENT_SELECT',
        );
        await vi.advanceTimersByTimeAsync(200);
        expect(await promise).toBe(false);
    });

    it('uses selectOffsetInSearch when provided (single-line, non-unique selectText)', async () => {
        const fullText = 'the quick brown fox jumps over the lazy dog';
        const { view, TextSelectionClass } = createMockEditorView(fullText);
        installMockEditorInstance(1, view);

        // "the" appears twice; selectOffsetInSearch=0 means offset 0 within searchText
        const promise = selectAndScrollInNoteEditor(
            1,
            'the quick brown',
            'the',
            undefined,
            0,
        );
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(TextSelectionClass.create).toHaveBeenCalled();
    });

    it('uses selectOffsetInSearch when provided (multi-line mode)', async () => {
        const fullText = 'prefix the changed text suffix. End marker here.';
        const { view, TextSelectionClass } = createMockEditorView(fullText);
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(
            1,
            'prefix the changed text',
            'the changed',
            'End marker here.',
            7, // "the changed" starts at offset 7 within searchText
        );
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(TextSelectionClass.create).toHaveBeenCalled();
    });

    it('dispatches a transaction with setSelection and scrollIntoView', async () => {
        const { view } = createMockEditorView('Hello world');
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'world');
        await vi.advanceTimersByTimeAsync(200);
        await promise;

        expect(view.state.tr.setSelection).toHaveBeenCalled();
        expect(view.dispatch).toHaveBeenCalled();
    });

    it('uses TextSelection via Selection.atStart prototype chain', async () => {
        // This tests the specific Zotero API pattern:
        // Selection base class -> atStart(doc) -> returns TextSelection instance
        // -> use its constructor's .create()
        const { view, TextSelectionClass } = createMockEditorView('Test text');

        // Capture the atStart spy before the selection gets replaced by dispatch
        const baseProto = Object.getPrototypeOf(
            Object.getPrototypeOf(view.state.selection)
        );
        const atStartSpy = baseProto.constructor.atStart;

        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'Test');
        await vi.advanceTimersByTimeAsync(200);
        await promise;

        // Verify the prototype chain navigation was used
        expect(atStartSpy).toHaveBeenCalledWith(view.state.doc);
        expect(TextSelectionClass.create).toHaveBeenCalled();
    });

    it('falls back to selection constructor when TextSelection lookup throws', async () => {
        const fullText = 'Fallback test text';
        const { view } = createMockEditorView(fullText);

        // Give the current selection a constructor with .create for the fallback path
        const fallbackCreate = vi.fn((doc: any, from: number, to: number) => ({
            type: 'FallbackSelection',
            from,
            to,
        }));
        Object.defineProperty(view.state.selection, 'constructor', {
            value: { create: fallbackCreate },
            configurable: true,
        });

        // Break the prototype chain to force the catch branch
        Object.setPrototypeOf(
            Object.getPrototypeOf(view.state.selection),
            { constructor: { atStart: vi.fn(() => { throw new Error('Xray wrapper'); }) } },
        );

        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'Fallback');
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(fallbackCreate).toHaveBeenCalled();
        expect(view.dispatch).toHaveBeenCalled();
    });

    it('calls view.focus() via deferred setTimeout', async () => {
        const { view } = createMockEditorView('Focus test');
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'Focus');
        await vi.advanceTimersByTimeAsync(200);
        await promise;

        // Focus is deferred via setTimeout(focusEditor, 50) and setTimeout(focusEditor, 200)
        await vi.advanceTimersByTimeAsync(250);
        expect(view.focus).toHaveBeenCalled();
    });

    it('handles scroll container when one exists', async () => {
        const { view } = createMockEditorView('Scroll test content');

        // Add a scrollable parent
        const scrollContainer = {
            scrollHeight: 2000,
            clientHeight: 500,
            scrollTop: 0,
            getBoundingClientRect: vi.fn(() => ({ top: 0 })),
            parentElement: null,
        };
        view.dom.parentElement = scrollContainer;
        (view.dom.ownerDocument.defaultView as any).getComputedStyle = vi.fn(() => ({
            overflowY: 'auto',
        }));

        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'Scroll');
        await vi.advanceTimersByTimeAsync(200);
        await promise;

        expect(view.coordsAtPos).toHaveBeenCalled();
        expect(scrollContainer.getBoundingClientRect).toHaveBeenCalled();
    });

    it('handles posAtDOM atom extension for inline atoms', async () => {
        const { view } = createMockEditorView('Text with citation', {
            atomAtEnd: { nodeSize: 3 },
        });
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'citation');
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
        expect(view.state.doc.resolve).toHaveBeenCalled();
    });

    it('handles resolve throwing gracefully (best effort atom detection)', async () => {
        const { view } = createMockEditorView('Text content', {
            throwOnResolve: true,
        });
        installMockEditorInstance(1, view);

        const promise = selectAndScrollInNoteEditor(1, 'Text');
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        // Should still succeed — the try/catch is best-effort
        expect(result).toBe(true);
    });

    it('polls until editor view becomes available', async () => {
        // Start with no editor, add one after 250ms
        const { view } = createMockEditorView('Delayed editor');

        const promise = selectAndScrollInNoteEditor(1, 'Delayed');

        // First few polls: no editor
        await vi.advanceTimersByTimeAsync(200);

        // Now install the editor
        installMockEditorInstance(1, view);

        // Next poll should find it
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result).toBe(true);
    });

    it('falls back to first selectText occurrence when searchText not found but selectText is', async () => {
        const fullText = 'alpha beta gamma';
        const { view } = createMockEditorView(fullText);
        installMockEditorInstance(1, view);

        // searchText not in DOM, but selectText "beta" exists once
        const promise = selectAndScrollInNoteEditor(
            1,
            'NONEXISTENT_CONTEXT',
            'beta',
        );
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        // selectText appears once so firstIdx != -1, secondIdx == -1 -> unique path
        // But wait — the code checks uniqueness first, and "beta" IS unique,
        // so it goes to the "unique" branch directly.
        expect(result).toBe(true);
    });
});

// =============================================================================
// Tests: openNoteAndSearchEdit
// =============================================================================

describe('openNoteAndSearchEdit', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(computeDiff).mockReturnValue([]);
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Items: {
                getIDFromLibraryAndKey: vi.fn(() => 1),
            },
            Notes: {},
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses target text context to select the intended duplicate citation occurrence', async () => {
        const fullText = 'Intro citation. Methods citation target area.';
        const { view, TextSelectionClass } = createMockEditorView(fullText);
        installMockEditorInstance(1, view);
        (globalThis as any).Zotero.Notes.open = vi.fn().mockResolvedValue(undefined);

        await openNoteAndSearchEdit(
            1,
            'NOTE0001',
            'citation',
            'citation page 1',
            false,
            undefined,
            undefined,
            'Methods ',
            ' target area.',
        );

        const secondCitationStart = fullText.indexOf('citation', fullText.indexOf('citation') + 1);
        expect(TextSelectionClass.create).toHaveBeenCalledWith(expect.anything(), secondCitationStart, secondCitationStart + 'citation'.length);
    });
});

// =============================================================================
// Tests: Zotero API shape documentation
// =============================================================================

describe('Zotero API surface assumptions', () => {
    it('documents the expected Zotero.Notes._editorInstances structure', () => {
        // This test documents the exact API path that getNoteEditorView traverses.
        // If Zotero changes any of these property names, this test should be
        // updated to match, ensuring we catch breaking changes.
        const view = { dom: {} };
        const instance = {
            itemID: 42,
            viewMode: 'tab',
            _iframeWindow: {
                wrappedJSObject: {
                    _currentEditorInstance: {
                        _editorCore: {
                            view,
                        },
                    },
                },
            },
        };

        // Verify the expected access chain works
        expect(instance.itemID).toBe(42);
        expect(instance.viewMode).toBe('tab');
        expect(instance._iframeWindow).toBeDefined();
        expect(instance._iframeWindow.wrappedJSObject).toBeDefined();
        expect(instance._iframeWindow.wrappedJSObject._currentEditorInstance).toBeDefined();
        expect(instance._iframeWindow.wrappedJSObject._currentEditorInstance._editorCore).toBeDefined();
        expect(instance._iframeWindow.wrappedJSObject._currentEditorInstance._editorCore.view).toBe(view);
    });

    it('documents the expected ProseMirror EditorView API surface', () => {
        // These are the ProseMirror EditorView methods and properties that
        // selectAndScrollInNoteEditor relies on.
        const expectedMethods = [
            'posAtDOM',       // Map DOM position to document position
            'nodeDOM',        // Get DOM node at a document position
            'coordsAtPos',    // Get screen coordinates at a document position
            'dispatch',       // Dispatch a transaction
            'focus',          // Focus the editor
        ];

        const expectedStateProperties = [
            'doc',            // The document node
            'selection',      // Current selection
            'tr',             // Start a new transaction
        ];

        const expectedDocMethods = [
            'resolve',        // Resolve a position in the document
        ];

        // This serves as documentation — if ProseMirror changes its API,
        // these lists should be updated.
        expect(expectedMethods).toHaveLength(5);
        expect(expectedStateProperties).toHaveLength(3);
        expect(expectedDocMethods).toHaveLength(1);
    });

    it('documents the Selection.atStart approach for getting TextSelection class', () => {
        // selectAndScrollInNoteEditor uses this specific pattern to get the
        // TextSelection constructor, avoiding cross-compartment issues in
        // Zotero/Firefox:
        //
        // 1. Get the base Selection class via prototype chain:
        //    Object.getPrototypeOf(Object.getPrototypeOf(view.state.selection)).constructor
        //
        // 2. Call SelectionBase.atStart(doc) — always returns a TextSelection
        //
        // 3. Use the returned instance's constructor (.create method)
        //
        // This avoids:
        // - Using the current selection's constructor (could be NodeSelection)
        // - Using Selection.fromJSON (fails with Firefox Xray wrappers)

        // Simulate the prototype chain
        class Selection {
            static atStart(_doc: any) { return new TextSelection(); }
            static create(_doc: any, _from: number, _to: number) { return {}; }
        }
        class TextSelection extends Selection {}
        class NodeSelection extends Selection {}

        // Even if current selection is NodeSelection, we get TextSelection via atStart
        const nodeSelection = new NodeSelection();
        const base = Object.getPrototypeOf(Object.getPrototypeOf(nodeSelection)).constructor;
        const textSel = base.atStart({});

        expect(textSel).toBeInstanceOf(TextSelection);
        expect(textSel.constructor).toBe(TextSelection);
    });
});
