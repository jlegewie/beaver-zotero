import pako from 'pako';

/** Gzip-compress a UTF-8 string into bytes. */
export function gzipString(text: string): Uint8Array {
    return pako.gzip(text);
}

export interface ChunkedGzipJsonOptions {
    /** UTF-16 chars per deflate slice; the event loop gets a yield after each slice. */
    yieldAfterChars?: number;
    /** Yield implementation for tests and non-window runtimes. */
    yieldToEventLoop?: () => Promise<void>;
    /** Test hook called once per slice pushed to the deflator. */
    onDeflatePush?: (chars: number) => void;
}

/** Default slice size */
const DEFAULT_GZIP_SLICE_CHARS = 4 * 1024 * 1024;

function defaultYieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/**
 * JSON-serialize and gzip a value, yielding to the event loop between
 * deflate slices.
 *
 * Serialization is a single native `JSON.stringify` pass — cheap even for
 * ~50MB payloads (sub-second), so only the deflate work needs chunking to
 * keep Zotero's main thread responsive. The string is fed to the deflator
 * in `yieldAfterChars`-sized slices with one event-loop yield per slice.
 * Slice boundaries never split a UTF-16 surrogate pair: encoding a lone
 * surrogate half would emit U+FFFD and corrupt the payload. (Lone
 * surrogates inside string VALUES are already `\uXXXX`-escaped to ASCII by
 * `JSON.stringify`, so only well-formed pairs reach the slicer.)
 */
export async function gzipJsonValueChunked(
    value: unknown,
    options: ChunkedGzipJsonOptions = {},
): Promise<Uint8Array> {
    // Slices must advance by at least one char per iteration or the loop
    // below never terminates — fall back to the default for non-finite,
    // fractional-below-1, or non-positive values.
    const requestedSliceChars = options.yieldAfterChars ?? DEFAULT_GZIP_SLICE_CHARS;
    const sliceChars = Number.isFinite(requestedSliceChars) && requestedSliceChars >= 1
        ? Math.floor(requestedSliceChars)
        : DEFAULT_GZIP_SLICE_CHARS;
    const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;

    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new TypeError('JSON.stringify returned undefined');
    }

    const encoder = new TextEncoder();
    const deflator = new (pako as any).Deflate({ gzip: true });
    const chunks: Uint8Array[] = [];

    deflator.onData = (chunk: Uint8Array | ArrayBuffer) => {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    };

    for (let start = 0; start < json.length;) {
        let end = Math.min(start + sliceChars, json.length);
        if (end < json.length) {
            const code = json.charCodeAt(end - 1);
            if (code >= 0xd800 && code <= 0xdbff) end++;
        }
        const slice = json.slice(start, end);
        options.onDeflatePush?.(slice.length);
        deflator.push(encoder.encode(slice), false);
        if (deflator.err) {
            throw new Error(deflator.msg || `gzip deflate failed with code ${deflator.err}`);
        }
        await yieldToEventLoop();
        start = end;
    }

    deflator.push(new Uint8Array(), true);
    if (deflator.err) {
        throw new Error(deflator.msg || `gzip deflate failed with code ${deflator.err}`);
    }
    return concatUint8Arrays(chunks);
}

/** Gunzip bytes into a UTF-8 string. Throws on malformed input. */
export function gunzipToString(data: Uint8Array): string {
    return pako.ungzip(data, { to: 'string' }) as string;
}
