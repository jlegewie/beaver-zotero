import { describe, expect, it } from 'vitest';
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isRangeSelection,
    createEditor,
} from 'lexical';
import {
    $getFlatSelectionOffsets,
    $selectFlatSelection,
    type LexicalSelectionOffsets,
} from '../../../react/components/input/lexical/selectionOffsets';

function createTestEditor() {
    return createEditor({
        namespace: 'selection-offset-test',
        onError: (error) => {
            throw error;
        },
    });
}

describe('Lexical selection offsets', () => {
    it('restores the caret inside a completely empty editor', () => {
        const editor = createTestEditor();
        let captured: LexicalSelectionOffsets | null = null;
        let emptyParagraphKey = '';

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            emptyParagraphKey = paragraph.getKey();
            root.append(paragraph);
            paragraph.select(0, 0);
            captured = $getFlatSelectionOffsets();
        }, { discrete: true });

        expect(captured).toEqual({
            anchor: 0,
            focus: 0,
            anchorType: 'element',
            focusType: 'element',
        });

        editor.update(() => {
            // Reproduce Gecko's structurally different root-start collapse.
            $getRoot().select(0, 0);
            $selectFlatSelection(captured!);
            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if (!$isRangeSelection(selection)) return;
            expect(selection.anchor).toMatchObject({
                key: emptyParagraphKey,
                offset: 0,
                type: 'element',
            });
            expect(selection.focus).toMatchObject({
                key: emptyParagraphKey,
                offset: 0,
                type: 'element',
            });
        }, { discrete: true });
    });

    it('captures and restores text selection direction', () => {
        const editor = createTestEditor();
        let captured: LexicalSelectionOffsets | null = null;

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            const text = $createTextNode('hello');
            root.append($createParagraphNode().append(text));
            text.select(4, 1);
            captured = $getFlatSelectionOffsets();
        }, { discrete: true });

        expect(captured).toEqual({
            anchor: 4,
            focus: 1,
            anchorType: 'text',
            focusType: 'text',
        });

        editor.update(() => {
            $getRoot().selectStart();
            $selectFlatSelection(captured!);
            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if (!$isRangeSelection(selection)) return;
            expect(selection.anchor).toMatchObject({ offset: 4, type: 'text' });
            expect(selection.focus).toMatchObject({ offset: 1, type: 'text' });
        }, { discrete: true });
    });

    it('restores an element caret in a blank paragraph', () => {
        const editor = createTestEditor();
        let captured: LexicalSelectionOffsets | null = null;
        let blankParagraphKey = '';

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            const first = $createParagraphNode().append($createTextNode('first'));
            const blank = $createParagraphNode();
            const last = $createParagraphNode().append($createTextNode('last'));
            blankParagraphKey = blank.getKey();
            root.append(first, blank, last);
            blank.select(0, 0);
            captured = $getFlatSelectionOffsets();
        }, { discrete: true });

        expect(captured).toEqual({
            anchor: 7,
            focus: 7,
            anchorType: 'element',
            focusType: 'element',
        });

        editor.update(() => {
            $getRoot().selectStart();
            $selectFlatSelection(captured!);
            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if (!$isRangeSelection(selection)) return;
            expect(selection.anchor).toMatchObject({
                key: blankParagraphKey,
                offset: 0,
                type: 'element',
            });
        }, { discrete: true });
    });
});
