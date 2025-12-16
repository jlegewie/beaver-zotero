import { logger } from "./logger";

/**
 * Storage mode for a library - either Zotero File Storage or WebDAV
 */
export type StorageMode = 'zfs' | 'webdav';

/**
 * Gets the storage mode (ZFS or WebDAV) for a library.
 * @param libraryID The library ID
 * @returns The storage mode ('zfs' or 'webdav')
 */
export function getStorageModeForLibrary(libraryID: number): StorageMode {
    const mode = Zotero.Sync.Storage.Local.getModeForLibrary(libraryID);
    return mode === 'webdav' ? 'webdav' : 'zfs';
}

/**
 * Checks if an attachment is on the server
 * @param item Zotero item
 * @returns true if the attachment is on the server
 */
export function isAttachmentOnServer(item: Zotero.Item): boolean {
	if (!item || !item.isStoredFileAttachment()) return false;
	
	// File is on server if it has a server hash
	return item.attachmentSyncedHash !== null;
}

/**
 * Gets the download URL for an attachment that exists on the server.
 * @param item Zotero item
 * @returns Promise resolving to the download URL or null if the file could not be downloaded.
 */
export async function getDownloadUrl(item: Zotero.Item): Promise<string | null> {
    // 1. Validate the input item
	if (!item || !item.isStoredFileAttachment()) {
		logger("getDownloadUrl: Item is not a valid stored file attachment.");
		return null;
	}

	if (!isAttachmentOnServer(item)) {
		logger("getDownloadUrl: File is not on server.");
		return null;
	}

	// 2. Get the necessary API credentials for the download
	const userID = Zotero.Users.getCurrentUserID();
	if (!userID) {
		logger("getDownloadUrl: Cannot download file: Not logged into a Zotero account.");
		return null;
	}

	const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
	if (!apiKey) {
		logger("getDownloadUrl: Cannot download file: Missing Zotero API key.");
		return null;
	}

	// 3. Construct the initial API URL
	const baseApiUrl = ZOTERO_CONFIG.API_URL;
	let apiUrl;
	if (item.library.isGroup) {
		apiUrl = `${baseApiUrl}groups/${item.libraryID}/items/${item.key}/file`;
	} else {
		apiUrl = `${baseApiUrl}users/${userID}/items/${item.key}/file`;
	}

	try {
		// 4. Make the first request to get the redirect URL
		logger(`getDownloadUrl: Requesting download URL from: ${apiUrl}`);
		const redirectResponse = await Zotero.HTTP.request('GET', apiUrl, {
			headers: { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': ZOTERO_CONFIG.API_VERSION }
		});

		const downloadUrl = redirectResponse.responseURL;
		if (!downloadUrl || (redirectResponse.status !== 302 && redirectResponse.status !== 200)) {
			throw new Error(`getDownloadUrl: Failed to get a download redirect. Server responded with status ${redirectResponse.status}`);
		}

		return downloadUrl;

	} catch (e) {
		logger(`getDownloadUrl: Error during download URL retrieval: ${e}`);
		return null;
	}
}

function md5FromBytes(uint8: Uint8Array): string {
	// @ts-ignore Components is available in Zotero
	const ch = Components.classes["@mozilla.org/security/hash;1"]
		.createInstance(Components.interfaces.nsICryptoHash);
	ch.init(ch.MD5);
	ch.update(uint8, uint8.length);
	const bin = ch.finish(false);
	let hex = "";
	for (let i = 0; i < bin.length; i++) {
		const h = bin.charCodeAt(i).toString(16);
		hex += h.length === 1 ? "0" + h : h;
	}
	return hex;
}


/**
 * Downloads the file data of an attachment from the server into memory.
 * Supports both Zotero File Storage (ZFS) and WebDAV storage.
 *
 * @param {Zotero.Item} item - The attachment item to download.
 * @returns {Promise<Uint8Array>} A promise that resolves with the file data
 * @throws {Error} If the file cannot be downloaded, with a descriptive error message
 */
export async function getAttachmentDataInMemory(item: Zotero.Item): Promise<Uint8Array> {
    // Validate the input item
    if (!item || !item.isStoredFileAttachment()) {
        logger("getAttachmentDataInMemory: Item is not a valid stored file attachment.");
        throw new Error("Item is not a valid stored file attachment");
    }

    if (!isAttachmentOnServer(item)) {
        logger(`getAttachmentDataInMemory: File not on server (sync state: ${item.attachmentSyncState})`);
        throw new Error(`File not on server (sync state: ${item.attachmentSyncState})`);
    }

    // Detect storage mode and route to appropriate download method
    const storageMode = getStorageModeForLibrary(item.libraryID);
    logger(`getAttachmentDataInMemory: Using storage mode '${storageMode}' for library ${item.libraryID}`, 4);

    if (storageMode === 'webdav') {
        return await downloadFromWebDAV(item);
    } else {
        return await downloadFromZFS(item);
    }
}

/**
 * Downloads file data from Zotero File Storage (ZFS)
 */
async function downloadFromZFS(item: Zotero.Item): Promise<Uint8Array> {
    // Get the necessary API credentials for the download
    const userID = Zotero.Users.getCurrentUserID();
    if (!userID) {
        logger("downloadFromZFS: Not logged into a Zotero account");
        throw new Error("Not logged into a Zotero account");
    }

    const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
    if (!apiKey) {
        logger("downloadFromZFS: Missing Zotero API key");
        throw new Error("Missing Zotero API key");
    }

    // Construct the API URL (this endpoint will 302 to a signed URL)
    const baseApiUrl = ZOTERO_CONFIG.API_URL;
    const apiUrl = item.library.isGroup
        ? `${baseApiUrl}groups/${item.library.id}/items/${item.key}/file`
        : `${baseApiUrl}users/${userID}/items/${item.key}/file`;
    
    const retryOptions = {
        errorDelayIntervals: [500, 1500, 3000] // 3 retries
    };

    try {
        logger(`downloadFromZFS: Requesting download URL from: ${apiUrl}`);
        const resp = await Zotero.HTTP.request('GET', apiUrl, {
            headers: { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': ZOTERO_CONFIG.API_VERSION },
            responseType: 'arraybuffer',
            ...retryOptions
        });
        
        if (resp.status !== 200) {
            logger(`downloadFromZFS: Zotero API returned status ${resp.status}: ${resp.statusText || 'Unknown error'}`);
            throw new Error(`Zotero API returned status ${resp.status}: ${resp.statusText || 'Unknown error'}`);
        }

        const data = new Uint8Array(resp.response);
        
        if (!data || data.length === 0) {
            logger("downloadFromZFS: Downloaded file is empty");
            throw new Error("Downloaded file is empty");
        }

        return data;
    } catch (e: any) {
        handleDownloadError(e, 'ZFS');
    }
}

/**
 * Downloads file data from WebDAV storage
 * WebDAV files are always stored as ZIP archives, so we need to extract the file
 */
async function downloadFromWebDAV(item: Zotero.Item): Promise<Uint8Array> {
    // WebDAV is only available for personal libraries, not group libraries
    if (item.library.isGroup) {
        throw new Error("WebDAV storage is not available for group libraries");
    }

    try {
        // Get WebDAV controller and initialize it (loads credentials and builds URI)
        const controller = Zotero.Sync.Runner.getStorageController('webdav');
        await controller._init();

        // Build the file URI (credentials are embedded by the controller)
        // Returns URI for {item.key}.zip
        const uri = controller._getItemURI(item);
        
        const retryOptions = {
            errorDelayIntervals: [500, 1500, 3000] // 3 retries
        };

        logger(`downloadFromWebDAV: Downloading from WebDAV: ${item.key}`);
        
        const resp = await Zotero.HTTP.request('GET', uri.spec, {
            responseType: 'arraybuffer',
            ...retryOptions
        });

        if (resp.status !== 200) {
            logger(`downloadFromWebDAV: WebDAV returned status ${resp.status}: ${resp.statusText || 'Unknown error'}`);
            throw new Error(`WebDAV returned status ${resp.status}: ${resp.statusText || 'Unknown error'}`);
        }

        const zipData = new Uint8Array(resp.response);

        if (!zipData || zipData.length === 0) {
            logger("downloadFromWebDAV: Downloaded file is empty");
            throw new Error("Downloaded file is empty");
        }

        // WebDAV files are always zipped - extract the file
        return await extractFileFromZip(zipData, item);

    } catch (e: any) {
        handleDownloadError(e, 'WebDAV');
    }
}

/**
 * Extracts a file from a ZIP archive into memory
 * @param zipData The ZIP file data
 * @param item The Zotero item (used to get the expected filename)
 * @returns The extracted file data
 */
async function extractFileFromZip(zipData: Uint8Array, item: Zotero.Item): Promise<Uint8Array> {
    // Write ZIP to temp file for extraction (required by nsIZipReader)
    const tempZipPath = PathUtils.join(Zotero.getTempDirectory().path, `${item.key}_temp.zip`);
    
    try {
        await IOUtils.write(tempZipPath, zipData);

        // Create and open ZIP reader
        // @ts-ignore - nsIZipReader is available in Zotero/Firefox
        const zipReader = Components.classes["@mozilla.org/libjar/zip-reader;1"]
            .createInstance(Components.interfaces.nsIZipReader);
        
        zipReader.open(Zotero.File.pathToFile(tempZipPath));

        try {
            // Find the entry to extract - prefer the expected filename, fallback to first entry
            const expectedFilename = item.attachmentFilename;
            let entryName: string;
            
            if (expectedFilename && zipReader.hasEntry(expectedFilename)) {
                entryName = expectedFilename;
            } else {
                // Get first entry from the zip
                const entries = zipReader.findEntries(null);
                if (!entries.hasMore()) {
                    throw new Error("ZIP archive is empty");
                }
                entryName = entries.getNext();
                logger(`extractFileFromZip: Expected filename '${expectedFilename}' not found, using '${entryName}'`, 3);
            }

            // Read the entry into memory
            const inputStream = zipReader.getInputStream(entryName);
            // @ts-ignore - nsIBinaryInputStream is available in Zotero/Firefox
            const binaryInputStream = Components.classes["@mozilla.org/binaryinputstream;1"]
                .createInstance(Components.interfaces.nsIBinaryInputStream);
            binaryInputStream.setInputStream(inputStream);

            const available = binaryInputStream.available();
            if (available === 0) {
                throw new Error("Extracted file is empty");
            }

            const bytes = binaryInputStream.readByteArray(available);
            
            return new Uint8Array(bytes);

        } finally {
            zipReader.close();
        }

    } finally {
        // Clean up temp file
        try {
            await IOUtils.remove(tempZipPath);
        } catch (cleanupError) {
            logger(`extractFileFromZip: Failed to clean up temp file: ${cleanupError}`, 3);
        }
    }
}

/**
 * Handles download errors with consistent error messages
 */
function handleDownloadError(e: any, source: 'ZFS' | 'WebDAV'): never {
    // Handle specific Zotero exception types
    if (e instanceof Zotero.HTTP.BrowserOfflineException) {
        logger(`download: ${Zotero.appName} is offline`);
        throw new Error(`Cannot download: ${Zotero.appName} is offline`);
    }
    
    if (e instanceof Zotero.HTTP.TimeoutException) {
        logger(`download: Download timeout: ${e.message}`);
        throw new Error(`Download timeout: ${e.message}`);
    }
    
    if (e instanceof Zotero.HTTP.SecurityException) {
        logger(`download: Security error downloading from ${source}: ${e.message}`);
        throw new Error(`Security error downloading from ${source}: ${e.message}`);
    }

    // Check if it's a Zotero HTTP exception with status info
    if (e.xmlhttp) {
        const status = e.xmlhttp.status;
        const statusText = e.xmlhttp.statusText;
        
        if (status === 401 || status === 403) {
            const message = source === 'WebDAV' 
                ? `Authentication failed for WebDAV (${status})`
                : `Access forbidden (${status}): Check Zotero API key permissions`;
            throw new Error(message);
        } else if (status === 404) {
            const message = source === 'WebDAV'
                ? `File not found on WebDAV server (404)`
                : `File not found on server (404): File may not have been synced to Zotero cloud`;
            throw new Error(message);
        } else if (status === 429) {
            throw new Error(`Rate limited by ${source} (429): Too many requests`);
        } else if (status >= 500) {
            throw new Error(`${source} server error (${status}): ${statusText || 'Server error after retries'}`);
        } else {
            throw new Error(`${source} error (${status}): ${statusText || e.message || 'Unknown error'}`);
        }
    }
    
    // Check for network/connection errors
    if (e.message?.includes('NS_ERROR') || e.message?.includes('network')) {
        throw new Error(`Network error downloading from ${source}: ${e.message}`);
    }
    
    // Re-throw with original message if it's already descriptive
    if (e.message) {
        throw new Error(`Failed to download from ${source}: ${e.message}`);
    }
    
    // Fallback
    throw new Error(`Failed to download from ${source}: ${String(e)}`);
}

interface SignedDownloadInfo {
	downloadUrl: string;
	md5: string | null;
	mtime: number | null;
	compressed: boolean;
}

/**
 * Gets the signed download info for an attachment that exists on the server.
 * @param item Zotero item
 * @returns Promise resolving to the signed download info or null if the info could not be retrieved.
 */
export async function getSignedDownloadInfo(item: Zotero.Item): Promise<SignedDownloadInfo | null> {
	if (!item?.isStoredFileAttachment()) return null;

	const userID = Zotero.Users.getCurrentUserID();
	const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
	if (!userID || !apiKey) return null;

	const base = ZOTERO_CONFIG.API_URL;
	const apiUrl = item.library.isGroup
		? `${base}groups/${item.libraryID}/items/${item.key}/file`
		: `${base}users/${userID}/items/${item.key}/file`;

	return await new Promise((resolve) => {
		const xhr = new XMLHttpRequest();
		xhr.mozBackgroundRequest = true;
		xhr.open('GET', apiUrl, true);
		xhr.setRequestHeader('Zotero-API-Key', apiKey);

		let info: SignedDownloadInfo | null = null;

		// Capture redirect headers and cancel redirect
		// @ts-ignore notificationCallbacks is available in XMLHttpRequest
		xhr.channel.notificationCallbacks = {
			QueryInterface: ChromeUtils.generateQI([Ci.nsIInterfaceRequestor, Ci.nsIChannelEventSink]),
			getInterface: ChromeUtils.generateQI([Ci.nsIChannelEventSink]),
			asyncOnChannelRedirect(oldChannel: any, newChannel: any, flags: any, callback: any) {
				try {
					oldChannel.QueryInterface(Ci.nsIHttpChannel);
					info = {
						downloadUrl: newChannel.URI.spec,
						md5: oldChannel.getResponseHeader('Zotero-File-MD5') || null,
						mtime: parseInt(oldChannel.getResponseHeader('Zotero-File-Modification-Time')) || null,
						compressed: (oldChannel.getResponseHeader('Zotero-File-Compressed') == 'Yes') || false
					};
				} catch (e) {
					info = { downloadUrl: newChannel.URI.spec, md5: null, mtime: null, compressed: false };
				}
				// Cancel the redirect
				oldChannel.cancel(Cr.NS_BINDING_ABORTED);
				callback.onRedirectVerifyCallback(Cr.NS_BINDING_ABORTED);
			}
		} as nsIInterfaceRequestor & nsIChannelEventSink;

		xhr.onloadend = () => resolve(info);
		xhr.onerror = () => resolve(null);
		xhr.send(null);
	});
}