import { expect, it } from 'vitest';
import { captureReaderActionLocation } from '../../../src/runtime/readerActionLocation';
it('captures an EPUB page independently of subsequent reader movement', () => {
    let page = 7;
    const reader = { type: 'epub', _internalReader: { _primaryView: {
        flow: { startRange: {} }, pageMapping: { getPageIndex: () => page },
    } } };
    const location = captureReaderActionLocation(reader);
    page = 20;
    expect(location).toEqual({ contentKind: 'epub', currentPage: 8 });
});
it('preserves snapshot kind without inventing a PDF page', () => {
    expect(captureReaderActionLocation({ type: 'snapshot' })).toEqual({ contentKind: 'snapshot', currentPage: null });
});
