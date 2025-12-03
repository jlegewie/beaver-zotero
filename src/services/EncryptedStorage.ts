import { logger } from '../utils/logger';

/**
 * Encrypted storage for authentication tokens.
 * Provides obfuscation against casual inspection and accidental exposure.
 * Not designed to protect against attackers with file system access.
 */
export class EncryptedStorage {
    private encryptionKey: CryptoKey | null = null;
    private storageDirectory: any | null = null;
    private textEncoder = new TextEncoder();
    private textDecoder = new TextDecoder();

    private toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
        const { buffer, byteLength, byteOffset } = view;
        const source = new Uint8Array(buffer, byteOffset, byteLength);
        const copy = new Uint8Array(byteLength);
        copy.set(source);
        return copy.buffer;
    }

    /**
     * Get or derive the encryption key using Web Crypto API
     */
    private async getEncryptionKey(): Promise<CryptoKey> {
        if (this.encryptionKey) {
            return this.encryptionKey;
        }

        const localUserKey = Zotero.Users.getLocalUserKey();
        const machineId = localUserKey + Zotero.platform;
        const machineIdBytes = this.textEncoder.encode(machineId);
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            this.toArrayBuffer(machineIdBytes),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        const saltBytes = this.textEncoder.encode('beaver-salt');
        this.encryptionKey = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: this.toArrayBuffer(saltBytes),
                iterations: 10000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-CBC', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );

        return this.encryptionKey;
    }

    /**
     * Get the legacy encryption key (for migration from old format)
     * Uses Zotero.version + Zotero.platform (old method)
     */
    private async getLegacyEncryptionKey(): Promise<CryptoKey> {
        const machineId = Zotero.version + Zotero.platform;
        const machineIdBytes = this.textEncoder.encode(machineId);
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            this.toArrayBuffer(machineIdBytes),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        const saltBytes = this.textEncoder.encode('beaver-salt');
        return await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: this.toArrayBuffer(saltBytes),
                iterations: 10000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-CBC', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Convert ArrayBuffer to hex string
     */
    private arrayBufferToHex(buffer: ArrayBuffer): string {
        const byteArray = new Uint8Array(buffer);
        const hexCodes = [...byteArray].map(value => value.toString(16).padStart(2, '0'));
        return hexCodes.join('');
    }

    /**
     * Convert hex string to ArrayBuffer
     */
    private hexToArrayBuffer(hex: string): ArrayBuffer {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes.buffer;
    }

    /**
     * Ensure the storage directory exists and return a clone
     */
    private ensureStorageDirectory(): any {
        if (!this.storageDirectory) {
            const profileDir = Zotero.File.pathToFile(Zotero.Profile.dir);
            const beaverDir = profileDir.clone();
            beaverDir.append('beaver');

            if (!beaverDir.exists()) {
                beaverDir.create(Ci.nsIFile.DIRECTORY_TYPE ?? 1, 0o700);
            }

            const storageDir = beaverDir.clone();
            storageDir.append('secure-storage');

            if (!storageDir.exists()) {
                storageDir.create(Ci.nsIFile.DIRECTORY_TYPE ?? 1, 0o700);
            }

            this.storageDirectory = storageDir;
        }

        return this.storageDirectory.clone();
    }

    /**
     * Replace characters not supported by the filesystem
     */
    private sanitizeKey(key: string): string {
        return key.replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    private getFileForKey(key: string): any {
        const dir = this.ensureStorageDirectory();
        dir.append(`${this.sanitizeKey(key)}.json`);
        return dir;
    }

    private getPrefKey(key: string): string {
        return `beaver.auth.${key}`;
    }

    private async writeEncryptedValue(key: string, value: string): Promise<void> {
        const file = this.getFileForKey(key);
        await Zotero.File.putContentsAsync(file.path, value);
    }

    private async readEncryptedValue(key: string): Promise<string | null> {
        try {
            const file = this.getFileForKey(key);
            if (!file.exists()) {
                return null;
            }

            const contents = await Zotero.File.getContentsAsync(file.path);

            if (typeof contents === 'string') {
                return contents;
            }

            if (contents instanceof Uint8Array) {
                return this.textDecoder.decode(this.toArrayBuffer(contents));
            }

            if (contents instanceof ArrayBuffer) {
                return this.textDecoder.decode(contents);
            }

            return null;
        } catch (error) {
            logger(`Error reading encrypted auth token: ${error}`);
            return null;
        }
    }

    private async migrateFromPreferences(key: string): Promise<string | null> {
        const prefKey = this.getPrefKey(key);
        const encrypted = Zotero.Prefs.get(prefKey);
        if (!encrypted) {
            return null;
        }

        // Try decrypting with current key first, then fall back to legacy key
        let decrypted: string | null = null;
        let keyUsed: 'current' | 'legacy' | null = null;

        // First, try the current key (getLocalUserKey + platform)
        try {
            const currentKey = await this.getEncryptionKey();
            decrypted = await this.decryptWithKey(encrypted as string, currentKey);
            keyUsed = 'current';
        } catch (error) {
            // Current key failed, try legacy key (Zotero.version + platform)
            try {
                const legacyKey = await this.getLegacyEncryptionKey();
                decrypted = await this.decryptWithKey(encrypted as string, legacyKey);
                keyUsed = 'legacy';
            } catch (legacyError) {
                logger(`Migration from preferences failed with both keys: ${error}, ${legacyError}`);
                // Clean up the preference since we couldn't decrypt it with either key
                Zotero.Prefs.clear(prefKey);
                return null;
            }
        }

        // Successfully decrypted - now persist to disk with the current key
        if (decrypted && keyUsed) {
            try {
                const reencrypted = await this.encrypt(decrypted);
                await this.writeEncryptedValue(key, reencrypted);
                Zotero.Prefs.clear(prefKey);
                logger(`Successfully migrated auth token from preferences using ${keyUsed} key`);
            } catch (persistError) {
                logger(`Failed to persist migrated auth token: ${persistError}`);
            }
            return decrypted;
        }

        return null;
    }

    /**
     * Encrypt text using AES-CBC
     */
    async encrypt(text: string): Promise<string> {
        const key = await this.getEncryptionKey();
        const ivBytes = crypto.getRandomValues(new Uint8Array(16));
        const iv = this.toArrayBuffer(ivBytes);
        const plaintext = this.toArrayBuffer(this.textEncoder.encode(text));
        
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-CBC', iv },
            key,
            plaintext
        );

        const ivHex = this.arrayBufferToHex(iv);
        const encryptedHex = this.arrayBufferToHex(encrypted);
        
        return `${ivHex}:${encryptedHex}`;
    }

    /**
     * Decrypt text using AES-CBC with a specific key
     */
    private async decryptWithKey(encryptedText: string, key: CryptoKey): Promise<string> {
        const parts = encryptedText.split(':');
        
        if (parts.length !== 2) {
            throw new Error('Invalid encrypted text format');
        }

        const iv = this.hexToArrayBuffer(parts[0]);
        const encrypted = this.hexToArrayBuffer(parts[1]);
        
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv },
            key,
            encrypted
        );

        return this.textDecoder.decode(decrypted);
    }

    /**
     * Decrypt text using AES-CBC
     */
    async decrypt(encryptedText: string): Promise<string> {
        const key = await this.getEncryptionKey();
        return this.decryptWithKey(encryptedText, key);
    }

    /**
     * Store encrypted value on disk
     */
    async setItem(key: string, value: string): Promise<void> {
        try {
            const encrypted = await this.encrypt(value);
            await this.writeEncryptedValue(key, encrypted);
            this.clearPreferenceKey(key);
        } catch (error) {
            logger(`Encryption failed: ${error}`);
            throw error;
        }
    }

    /**
     * Retrieve and decrypt value from disk (with legacy preference fallback)
     */
    async getItem(key: string): Promise<string | null> {
        try {
            const encrypted = await this.readEncryptedValue(key);
            if (encrypted) {
                return await this.decrypt(encrypted);
            }

            return await this.migrateFromPreferences(key);
        } catch (error) {
            logger(`Decryption failed: ${error}`);
            return null;
        }
    }

    /**
     * Remove stored value (and clean up legacy preference entry)
     */
    async removeItem(key: string): Promise<void> {
        try {
            const file = this.getFileForKey(key);
            await Zotero.File.removeIfExists(file.path);
        } catch (error) {
            logger(`Error removing auth token file: ${error}`);
        }

        this.clearPreferenceKey(key);
    }

    private clearPreferenceKey(key: string): void {
        try {
            Zotero.Prefs.clear(this.getPrefKey(key));
        } catch (error) {
            logger(`Error clearing legacy preference key: ${error}`);
        }
    }
}