import { BeaverDB } from '../../database';
import { DocumentCache } from '../../documentCache';
import { getMuPDFWorkerClient } from '../../../beaver-extract';
import { buildExtractedDocumentCacheMetadata } from '../../documentExtractionCore';
import { isLibraryInScope } from '../../libraryScope';

/** Exercise maintenance in disposable SQLite/files, never in the user's cache. No cloud calls. */
export async function handleTestProtectedCacheHttpRequest(request: { library_id: number; zotero_key: string }) {
    if (!isLibraryInScope(request.library_id)) return { ok: false, error: 'library_excluded' };
    const item = await Zotero.Items.getByLibraryAndKeyAsync(request.library_id, request.zotero_key);
    if (!item || !item.isAttachment()) return { ok: false, error: 'not_found' };
    const path = await item.getFilePathAsync();
    if (!path) return { ok: false, error: 'no_local_file' };
    const dir = PathUtils.join(Zotero.getTempDirectory().path, `beaver-cache-check-${Date.now()}`);
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    const db = new BeaverDB(new Zotero.DBConnection(PathUtils.join(dir, 'test.sqlite')));
    const started = Date.now();
    try {
        await db.initDatabase('0.99.0');
        const cache = new DocumentCache(db, PathUtils.join(dir, 'payloads'));
        const bytes = await IOUtils.read(path);
        const result = await getMuPDFWorkerClient('background').extract(bytes, { mode: 'structured', settings: { checkTextLayer: true } });
        const metadata = buildExtractedDocumentCacheMetadata(result);
        const write = (key: string, ocr: boolean) => cache.putResult({
            item: { id: 0, libraryID: 1, key }, filePath: path, mode: 'structured',
            sourceSizeBytes: bytes.byteLength, contentType: 'application/pdf', result,
            metadata: { ...metadata, extractionSource: ocr ? 'ocr' : 'native' },
        });
        await write('TESTOCR1', true);
        await write('TESTNAT1', false);
        const initial = await db.getDocumentCachePayload(1, 'TESTOCR1', 'structured');
        if (!initial) throw new Error('OCR payload was not stored');
        await cache.clearAll();
        const nativeCleared = !(await db.getDocumentCacheMetadataByKey(1, 'TESTNAT1'));
        await db.resetLocalProcessingState();
        await db.initDatabase('0.99.0');
        const reopened = new DocumentCache(db, PathUtils.join(dir, 'payloads'));
        const readable = !!(await reopened.getResult({ libraryId: 1, zoteroKey: 'TESTOCR1' }, 'structured', path));
        const stats = await reopened.getStats();
        await reopened.invalidate(1, 'TESTOCR1');
        const invalidated = (await db.getDocumentCachePayloadCount()) === 0 && !(await IOUtils.exists(initial.payloadPath));
        return { ok: nativeCleared && readable && invalidated && stats.protected_ocr_bytes! > 0,
            nativeCleared, readableAfterClearResetReopen: readable, invalidated,
            protectedBytes: stats.protected_ocr_bytes, elapsedMs: Date.now() - started };
    } finally {
        await db.closeDatabase();
        await IOUtils.remove(dir, { recursive: true });
    }
}
