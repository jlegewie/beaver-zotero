import {
    $applyNodeReplacement,
    EditorConfig,
    LexicalNode,
    NodeKey,
    SerializedTextNode,
    Spread,
    TextNode,
} from 'lexical';

export type SerializedSlashCommandNode = Spread<
    {
        commandName: string;
    },
    SerializedTextNode
>;

/**
 * Inline TextNode subclass used to render /slash commands as a styled pill.
 *
 * Implemented as a token-mode TextNode rather than a DecoratorNode so that:
 *   - the displayed text is exactly what is stored in the editor (WYSIWYG),
 *   - it behaves as a single atomic unit (one backspace deletes the whole pill),
 *   - keyboard users and screen readers still see/hear the command text.
 *
 * The visual (background color, padding, etc.) is applied via the CSS class
 * "beaver-slash-command" below - kept purely visual on purpose.
 */
export class SlashCommandNode extends TextNode {
    __commandName: string;

    static getType(): string {
        return 'beaver-slash-command';
    }

    static clone(node: SlashCommandNode): SlashCommandNode {
        return new SlashCommandNode(node.__commandName, node.__text, node.__key);
    }

    constructor(commandName: string, text?: string, key?: NodeKey) {
        // Display the "/name" literal in the text so screen readers still hear it
        super(text ?? `/${commandName}`, key);
        this.__commandName = commandName;
        // Token mode = atomic deletion, no mid-node editing
        this.setMode('token');
    }

    static importJSON(serializedNode: SerializedSlashCommandNode): SlashCommandNode {
        const node = $createSlashCommandNode(serializedNode.commandName);
        node.setFormat(serializedNode.format);
        node.setDetail(serializedNode.detail);
        node.setMode(serializedNode.mode);
        node.setStyle(serializedNode.style);
        return node;
    }

    exportJSON(): SerializedSlashCommandNode {
        return {
            ...super.exportJSON(),
            type: SlashCommandNode.getType(),
            version: 1,
            commandName: this.__commandName,
        };
    }

    createDOM(config: EditorConfig): HTMLElement {
        const dom = super.createDOM(config);
        dom.classList.add('beaver-slash-command');
        dom.setAttribute('data-lexical-slash', 'true');
        dom.setAttribute('data-command', this.__commandName);
        return dom;
    }

    updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
        const updated = super.updateDOM(prevNode, dom, config);
        if (prevNode.__commandName !== this.__commandName) {
            dom.setAttribute('data-command', this.__commandName);
        }
        return updated;
    }

    getCommandName(): string {
        return this.__commandName;
    }

    // Slash pills should never split into two text nodes on typing
    canInsertTextBefore(): boolean {
        return false;
    }

    canInsertTextAfter(): boolean {
        return false;
    }

    isTextEntity(): true {
        return true;
    }
}

export function $createSlashCommandNode(commandName: string): SlashCommandNode {
    return $applyNodeReplacement(new SlashCommandNode(commandName));
}

export function $isSlashCommandNode(
    node: LexicalNode | null | undefined,
): node is SlashCommandNode {
    return node instanceof SlashCommandNode;
}
