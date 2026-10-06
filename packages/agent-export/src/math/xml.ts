/**
 * Minimal XML reader for KaTeX's MathML output: elements, attributes, text and
 * the entities KaTeX escapes. No DOM is needed, so it runs in any realm.
 * Comments, processing instructions and CDATA are not expected and skipped.
 */

export interface XmlElement {
    type: 'element';
    name: string;
    attributes: Record<string, string>;
    children: XmlNode[];
}

export interface XmlText {
    type: 'text';
    value: string;
}

export type XmlNode = XmlElement | XmlText;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXmlEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
        if (entity[0] === '#') {
            const code = entity[1] === 'x' || entity[1] === 'X'
                ? Number.parseInt(entity.slice(2), 16)
                : Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

/** Whether a UTF-16 code unit may appear in an XML 1.0 document. */
function isXmlChar(code: number): boolean {
    return code === 0x9 || code === 0xA || code === 0xD || (code >= 0x20 && code !== 0xFFFE && code !== 0xFFFF);
}

/**
 * Remove characters XML 1.0 cannot represent (C0 controls other than tab and
 * line breaks). Text copied from PDFs can carry form feeds or vertical tabs, and
 * a single one makes a written document unreadable.
 */
export function stripInvalidXmlChars(text: string): string {
    for (let i = 0; i < text.length; i++) {
        if (!isXmlChar(text.charCodeAt(i))) {
            let out = '';
            for (let j = 0; j < text.length; j++) {
                if (isXmlChar(text.charCodeAt(j))) out += text[j];
            }
            return out;
        }
    }
    return text;
}

export function escapeXml(text: string): string {
    return stripInvalidXmlChars(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const TOKEN_PATTERN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE_PATTERN = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse an XML fragment into a list of top-level nodes. Throws on mismatched tags. */
export function parseXml(xml: string): XmlNode[] {
    const root: XmlElement = { type: 'element', name: '#root', attributes: {}, children: [] };
    const stack: XmlElement[] = [root];
    for (const match of xml.matchAll(TOKEN_PATTERN)) {
        const [, closing, name, attributeText, selfClosing, text] = match;
        const parent = stack[stack.length - 1];
        if (text !== undefined) {
            parent.children.push({ type: 'text', value: decodeXmlEntities(text) });
            continue;
        }
        // Comments, processing instructions and CDATA.
        if (!name) continue;
        if (closing) {
            if (parent.name !== name) throw new Error(`Mismatched closing tag </${name}>`);
            stack.pop();
            continue;
        }
        const attributes: Record<string, string> = {};
        for (const attribute of (attributeText ?? '').matchAll(ATTRIBUTE_PATTERN)) {
            attributes[attribute[1]] = decodeXmlEntities(attribute[2] ?? attribute[3] ?? '');
        }
        const element: XmlElement = { type: 'element', name, attributes, children: [] };
        parent.children.push(element);
        if (!selfClosing) stack.push(element);
    }
    if (stack.length !== 1) throw new Error(`Unclosed tag <${stack[stack.length - 1].name}>`);
    return root.children;
}

/** Child elements, ignoring whitespace text. */
export function elementChildren(element: XmlElement): XmlElement[] {
    return element.children.filter((child): child is XmlElement => child.type === 'element');
}

/** Concatenated text content. */
export function textContent(node: XmlNode): string {
    return node.type === 'text' ? node.value : node.children.map(textContent).join('');
}
