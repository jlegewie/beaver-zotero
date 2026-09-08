declare module 'pako' {
    export class Deflate {
        constructor(options: { gzip: boolean; chunkSize: number });
        onData: (chunk: Uint8Array) => void;
        err: number;
        push(data: Uint8Array, last: boolean): boolean;
    }
    export function gzip(data: string | Uint8Array): Uint8Array;
    export function ungzip(data: Uint8Array, options?: { to?: 'string' }): string | Uint8Array;
}
