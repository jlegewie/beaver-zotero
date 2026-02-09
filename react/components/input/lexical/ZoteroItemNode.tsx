import React from 'react';
import {
    DecoratorNode,
    DOMExportOutput,
    LexicalNode,
    NodeKey,
    SerializedLexicalNode,
    Spread,
} from 'lexical';
import InlineZoteroChip from '../InlineZoteroChip';

export type SerializedZoteroItemNode = Spread<
    {
        libraryId: number;
        zoteroKey: string;
    },
    SerializedLexicalNode
>;

export class ZoteroItemNode extends DecoratorNode<React.JSX.Element> {
    __libraryId: number;
    __zoteroKey: string;

    static getType(): string {
        return 'zotero-item';
    }

    static clone(node: ZoteroItemNode): ZoteroItemNode {
        return new ZoteroItemNode(node.__libraryId, node.__zoteroKey, node.__key);
    }

    constructor(libraryId: number, zoteroKey: string, key?: NodeKey) {
        super(key);
        this.__libraryId = libraryId;
        this.__zoteroKey = zoteroKey;
    }

    createDOM(): HTMLElement {
        const span = document.createElement('span');
        return span;
    }

    updateDOM(): false {
        return false;
    }

    exportDOM(): DOMExportOutput {
        const element = document.createElement('span');
        element.textContent = `@${this.__libraryId}-${this.__zoteroKey}`;
        return { element };
    }

    static importJSON(serializedNode: SerializedZoteroItemNode): ZoteroItemNode {
        return $createZoteroItemNode(serializedNode.libraryId, serializedNode.zoteroKey);
    }

    exportJSON(): SerializedZoteroItemNode {
        return {
            type: 'zotero-item',
            version: 1,
            libraryId: this.__libraryId,
            zoteroKey: this.__zoteroKey,
        };
    }

    getTextContent(): string {
        return `@${this.__libraryId}-${this.__zoteroKey}`;
    }

    isInline(): boolean {
        return true;
    }

    decorate(): React.JSX.Element {
        return (
            <InlineZoteroChip
                libraryId={this.__libraryId}
                zoteroKey={this.__zoteroKey}
            />
        );
    }
}

export function $createZoteroItemNode(libraryId: number, zoteroKey: string): ZoteroItemNode {
    return new ZoteroItemNode(libraryId, zoteroKey);
}

export function $isZoteroItemNode(node: LexicalNode | null | undefined): node is ZoteroItemNode {
    return node instanceof ZoteroItemNode;
}
