/**
 * Calculates a SHA-256 hash for a given object based on specified relevant keys.
 * Ensures deterministic hashing by sorting keys before stringifying.
 * Uses Object.prototype.hasOwnProperty.call for safer property checking.
 *
 * @param obj The object to hash.
 * @param relevantKeys An array of keys from the object to include in the hash.
 * @returns A Promise resolving to the hexadecimal SHA-256 hash string.
 */
async function calculateObjectHash(obj: Record<string, any>, relevantKeys: string[]): Promise<string> {
    try {
        const dataToHash: Record<string, any> = {};
        const sortedKeys = relevantKeys.sort();

        for (const key of sortedKeys) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                dataToHash[key] = obj[key];
            } else {
                dataToHash[key] = null;
            }
        }
        const deterministicJsonString = JSON.stringify(dataToHash);

        const encoder = new TextEncoder();
        const data = encoder.encode(deterministicJsonString);

        const hashBuffer = await crypto.subtle.digest('SHA-256', data);

        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        return hashHex;

    } catch (error: any) {
        Zotero.debug(`Beaver Sync: Error calculating hash: ${error.message}`, 1);
        Zotero.logError(error);
        throw new Error(`Failed to calculate object hash: ${error.message}`);
    }
}