// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LexicalEditorInputHandle } from '../../../react/components/input/lexical/LexicalEditorInput';

vi.mock('../../../react/components/input/lexical/SlashCommandHoverCardPlugin', () => ({
    SlashCommandHoverCardPlugin: () => null,
}));

type SavedDescriptor = {
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
};

describe('Lexical selection stability', () => {
    let container: HTMLDivElement | null = null;
    let reactRoot: ReturnType<typeof createRoot> | null = null;
    let documentFocused = true;
    let savedDescriptors: SavedDescriptor[] = [];

    const patchProperty = (target: object, key: PropertyKey, value: unknown) => {
        savedDescriptors.push({
            target,
            key,
            descriptor: Object.getOwnPropertyDescriptor(target, key),
        });
        Object.defineProperty(target, key, {
            configurable: true,
            value,
        });
    };

    const restorePatchedProperties = () => {
        for (const { target, key, descriptor } of savedDescriptors.reverse()) {
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else Reflect.deleteProperty(target, key);
        }
        savedDescriptors = [];
    };

    beforeEach(() => {
        documentFocused = true;
        patchProperty(
            globalThis,
            'IS_REACT_ACT_ENVIRONMENT',
            true,
        );
        // Lexical enables BEFORE_INPUT_COMMAND only when getTargetRanges is
        // available. Gecko provides it; jsdom needs this capability shim.
        patchProperty(InputEvent.prototype, 'getTargetRanges', () => []);
        patchProperty(Node.prototype, 'getBoundingClientRect', () => new DOMRect());
        patchProperty(Range.prototype, 'getBoundingClientRect', () => new DOMRect());
        patchProperty(Document.prototype, 'hasFocus', () => documentFocused);
    });

    afterEach(async () => {
        if (reactRoot) {
            await act(async () => reactRoot?.unmount());
        }
        container?.remove();
        container = null;
        reactRoot = null;
        restorePatchedProperties();
    });

    const mountEmptyEditor = async () => {
        const testDocument = globalThis.document;
        const { LexicalEditorInput } = await import(
            '../../../react/components/input/lexical/LexicalEditorInput'
        );
        const editorHandle = React.createRef<LexicalEditorInputHandle>();

        container = testDocument.createElement('div');
        testDocument.body.append(container);
        reactRoot = createRoot(container);

        function Harness() {
            const [value, setValue] = useState('');
            return React.createElement(LexicalEditorInput, {
                ref: editorHandle,
                value,
                onChange: setValue,
                onSubmit: () => {},
                placeholder: 'Message Beaver',
            });
        }

        await act(async () => reactRoot?.render(React.createElement(Harness)));
        const editable = container.querySelector<HTMLElement>('.beaver-lexical-content');
        expect(editable).not.toBeNull();
        editable!.focus();
        const nativeSelection = globalThis.window.getSelection();
        expect(nativeSelection).not.toBeNull();
        return { editable: editable!, editorHandle, nativeSelection: nativeSelection! };
    };

    const insertFirstCharacter = async (editable: HTMLElement) => {
        const beforeInput = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            data: 'a',
            inputType: 'insertText',
        });
        editable.dispatchEvent(beforeInput);
        expect(beforeInput.defaultPrevented).toBe(true);
        // Lexical commits the controlled insertion in a microtask; do not
        // advance timers yet because the repair intentionally runs later.
        await Promise.resolve();
        await Promise.resolve();
        expect(editable.textContent, editable.innerHTML).toBe('a');
    };

    const collapseCaretToStart = (
        editable: HTMLElement,
        nativeSelection: Selection,
    ) => {
        const text = globalThis.document.createTreeWalker(
            editable,
            NodeFilter.SHOW_TEXT,
        ).nextNode();
        expect(text?.nodeType).toBe(Node.TEXT_NODE);
        nativeSelection.setBaseAndExtent(text!, 0, text!, 0);
        globalThis.document.dispatchEvent(new Event('selectionchange'));
    };

    const waitForDeferredRepair = () =>
        new Promise(resolve => globalThis.window.setTimeout(resolve, 0));

    const expectCaretOffset = (nativeSelection: Selection, offset: number) => {
        expect(nativeSelection.anchorNode?.nodeValue).toBe('a');
        expect(nativeSelection.anchorOffset).toBe(offset);
        expect(nativeSelection.focusOffset).toBe(offset);
    };

    it('repairs a late caret collapse after the first character', async () => {
        const { editable, nativeSelection } = await mountEmptyEditor();

        globalThis.window.dispatchEvent(new FocusEvent('blur'));
        nativeSelection.setBaseAndExtent(editable, 0, editable, 0);
        globalThis.document.dispatchEvent(new Event('selectionchange'));
        globalThis.window.dispatchEvent(new FocusEvent('focus'));

        await act(async () => {
            await insertFirstCharacter(editable);
            collapseCaretToStart(editable, nativeSelection);
            await waitForDeferredRepair();
        });

        expectCaretOffset(nativeSelection, 1);
    });

    it('repairs the same first-character collapse without window reactivation', async () => {
        const { editable, nativeSelection } = await mountEmptyEditor();

        await act(async () => {
            await insertFirstCharacter(editable);
            collapseCaretToStart(editable, nativeSelection);
            await waitForDeferredRepair();
        });

        expectCaretOffset(nativeSelection, 1);
    });

    it('does not repair text updates in a background document', async () => {
        const { editable, nativeSelection } = await mountEmptyEditor();
        // activeElement remains the editor even though its window is no longer
        // focused, matching the separate-window/sidebar sync case.
        documentFocused = false;

        await act(async () => {
            await insertFirstCharacter(editable);
            collapseCaretToStart(editable, nativeSelection);
            await waitForDeferredRepair();
        });

        expectCaretOffset(nativeSelection, 0);
    });

    it('does not override an explicit programmatic caret placement', async () => {
        const { editable, editorHandle, nativeSelection } = await mountEmptyEditor();

        await act(async () => {
            await insertFirstCharacter(editable);
            editorHandle.current?.selectRange(0, 0);
            await Promise.resolve();
            await waitForDeferredRepair();
        });

        expectCaretOffset(nativeSelection, 0);
    });
});
