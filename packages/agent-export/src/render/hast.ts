/**
 * The hast shapes the render modules read and write. `@types/hast` is not a
 * dependency of this package, so the few fields used are declared locally. One
 * permissive interface covers roots (`type: 'root'`), elements
 * (`type: 'element'`), text nodes (`type: 'text'`) and raw HTML
 * (`type: 'raw'`).
 */
export interface HastNode {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
}

/** Element class names, whether hast stored them as an array or a string. */
export function classNames(node: HastNode): string[] {
    const className = node.properties?.className;
    if (Array.isArray(className)) return className.map((name) => String(name));
    if (typeof className === 'string') return className.split(/\s+/);
    return [];
}

/** Text content of a hast node tree. */
export function hastTextContent(node: HastNode): string {
    if (node.type === 'text') return node.value || '';
    if (node.children) return node.children.map(hastTextContent).join('');
    return '';
}
