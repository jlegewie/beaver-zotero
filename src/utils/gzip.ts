import pako from 'pako';

/** Gzip-compress a UTF-8 string into bytes. */
export function gzipString(text: string): Uint8Array {
    return pako.gzip(text);
}

/** Gunzip bytes into a UTF-8 string. Throws on malformed input. */
export function gunzipToString(data: Uint8Array): string {
    return pako.ungzip(data, { to: 'string' }) as string;
}
