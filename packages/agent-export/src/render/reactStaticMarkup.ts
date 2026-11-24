/**
 * Serialize a hast tree to HTML exactly as React 18's `renderToStaticMarkup`
 * writes the same tree rendered through react-markdown.
 *
 * The tree goes through `hast-util-to-jsx-runtime`, the converter
 * react-markdown itself uses, with a JSX factory that builds plain objects, so
 * the props match what React would receive (class names, style objects, table
 * cell alignment as `text-align`, no whitespace text inside table rows). Those
 * props are then written with React's rules for host elements: its attribute
 * table, its escaping (`'` as `&#x27;`), self-closing void elements (`<br/>`),
 * and `checked`/`value` last on `<input>`.
 *
 * Matching React byte for byte keeps note HTML identical to what the chat
 * renderer produced before, which the note edit matcher compares as text.
 * Only the HTML subset that survives the chat's sanitize schema needs to be
 * right; SVG, MathML, custom elements and form controls other than `<input>`
 * never reach here.
 */

import { toJsxRuntime } from 'hast-util-to-jsx-runtime';

/** A component the tree can map an element to; returns HTML-ready output. */
export type MarkupComponent = (props: Record<string, unknown>) => MarkupNode;

/** What the JSX factory builds. */
type MarkupElement = { type: string | MarkupComponent | typeof Fragment; props: Record<string, unknown> };
type MarkupNode = MarkupElement | string | number | boolean | null | undefined | MarkupNode[];

const Fragment = Symbol('Fragment');

function jsx(type: MarkupElement['type'], props: Record<string, unknown>): MarkupElement {
    return { type, props };
}

const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** React writes a leading newline twice in these, since HTML parsing drops the first one. */
const NEWLINE_EATING_ELEMENTS = new Set(['listing', 'pre']);

// React's DOM property table (react-dom server), HTML part.
// Props React writes under another attribute name.
const RENAMED: Record<string, string> = {
    acceptCharset: 'accept-charset',
    className: 'class',
    htmlFor: 'for',
    httpEquiv: 'http-equiv',
    tabIndex: 'tabindex',
    crossOrigin: 'crossorigin',
    formAction: 'formaction',
};
/** "Enumerated" attributes: booleans are written as `"true"` / `"false"`. */
const BOOLEANISH = new Set(['contentEditable', 'draggable', 'spellCheck', 'value']);
/** Boolean attributes written in lower case, present as `=""` when true. */
const BOOLEAN_LOWERCASE = new Set([
    'allowFullScreen', 'async', 'autoFocus', 'autoPlay', 'controls', 'default', 'defer', 'disabled',
    'disablePictureInPicture', 'disableRemotePlayback', 'formNoValidate', 'hidden', 'loop', 'noModule',
    'noValidate', 'open', 'playsInline', 'readOnly', 'required', 'reversed', 'scoped', 'seamless', 'itemScope',
]);
/** Boolean attributes React sets as DOM properties; written under the prop name. */
const BOOLEAN_PROPERTY = new Set(['checked', 'multiple', 'muted', 'selected']);
/** `true` is written as `=""`, `false` is omitted, any other value is written. */
const OVERLOADED_BOOLEAN = new Set(['capture', 'download']);
const POSITIVE_NUMERIC = new Set(['cols', 'rows', 'size', 'span']);
const NUMERIC: Record<string, string> = { rowSpan: 'rowspan', start: 'start' };
/** Props React never writes as attributes. */
const RESERVED = new Set([
    'children', 'dangerouslySetInnerHTML', 'defaultValue', 'defaultChecked', 'innerHTML',
    'suppressContentEditableWarning', 'suppressHydrationWarning',
]);
const ATTRIBUTE_NAME_START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
/** React's test for an attribute name it may write (XML name characters). */
// eslint-disable-next-line no-misleading-character-class -- the combining-mark ranges are single code points, as in React's own pattern
const SAFE_ATTRIBUTE_NAME = new RegExp(`^[${ATTRIBUTE_NAME_START}][${ATTRIBUTE_NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`);

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };

