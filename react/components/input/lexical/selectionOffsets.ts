import {
    $createRangeSelection,
    $getRoot,
    $getSelection,
    $isElementNode,
    $isRangeSelection,
    $isTextNode,
    $setSelection,
    type ElementNode,
    type LexicalNode,
    type PointType,
} from 'lexical';

export interface LexicalSelectionOffsets {
    anchor: number;
    focus: number;
    anchorType?: 'text' | 'element';
    focusType?: 'text' | 'element';
}

const DOUBLE_LINE_BREAK_LENGTH = 2;

function $elementPrefixSize(element: ElementNode, childCount: number): number {
    const children = element.getChildren();
    const limit = Math.max(0, Math.min(childCount, children.length));
    let size = 0;
    for (let i = 0; i < limit; i++) {
        const child = children[i];
        size += child.getTextContentSize();
        if ($isElementNode(child) && i !== children.length - 1 && !child.isInline()) {
            size += DOUBLE_LINE_BREAK_LENGTH;
        }
    }
    return size;
}

function $nodeFlatStart(node: LexicalNode): number | null {
    const root = $getRoot();
    let current: LexicalNode = node;
    let offset = 0;
    while (current !== root) {
        const parent = current.getParent();
        if (!parent || !$isElementNode(parent)) return null;
        offset += $elementPrefixSize(parent, current.getIndexWithinParent());
        current = parent;
    }
    return offset;
}

function $flatPointOffset(point: PointType): number | null {
    const node = point.getNode();
    const nodeStart = $nodeFlatStart(node);
    if (nodeStart === null) return null;
    if (point.type === 'text') {
        return nodeStart + Math.max(0, Math.min(point.offset, node.getTextContentSize()));
    }
    return nodeStart + $elementPrefixSize(point.getNode(), point.offset);
}

/**
 * Flatten the current Lexical selection using the same text model as
 * RootNode.getTextContent(), including line breaks between block elements.
 * Element-point endpoints are retained so an empty editor or blank-line caret
 * can be restored structurally instead of being reduced to a text-only range.
 */
export function $getFlatSelectionOffsets(): LexicalSelectionOffsets | null {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    const anchor = $flatPointOffset(selection.anchor);
    const focus = $flatPointOffset(selection.focus);
    if (anchor === null || focus === null) return null;
    return {
        anchor,
        focus,
        anchorType: selection.anchor.type,
        focusType: selection.focus.type,
    };
}

type FlatPointCandidate = {
    key: string;
    offset: number;
    type: 'text' | 'element';
};

type ElementPointCandidate = FlatPointCandidate & {
    depth: number;
};

function $findFlatPoint(
    targetOffset: number,
    preferredType?: 'text' | 'element',
): FlatPointCandidate | null {
    const root = $getRoot();
    const safeOffset = Math.max(0, Math.min(targetOffset, root.getTextContentSize()));
    let textCandidate: FlatPointCandidate | null = null;
    let elementCandidate: ElementPointCandidate | null = null;

    const considerElementCandidate = (candidate: ElementPointCandidate) => {
        if (!elementCandidate || candidate.depth > elementCandidate.depth) {
            elementCandidate = candidate;
        }
    };

    const visitElement = (element: ElementNode, start: number, depth: number) => {
        const children = element.getChildren();
        let running = start;
        if (running === safeOffset) {
            considerElementCandidate({
                key: element.getKey(),
                offset: 0,
                type: 'element',
                depth,
            });
        }
        children.forEach((child, index) => {
            if ($isTextNode(child)) {
                const end = running + child.getTextContentSize();
                if (safeOffset >= running && safeOffset <= end) {
                    textCandidate = {
                        key: child.getKey(),
                        offset: safeOffset - running,
                        type: 'text',
                    };
                }
            } else if ($isElementNode(child)) {
                visitElement(child, running, depth + 1);
            }

            running += child.getTextContentSize();
            if ($isElementNode(child) && index !== children.length - 1 && !child.isInline()) {
                running += DOUBLE_LINE_BREAK_LENGTH;
            }
            if (running === safeOffset) {
                considerElementCandidate({
                    key: element.getKey(),
                    offset: index + 1,
                    type: 'element',
                    depth,
                });
            }
        });
    };

    visitElement(root, 0, 0);
    if (preferredType === 'element' && elementCandidate) return elementCandidate;
    if (preferredType === 'text' && textCandidate) return textCandidate;
    return textCandidate ?? elementCandidate;
}

/** Restore flattened offsets while preserving direction and element points. */
export function $selectFlatSelection(selectionOffsets: LexicalSelectionOffsets): void {
    const existingSelection = $getSelection();
    const selection = $isRangeSelection(existingSelection)
        ? existingSelection
        : $createRangeSelection();
    if (selection !== existingSelection) {
        $setSelection(selection);
    }
    const anchor = $findFlatPoint(selectionOffsets.anchor, selectionOffsets.anchorType);
    const focus = $findFlatPoint(selectionOffsets.focus, selectionOffsets.focusType);
    if (!anchor || !focus) {
        $getRoot().selectEnd();
        return;
    }
    selection.anchor.set(anchor.key, anchor.offset, anchor.type);
    selection.focus.set(focus.key, focus.offset, focus.type);
}

export function $selectFlatRange(start: number, end: number): void {
    $selectFlatSelection({ anchor: start, focus: end });
}
