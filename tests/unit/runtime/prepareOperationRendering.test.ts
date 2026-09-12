import { expect, it, vi } from 'vitest';
import { prepareOperationRendering, hydrateOperationRendering } from '../../../src/services/agentDataProvider/prepareOperationRendering';

it('hands prepared strings to the plugin without retaining a renderer-owned async function', async () => {
    const render = vi.fn(async (content: string) => `<p>${content}</p>`);
    const prepared = await prepareOperationRendering('create_note', { title: 'Title', content: 'Body' }, { renderMarkdown: render });
    expect(prepared?.renderMarkdown).toBeUndefined();
    const calls = render.mock.calls.length;
    render.mockRejectedValue(new Error('Renderer closed'));
    const owned = hydrateOperationRendering(prepared);
    expect(await owned!.renderMarkdown!('<h1>Title</h1>\n\nBody')).toContain('Body');
    expect(render).toHaveBeenCalledTimes(calls);
    expect(hydrateOperationRendering({ renderMarkdown: render })?.renderMarkdown).toBeUndefined();
});