/** React's text and attribute escaping. */
function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * React's `style` attribute. After sanitizing, the only style left is the
 * string `textAlign` the JSX converter derives from a table cell's alignment,
 * so numeric values (React's `px` units) and custom properties never occur.
 */
function styleAttribute(style: unknown): string {
    if (!style || typeof style !== 'object') return '';
    const declarations: string[] = [];
    for (const [name, value] of Object.entries(style as Record<string, unknown>)) {
        if (value == null || typeof value === 'boolean' || value === '') continue;
        declarations.push(`${name.replace(/([A-Z])/g, '-$1').toLowerCase()}:${`${value}`.trim()}`);
    }
    return declarations.length > 0 ? ` style="${escapeHtml(declarations.join(';'))}"` : '';
}

function written(attribute: string, value: unknown): string {
    return ` ${attribute}="${escapeHtml(String(value))}"`;
}

function isDataOrAria(name: string): boolean {
    const prefix = name.toLowerCase().slice(0, 5);
    return prefix === 'data-' || prefix === 'aria-';
}

/** One prop as React writes it on a host element; `''` when React omits it. */
function attribute(name: string, value: unknown): string {
    if (value == null || RESERVED.has(name)) return '';
    if (name === 'style') return styleAttribute(value);
    // Event handlers are never written.
    if (name.length > 2 && (name[0] === 'o' || name[0] === 'O') && (name[1] === 'n' || name[1] === 'N')) return '';
    if (typeof value === 'function' || typeof value === 'symbol') return '';

    if (BOOLEAN_LOWERCASE.has(name)) return value ? ` ${name.toLowerCase()}=""` : '';
    if (BOOLEAN_PROPERTY.has(name)) return value ? ` ${name}=""` : '';
    if (OVERLOADED_BOOLEAN.has(name)) return value === true ? ` ${name}=""` : value === false ? '' : written(name, value);
    if (BOOLEANISH.has(name)) return written(name.toLowerCase(), value);
    // Other known and unknown attributes drop booleans, except data-/aria-.
    if (typeof value === 'boolean' && !isDataOrAria(name)) return '';
    if (POSITIVE_NUMERIC.has(name)) return !isNaN(value as number) && (value as number) >= 1 ? written(name, value) : '';
    if (Object.prototype.hasOwnProperty.call(NUMERIC, name)) return !isNaN(value as number) ? written(NUMERIC[name], value) : '';
    if (Object.prototype.hasOwnProperty.call(RENAMED, name)) return written(RENAMED[name], value);
    // Unknown props, including camelCase ones such as `colSpan`, are written as named.
    return SAFE_ATTRIBUTE_NAME.test(name) ? written(name, value) : '';
}

function attributes(tagName: string, props: Record<string, unknown>): string {
    let out = '';
    for (const name of Object.keys(props)) {
        // React writes an input's checked state and value after its other attributes.
        if (tagName === 'input' && (name === 'checked' || name === 'value' || name === 'defaultChecked' || name === 'defaultValue')) continue;
        out += attribute(name, props[name]);
    }
    if (tagName === 'input') {
        const checked = props.checked ?? props.defaultChecked;
        const value = props.value ?? props.defaultValue;
        if (checked != null) out += attribute('checked', checked);
        if (value != null) out += attribute('value', value);
    }
    return out;
}

function serialize(node: MarkupNode): string {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node));
    if (Array.isArray(node)) return node.map(serialize).join('');

    const { type, props } = node;
    if (type === Fragment) return serialize(props.children as MarkupNode);
    if (typeof type === 'function') return serialize(type(props));

    const open = `<${type}${attributes(type, props)}`;
    if (VOID_ELEMENTS.has(type)) return `${open}/>`;
    const children = props.children as MarkupNode;
    const leadingNewline = NEWLINE_EATING_ELEMENTS.has(type) && typeof children === 'string' && children.startsWith('\n') ? '\n' : '';
    return `${open}>${leadingNewline}${serialize(children)}</${type}>`;
}

/**
 * HTML for a hast tree, as react-markdown plus `renderToStaticMarkup` would
 * write it. `components` map element names to functions, as react-markdown's
 * `components` option does.
 */
export function hastToStaticMarkup(tree: unknown, components: Record<string, MarkupComponent> = {}): string {
    // The JSX runtime's types are React's; this factory returns plain objects.
    const element = toJsxRuntime(tree as Parameters<typeof toJsxRuntime>[0], {
        Fragment,
        jsx,
        jsxs: jsx,
        components,
        ignoreInvalidStyle: true,
    } as unknown as Parameters<typeof toJsxRuntime>[1]);
    return serialize(element as unknown as MarkupNode);
}
