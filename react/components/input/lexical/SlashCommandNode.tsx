import {
    $applyNodeReplacement,
    EditorConfig,
    LexicalNode,
    NodeKey,
    SerializedTextNode,
    Spread,
    TextNode,
} from 'lexical';
import { ActionTargetType } from '../../../types/actions';

export type SerializedSlashCommandNode = Spread<
    {
        commandName: string;
        actionId: string;
        targetType?: ActionTargetType;
        title?: string;
    },
    SerializedTextNode
>;

/**
 * Inline TextNode subclass used to render /slash commands as colored text.
 *
 * Implemented as a normal-mode TextNode (a "text entity", like a hashtag)
 * rather than a DecoratorNode so that:
 *   - the displayed text is exactly what is stored in the editor (WYSIWYG),
 *   - the caret can enter it and arrow keys move through it character by
 *     character - it behaves like ordinary text,
 *   - keyboard users and screen readers still see/hear the command text.
 *
 * `canInsertTextBefore`/`canInsertTextAfter` return false so that typing at the
 * command's boundaries spills into a sibling plain text node (the command keeps
 * its color) while typing *inside* mutates this node's text. A node transform
 * (SlashCommandRevertPlugin in LexicalEditorInput) watches for that mutation:
 * once the text no longer equals "/<commandName>" the node reverts to plain
 * text, so editing a command strips its color.
 *
 * The visual (background color, padding, etc.) is applied via the CSS class
 * "beaver-slash-command" below - kept purely visual on purpose.
 */
export class SlashCommandNode extends TextNode {
    __commandName: string;
    __actionId: string;
    __targetType?: ActionTargetType;
    // Human-readable action title, shown as a native hover tooltip.
    __title?: string;

    static getType(): string {
        return 'beaver-slash-command';
    }

    static clone(node: SlashCommandNode): SlashCommandNode {
        return new SlashCommandNode(
            node.__commandName,
            node.__actionId,
            node.__targetType,
            node.__title,
            node.__text,
            node.__key,
        );
    }

    constructor(
        commandName: string,
        actionId = '',
        targetType?: ActionTargetType,
        title?: string,
        text?: string,
        key?: NodeKey,
    ) {
        // Display the "/name" literal in the text so screen readers still hear it
        super(text ?? `/${commandName}`, key);
        this.__commandName = commandName;
        this.__actionId = actionId;
        this.__targetType = targetType;
        this.__title = title;
        // Normal mode: the caret can enter the command and arrow keys move
        // through it. Reverting to plain text on edit is handled by a transform.
    }

    static importJSON(serializedNode: SerializedSlashCommandNode): SlashCommandNode {
        const node = $createSlashCommandNode(
            serializedNode.commandName,
            serializedNode.actionId,
            serializedNode.targetType,
            serializedNode.title,
        );
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
            actionId: this.__actionId,
            targetType: this.__targetType,
            title: this.__title,
        };
    }

    createDOM(config: EditorConfig): HTMLElement {
        const dom = super.createDOM(config);
        dom.classList.add('beaver-slash-command');
        dom.setAttribute('data-lexical-slash', 'true');
        dom.setAttribute('data-command', this.__commandName);
        if (this.__title) dom.title = this.__title;
        return dom;
    }

    updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
        const updated = super.updateDOM(prevNode, dom, config);
        if (prevNode.__commandName !== this.__commandName) {
            dom.setAttribute('data-command', this.__commandName);
        }
        if (prevNode.__title !== this.__title) {
            dom.title = this.__title ?? '';
        }
        return updated;
    }

    getCommandName(): string {
        return this.__commandName;
    }

    getActionId(): string {
        return this.__actionId;
    }

    getTargetType(): ActionTargetType | undefined {
        return this.__targetType;
    }

    getTitle(): string | undefined {
        return this.__title;
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

export function $createSlashCommandNode(
    commandName: string,
    actionId = '',
    targetType?: ActionTargetType,
    title?: string,
): SlashCommandNode {
    return $applyNodeReplacement(new SlashCommandNode(commandName, actionId, targetType, title));
}

export function $isSlashCommandNode(
    node: LexicalNode | null | undefined,
): node is SlashCommandNode {
    return node instanceof SlashCommandNode;
}
