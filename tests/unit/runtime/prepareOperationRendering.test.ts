import { expect, it, vi } from 'vitest';
import { prepareOperationRendering, hydrateOperationRendering } from '../../../src/services/agentDataProvider/prepareOperationRendering';

it('hands prepared strings to the plugin without retaining a renderer-owned async function', async () => {
    const render = vi.fn(async (content: string) => `<p>${content}</p>`);
    const prepared = await prepareOperationRendering('create_note', { title: 'Title', content: 'Body' }, { renderMarkdown: render });
    expect(prepared?.renderMarkdown).toBeUndefined();
    const calls = render.mock.calls.length;
    render.mockRejectedValue(new Error('Renderer closed'));
    const owned = hydrateOperationRendering(prepared);
    expect(await owned!.renderMarkdown!('<h1>Title</h1>\n\nBody', { directions: 'note' })).toContain('Body');
    expect(render).toHaveBeenCalledTimes(calls);
    expect(hydrateOperationRendering({ renderMarkdown: render })?.renderMarkdown).toBeUndefined();
});

it('renders a created note with block directions, and edit fragments both with and without', async () => {
    const render = vi.fn(async (content: string, options?: { directions?: string }) => `<p${options?.directions ? ' dir="rtl"' : ''}>${content}</p>`);
    await prepareOperationRendering('create_note', { title: 'Title', content: 'Body' }, { renderMarkdown: render });
    expect(render.mock.calls).toEqual([['<h1>Title</h1>\n\nBody', { directions: 'note' }]]);

    render.mockClear();
    const prepared = await prepareOperationRendering('edit_note', { old_string: 'Old', new_string: 'New' }, { renderMarkdown: render });
    expect(render.mock.calls).toEqual([
        ['Old', {}], ['Old', { directions: 'all' }],
        ['New', {}], ['New', { directions: 'all' }],
    ]);
    const owned = hydrateOperationRendering(prepared)!;
    expect(await owned.renderMarkdown!('Old')).toBe('<p>Old</p>');
    expect(await owned.renderMarkdown!('Old', { directions: 'all' })).toBe('<p dir="rtl">Old</p>');
    await expect(owned.renderMarkdown!('Unprepared')).rejects.toThrow('Prepared note rendering unavailable');
});
