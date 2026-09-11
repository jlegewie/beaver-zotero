import type { OperationContext } from './operationContext';

/** Finish renderer-owned async work before any library write acquires the queue. */
export async function prepareOperationRendering(
    actionType: string, data: Record<string, any>, context?: OperationContext,
): Promise<OperationContext | undefined> {
    if (!context?.renderMarkdown) return context;
    const renderedMarkdown: Record<string, string> = Object.create(null);
    const strings = new Set<string>();
    if (actionType === 'create_note') strings.add(`<h1>${data.title}</h1>\n\n${data.content}`.trim());
    if (actionType === 'edit_note' || actionType === 'edit_note_batch') {
        for (const edit of actionType === 'edit_note_batch' ? data.edits ?? [] : [data]) {
            const old = edit.old_string ?? '', next = edit.new_string ?? '';
            strings.add(old); strings.add(next);
            if (edit.operation === 'insert_after' && next.startsWith(old)) strings.add(next.slice(old.length));
            if (edit.operation === 'insert_before' && next.endsWith(old)) strings.add(next.slice(0, next.length - old.length));
        }
    }
    for (const content of strings) {
        try { renderedMarkdown[content] = await context.renderMarkdown(content); }
        catch (error) { if (actionType === 'create_note') throw error; }
    }
    return { ...context, renderMarkdown: undefined, renderedMarkdown };
}

/** Construct the async seam in the plugin realm, from already prepared strings. */
export function hydrateOperationRendering(context?: OperationContext): OperationContext | undefined {
    if (!context) return context;
    if (!context.renderedMarkdown) return { ...context, renderMarkdown: undefined };
    const rendered = context.renderedMarkdown;
    return { ...context, renderMarkdown: async content => {
        if (!Object.prototype.hasOwnProperty.call(rendered, content)) throw new Error('Prepared note rendering unavailable');
        return rendered[content];
    } };
}
