/**
 * The hast shapes the chat's rehype transformers touch. `@types/hast` is
 * deliberately not available here (the package pins its ambient types to
 * react + react-dom), so the few fields used are declared locally. One
 * permissive interface covers roots (`type: 'root'`), elements
 * (`type: 'element'`) and text nodes (`type: 'text'`).
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
