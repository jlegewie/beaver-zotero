import pako from 'pako';

/** Gzip-compress a UTF-8 string into bytes. */
export function gzipString(text: string): Uint8Array {
    return pako.gzip(text);
}

export interface ChunkedGzipJsonOptions {
    /** Approximate UTF-16 chars to write before yielding back to the event loop. */
    yieldAfterChars?: number;
    /** Yield implementation for tests and non-window runtimes. */
    yieldToEventLoop?: () => Promise<void>;
    /** Test hook called once per buffered write to the deflator. */
    onDeflatePush?: (chars: number) => void;
}

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

function hex4(code: number): string {
    return code.toString(16).padStart(4, '0');
}

/**
 * JSON-serialize and gzip a value incrementally.
 *
 * This preserves the cache's `.json.gz` payload format while avoiding one
 * large `JSON.stringify(value)` + gzip run on Zotero's main thread.
 */
export async function gzipJsonValueChunked(
    value: unknown,
    options: ChunkedGzipJsonOptions = {},
): Promise<Uint8Array> {
    const yieldAfterChars = options.yieldAfterChars ?? 128 * 1024;
    const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
    const encoder = new TextEncoder();
    const deflator = new (pako as any).Deflate({ gzip: true });
    const chunks: Uint8Array[] = [];
    const seen = new WeakSet<object>();
    let pendingText = '';

    deflator.onData = (chunk: Uint8Array | ArrayBuffer) => {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    };

    const flushPending = async () => {
        if (!pendingText) return;
        const text = pendingText;
        pendingText = '';
        options.onDeflatePush?.(text.length);
        deflator.push(encoder.encode(text), false);
        if (deflator.err) {
            throw new Error(deflator.msg || `gzip deflate failed with code ${deflator.err}`);
        }
        await yieldToEventLoop();
    };

    const write = async (text: string) => {
        pendingText += text;
        if (pendingText.length >= yieldAfterChars) await flushPending();
    };

    const writeJsonString = async (value: string): Promise<void> => {
        await write('"');
        let chunk = '';
        const flush = async () => {
            if (!chunk) return;
            const out = chunk;
            chunk = '';
            await write(out);
        };

        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            switch (code) {
                case 0x08:
                    chunk += '\\b';
                    break;
                case 0x09:
                    chunk += '\\t';
                    break;
                case 0x0a:
                    chunk += '\\n';
                    break;
                case 0x0c:
                    chunk += '\\f';
                    break;
                case 0x0d:
                    chunk += '\\r';
                    break;
                case 0x22:
                    chunk += '\\"';
                    break;
                case 0x5c:
                    chunk += '\\\\';
                    break;
                default:
                    if (code < 0x20) {
                        chunk += `\\u${hex4(code)}`;
                    } else if (code >= 0xd800 && code <= 0xdbff) {
                        const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
                        if (next >= 0xdc00 && next <= 0xdfff) {
                            chunk += value.charAt(i) + value.charAt(i + 1);
                            i++;
                        } else {
                            chunk += `\\u${hex4(code)}`;
                        }
                    } else if (code >= 0xdc00 && code <= 0xdfff) {
                        chunk += `\\u${hex4(code)}`;
                    } else {
                        chunk += value[i];
                    }
            }

            if (chunk.length >= yieldAfterChars) {
                await flush();
            }
        }

        await flush();
        await write('"');
    };

    const applyToJSON = (v: unknown, key: string): unknown => {
        if (v === null || typeof v !== 'object') return v;
        const objectValue = v as { toJSON?: unknown };
        return typeof objectValue.toJSON === 'function'
            ? (objectValue.toJSON as (key: string) => unknown).call(v, key)
            : v;
    };

    const isJSONUnsupported = (v: unknown): boolean => (
        typeof v === 'undefined'
        || typeof v === 'function'
        || typeof v === 'symbol'
    );

    const writeValue = async (v: unknown): Promise<void> => {
        if (v === null) return write('null');
        if (typeof v === 'string') return writeJsonString(v);
        if (typeof v === 'number') return write(Number.isFinite(v) ? String(v) : 'null');
        if (typeof v === 'boolean') return write(v ? 'true' : 'false');
        if (typeof v === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
        if (isJSONUnsupported(v)) return write('null');
        if (typeof v !== 'object') return write('null');

        const objectValue = v as Record<string, unknown>;
        if (seen.has(objectValue)) {
            throw new TypeError('Converting circular structure to JSON');
        }
        seen.add(objectValue);
        try {
            if (Array.isArray(objectValue)) {
                await write('[');
                for (let i = 0; i < objectValue.length; i++) {
                    if (i > 0) await write(',');
                    const item = applyToJSON(objectValue[i], String(i));
                    if (isJSONUnsupported(item)) {
                        await write('null');
                    } else {
                        await writeValue(item);
                    }
                }
                await write(']');
                return;
            }

            await write('{');
            let first = true;
            for (const key of Object.keys(objectValue)) {
                const item = applyToJSON(objectValue[key], key);
                if (isJSONUnsupported(item)) {
                    continue;
                }
                if (!first) await write(',');
                first = false;
                await writeJsonString(key);
                await write(':');
                await writeValue(item);
            }
            await write('}');
        } finally {
            seen.delete(objectValue);
        }
    };

    const root = applyToJSON(value, '');
    if (isJSONUnsupported(root)) {
        throw new TypeError('JSON.stringify returned undefined');
    }
    await writeValue(root);
    await flushPending();
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
