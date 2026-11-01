/** Base64 encoding of bytes, for data URIs (no `btoa` in every realm the writers run in). */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes: Uint8Array): string {
    let out = '';
    let index = 0;
    for (; index + 2 < bytes.length; index += 3) {
        const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
        out += ALPHABET[chunk >> 18] + ALPHABET[(chunk >> 12) & 63] + ALPHABET[(chunk >> 6) & 63] + ALPHABET[chunk & 63];
    }
    const rest = bytes.length - index;
    if (rest === 1) {
        const chunk = bytes[index] << 16;
        out += `${ALPHABET[chunk >> 18]}${ALPHABET[(chunk >> 12) & 63]}==`;
    } else if (rest === 2) {
        const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
        out += `${ALPHABET[chunk >> 18]}${ALPHABET[(chunk >> 12) & 63]}${ALPHABET[(chunk >> 6) & 63]}=`;
    }
    return out;
}
