import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handler: undefined as any, pdf: vi.fn(), epub: vi.fn(), clear: vi.fn() }));
vi.mock('../../../react/hooks/useEventSubscription', () => ({ useEventSubscription: (_name: string, handler: any) => { mocks.handler = handler; } }));
vi.mock('../../../react/utils/extractionVisualizer', () => ({
    visualizeCurrentPageColumns: mocks.pdf, visualizeCurrentPageItems: mocks.pdf,
    visualizeCurrentPageLines: mocks.pdf, visualizeCurrentPageSentences: mocks.pdf,
    clearVisualizationAnnotations: mocks.clear, resolveActiveReaderContext: vi.fn(),
}));
vi.mock('../../../react/utils/epubVisualizer/epubExtractionVisualizer', () => ({ visualizeEpubItems: mocks.epub, visualizeEpubSentences: mocks.epub }));
vi.mock('../../../react/utils/clipboard', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({ getItemLanguage: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { useReaderVisualizerActionHandler } from '../../../react/hooks/useReaderVisualizerActionHandler';
const source = { _instanceID: 'source', itemID: 42, type: 'pdf', _window: { closed: false } };
const destination = { _instanceID: 'destination', itemID: 42, type: 'pdf', _window: { closed: false } };
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    source.type = 'pdf';
    source._window.closed = false;
    mocks.pdf.mockResolvedValue({ message: 'done' });
    mocks.epub.mockResolvedValue({ message: 'done' });
    vi.stubGlobal('Zotero', { Reader: { _readers: [destination, source] } });
    useReaderVisualizerActionHandler();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('targets the originating reader instance even when the destination displays the same paper', async () => {
    await mocks.handler({ action: 'columns', readerInstanceID: 'source' });
    expect(mocks.pdf).toHaveBeenCalledWith({ reader: source });
    await mocks.handler({ action: 'clear', readerInstanceID: 'source' });
    expect(mocks.clear).toHaveBeenCalledWith(source);
});
it('routes EPUB visualization to the source reader', async () => {
    source.type = 'epub';
    await mocks.handler({ action: 'items', readerInstanceID: 'source' });
    expect(mocks.epub).toHaveBeenCalledWith(source);
    expect(mocks.pdf).not.toHaveBeenCalled();
});
it('does not fall back to the destination when the source is closed or missing', async () => {
    source._window.closed = true;
    await mocks.handler({ action: 'columns', readerInstanceID: 'source' });
    await mocks.handler({ action: 'columns', readerInstanceID: 'missing' });
    expect(mocks.pdf).not.toHaveBeenCalled();
});
