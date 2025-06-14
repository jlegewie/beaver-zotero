import { logger } from '../utils/logger';

export class EncryptedStorage {
    private encryptionKey: CryptoKey | null = null;

    /**
     * Get or derive the encryption key using Web Crypto API
     */
    private async getEncryptionKey(): Promise<CryptoKey> {
        if (this.encryptionKey) {
            return this.encryptionKey;
        }

        const machineId = Zotero.version + Zotero.platform;
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(machineId),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        this.encryptionKey = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: encoder.encode('beaver-salt'),
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
     * Encrypt text using AES-CBC
     */
    async encrypt(text: string): Promise<string> {
        const key = await this.getEncryptionKey();
        const encoder = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(16));
        
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-CBC', iv },
            key,
            encoder.encode(text)
        );

        const ivHex = this.arrayBufferToHex(iv.buffer);
        const encryptedHex = this.arrayBufferToHex(encrypted);
        
        return `${ivHex}:${encryptedHex}`;
    }

    /**
     * Decrypt text using AES-CBC
     */
    async decrypt(encryptedText: string): Promise<string> {
        const key = await this.getEncryptionKey();
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

        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
    }

    /**
     * Store encrypted value in Zotero preferences
     */
    async setItem(key: string, value: string): Promise<void> {
        try {
            const encrypted = await this.encrypt(value);
            Zotero.Prefs.set(`beaver.auth.${key}`, encrypted);
        } catch (error) {
            logger(`Encryption failed: ${error}`);
            throw error;
        }
    }

    /**
     * Retrieve and decrypt value from Zotero preferences
     */
    async getItem(key: string): Promise<string | null> {
        try {
            const encrypted = Zotero.Prefs.get(`beaver.auth.${key}`);
            if (!encrypted) {
                return null;
            }
            return await this.decrypt(encrypted as string);
        } catch (error) {
            logger(`Decryption failed: ${error}`);
            return null;
        }
    }

    /**
     * Remove item from Zotero preferences
     */
    removeItem(key: string): void {
        try {
            Zotero.Prefs.clear(`beaver.auth.${key}`);
        } catch (error) {
            logger(`Error removing item from Zotero prefs: ${error}`);
        }
    }
}