/**
 * Calculates a SHA-256 hash for a given object.
 * Ensures deterministic hashing by sorting keys before stringifying.
 * Uses Object.prototype.hasOwnProperty.call for safer property checking.
 *
 * @param obj The object containing exactly the fields to be hashed.
 * @returns A Promise resolving to the hexadecimal SHA-256 hash string.
 */
export async function calculateObjectHash(obj: Record<string, any>): Promise<string> {
    try {
        // Create a new object to ensure only own properties are included, and sort keys
        const dataToHash: Record<string, any> = {};
        const sortedKeys = Object.keys(obj).sort(); // Sort keys for deterministic order

        for (const key of sortedKeys) {
            // Use value directly. JSON.stringify handles basic types, nulls, arrays, nested objects.
            dataToHash[key] = obj[key];
        }
        const deterministicJsonString = JSON.stringify(dataToHash);

        const encoder = new TextEncoder();
        const data = encoder.encode(deterministicJsonString);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;

    } catch (error: any) {
        Zotero.debug(`Beaver Sync: Error calculating hash: ${error.message}`, 1);
        Zotero.logError(error);
        throw new Error(`Failed to calculate object hash: ${error.message}`);
    }
}

/**
 * Hex SHA-256 of a string or a byte array.
 *
 * Unlike {@link calculateObjectHash} this hashes exactly the bytes it is
 * given, with no re-serialisation, so the digest describes a file as it was
 * written rather than a normalised view of it.
 *
 * `crypto.subtle` is present in Zotero's chrome and in Node, but the fallback
 * keeps callers that only need change detection working where it is not: the
 * digest is never a security claim, only an answer to "is this the same
 * content".
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        const digest = await subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    }

    let hash = 2166136261;
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
    }
    return `${bytes.byteLength.toString(16)}-${(hash >>> 0).toString(16)}`;
}
