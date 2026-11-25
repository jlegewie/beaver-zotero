import type { NoteRenderOptions } from '../export/noteMarkdown';
import type { OperationContext } from './operationContext';

/** A prepared render's key: the same Markdown renders differently with block directions. */
function renderKey(content: string, options?: NoteRenderOptions): string {
    return `${options?.directions ?? 'plain'}:${content}`;
}

/** Finish renderer-owned async work before any library write acquires the queue. */
export async function prepareOperationRendering(
    actionType: string, data: Record<string, any>, context?: OperationContext,
): Promise<OperationContext | undefined> {
    if (!context?.renderMarkdown) return context;
    const renderedMarkdown: Record<string, string> = Object.create(null);
    const renders: Array<[string, NoteRenderOptions]> = [];
    // A created note's blocks are directed. Edit fragments are matched both
    // as written and with every block directed (`buildMarkdownRenderFields`).
    if (actionType === 'create_note') renders.push([`<h1>${data.title}</h1>\n\n${data.content}`.trim(), { directions: 'note' }]);
    if (actionType === 'edit_note' || actionType === 'edit_note_batch') {
        const strings = new Set<string>();
        for (const edit of actionType === 'edit_note_batch' ? data.edits ?? [] : [data]) {
            const old = edit.old_string ?? '', next = edit.new_string ?? '';
            strings.add(old); strings.add(next);
            if (edit.operation === 'insert_after' && next.startsWith(old)) strings.add(next.slice(old.length));
            if (edit.operation === 'insert_before' && next.endsWith(old)) strings.add(next.slice(0, next.length - old.length));
        }
        for (const content of strings) renders.push([content, {}], [content, { directions: 'all' }]);
    }
    for (const [content, options] of renders) {
        try { renderedMarkdown[renderKey(content, options)] = await context.renderMarkdown(content, options); }
        catch (error) { if (actionType === 'create_note') throw error; }
    }
    return { ...context, renderMarkdown: undefined, renderedMarkdown };
}

/** Construct the async seam in the plugin realm, from already prepared strings. */
export function hydrateOperationRendering(context?: OperationContext): OperationContext | undefined {
    if (!context) return context;
    if (!context.renderedMarkdown) return { ...context, renderMarkdown: undefined };
    const rendered = context.renderedMarkdown;
    return { ...context, renderMarkdown: async (content, options) => {
        const key = renderKey(content, options);
        if (!Object.prototype.hasOwnProperty.call(rendered, key)) throw new Error('Prepared note rendering unavailable');
        return rendered[key];
    } };
}
