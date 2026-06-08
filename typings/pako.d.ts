declare module 'pako' {
    export function gzip(data: string | Uint8Array): Uint8Array;
    export function ungzip(data: Uint8Array, options?: { to?: 'string' }): string | Uint8Array;
}
