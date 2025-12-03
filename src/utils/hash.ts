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