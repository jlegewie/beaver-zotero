// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/components/input/lexical/SlashCommandHoverCardPlugin', () => ({
    SlashCommandHoverCardPlugin: () => null,
}));

describe('Lexical window reactivation', () => {
    let container: HTMLDivElement | null = null;
    let reactRoot: ReturnType<typeof createRoot> | null = null;

    afterEach(async () => {
        if (reactRoot) {
            await act(async () => reactRoot?.unmount());
        }
        container?.remove();
        container = null;
        reactRoot = null;
    });

    it('repairs a late caret collapse after the first character', async () => {
        const testWindow = globalThis.window;
        const testDocument = globalThis.document;
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
            .IS_REACT_ACT_ENVIRONMENT = true;
        // Lexical enables BEFORE_INPUT_COMMAND only when getTargetRanges is
        // available. Gecko provides it; jsdom needs the capability shim before
        // Lexical is imported.
        if (!('getTargetRanges' in InputEvent.prototype)) {
            Object.defineProperty(InputEvent.prototype, 'getTargetRanges', {
                configurable: true,
                value: () => [],
            });
        }
        Object.defineProperty(Node.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: () => new DOMRect(),
        });
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: () => new DOMRect(),
        });
        const { LexicalEditorInput } = await import(
            '../../../react/components/input/lexical/LexicalEditorInput'
        );

        container = testDocument.createElement('div');
        testDocument.body.append(container);
        reactRoot = createRoot(container);

        function Harness() {
            const [value, setValue] = useState('');
            return React.createElement(LexicalEditorInput, {
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

        testWindow.dispatchEvent(new FocusEvent('blur'));
        const nativeSelection = testWindow.getSelection();
        expect(nativeSelection).not.toBeNull();
        nativeSelection!.setBaseAndExtent(editable!, 0, editable!, 0);
        testDocument.dispatchEvent(new Event('selectionchange'));
        testWindow.dispatchEvent(new FocusEvent('focus'));

        await act(async () => {
            const beforeInput = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                data: 'a',
                inputType: 'insertText',
            });
            editable!.dispatchEvent(beforeInput);
            expect(beforeInput.defaultPrevented).toBe(true);
            // Lexical commits the controlled insertion in a microtask; do not
            // advance timers yet because the repair intentionally runs later.
            await Promise.resolve();
            await Promise.resolve();
            expect(editable!.textContent, editable!.innerHTML).toBe('a');

            // Reproduce the late chrome-document collapse that arrives after
            // the first insertion/placeholder update.
            const text = testDocument.createTreeWalker(
                editable!,
                NodeFilter.SHOW_TEXT,
            ).nextNode();
            expect(text?.nodeType).toBe(Node.TEXT_NODE);
            nativeSelection!.setBaseAndExtent(text!, 0, text!, 0);
            testDocument.dispatchEvent(new Event('selectionchange'));
            await new Promise(resolve => testWindow.setTimeout(resolve, 0));
        });

        expect(editable!.textContent).toBe('a');
        expect(nativeSelection!.anchorNode?.nodeValue).toBe('a');
        expect(nativeSelection!.anchorOffset).toBe(1);
        expect(nativeSelection!.focusOffset).toBe(1);
    });
});
