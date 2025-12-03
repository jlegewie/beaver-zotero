import { logger } from "./logger";

/**
 * Checks if an attachment is on the server.
 * @param item Zotero item
 * @returns true if the attachment is on the server
 */
export function isAttachmentOnServer(item: Zotero.Item): boolean {
	if (!item?.isStoredFileAttachment()) return false;
	
	const state = item.attachmentSyncState;
	
	// File is on server if it's in any state other than to_upload
	// to_upload means either: (1) never uploaded, or (2) local changes pending
	return state !== Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD;
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
 * Downloads the file data of an attachment from the Zotero server into memory.
 *
 * @param {Zotero.Item} item - The attachment item to download.
 * @returns {Promise<Uint8Array>} A promise that resolves with the file data
 * @throws {Error} If the file cannot be downloaded, with a descriptive error message
 */
export async function getAttachmentDataInMemory(item: Zotero.Item): Promise<Uint8Array> {

    // 1. Validate the input item
    if (!item || !item.isStoredFileAttachment()) {
		logger("getAttachmentDataInMemory: Item is not a valid stored file attachment.");
        throw new Error("Item is not a valid stored file attachment");
    }

    if (!isAttachmentOnServer(item)) {
		logger(`getAttachmentDataInMemory: File not on server (sync state: ${item.attachmentSyncState})`);
        throw new Error(`File not on server (sync state: ${item.attachmentSyncState})`);
    }

    // 2. Get the necessary API credentials for the download
    const userID = Zotero.Users.getCurrentUserID();
    if (!userID) {
		logger("getAttachmentDataInMemory: Not logged into a Zotero account");
        throw new Error("Not logged into a Zotero account");
    }

    const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
    if (!apiKey) {
		logger("getAttachmentDataInMemory: Missing Zotero API key");
        throw new Error("Missing Zotero API key");
    }

    // 3. Construct the API URL (this endpoint will 302 to a signed URL)
    const baseApiUrl = ZOTERO_CONFIG.API_URL;
    const apiUrl = item.library.isGroup
        ? `${baseApiUrl}groups/${item.library.id}/items/${item.key}/file`
        : `${baseApiUrl}users/${userID}/items/${item.key}/file`;
    
    const retryOptions = {
        errorDelayIntervals: [500, 1500, 3000] // 3 retries
    };

    try {
        // 4. Single request: follow redirect and get bytes
        logger(`getAttachmentDataInMemory: Requesting download URL from: ${apiUrl}`);
        const resp = await Zotero.HTTP.request('GET', apiUrl, {
            headers: { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': ZOTERO_CONFIG.API_VERSION },
            responseType: 'arraybuffer', // defaults to following redirects
            ...retryOptions
        });
        
        if (resp.status !== 200) {
			logger(`getAttachmentDataInMemory: Zotero API returned status ${resp.status}: ${resp.statusText || 'Unknown error'}`);
            throw new Error(`Zotero API returned status ${resp.status}: ${resp.statusText || 'Unknown error'}`);
        }

        const data = new Uint8Array(resp.response);
        
        if (!data || data.length === 0) {
			logger("getAttachmentDataInMemory: Downloaded file is empty");
            throw new Error("Downloaded file is empty");
        }

        return data;
    } catch (e: any) {
		    // Handle specific Zotero exception types
		if (e instanceof Zotero.HTTP.BrowserOfflineException) {
			logger(`getAttachmentDataInMemory: ${Zotero.appName} is offline`);
			throw new Error(`Cannot download: ${Zotero.appName} is offline`);
		}
		
		if (e instanceof Zotero.HTTP.TimeoutException) {
			logger(`getAttachmentDataInMemory: Download timeout: ${e.message}`);
			throw new Error(`Download timeout: ${e.message}`);
		}
		
		if (e instanceof Zotero.HTTP.SecurityException) {
			logger(`getAttachmentDataInMemory: Security error downloading from Zotero: ${e.message}`);
			throw new Error(`Security error downloading from Zotero: ${e.message}`);
		}

		// Check if it's a Zotero HTTP exception with status info
        if (e.xmlhttp) {
            const status = e.xmlhttp.status;
            const statusText = e.xmlhttp.statusText;
            
            if (status === 403) {
                throw new Error(`Access forbidden (403): Check Zotero API key permissions`);
            } else if (status === 404) {
                throw new Error(`File not found on server (404): File may not have been synced to Zotero cloud`);
            } else if (status === 429) {
                throw new Error(`Rate limited by Zotero API (429): Too many requests`);
            } else if (status >= 500) {
                throw new Error(`Zotero server error (${status}): ${statusText || 'Server error after retries'}`);
            } else {
                throw new Error(`Zotero API error (${status}): ${statusText || e.message || 'Unknown error'}`);
            }
        }
        
        // Check for network/connection errors
        if (e.message?.includes('NS_ERROR') || e.message?.includes('network')) {
            throw new Error(`Network error downloading from Zotero: ${e.message}`);
        }
        
        // Re-throw with original message if it's already descriptive
        if (e.message) {
            throw new Error(`Failed to download from Zotero: ${e.message}`);
        }
        
        // Fallback
        throw new Error(`Failed to download from Zotero: ${String(e)}`);
    }
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


interface FileHashInfo {
	key: string;
	md5: string | null;
	mtime: number | null;
}


/**
 * Gets the file hashes for a list of attachment items.
 * @param items Zotero items
 * @param batchSize The number of items to process in each batch
 * @returns Promise resolving to the file hashes or null if the hashes could not be retrieved.
 */
export async function getFileHashes(items: Zotero.Item[], batchSize: number = 50): Promise<FileHashInfo[]> {
	const attachmentItems = items.filter(item => item && isAttachmentOnServer(item));
	if (attachmentItems.length === 0) return [];

	const userID = Zotero.Users.getCurrentUserID();
	const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
	if (!userID || !apiKey) return [];

	const base = ZOTERO_CONFIG.API_URL;

	// Group items by library type and ID for efficient batching
	const groupedItems = new Map<number, Zotero.Item[]>();
	for (const item of attachmentItems) {
		if (!groupedItems.has(item.libraryID)) groupedItems.set(item.libraryID, []);
		groupedItems.get(item.libraryID)!.push(item);
	}

	const results: FileHashInfo[] = [];

	// Process each library group
	for (const [libraryID, libraryItems] of groupedItems.entries()) {
		// Process in batches of batchSize (API limit)
		for (let i = 0; i < libraryItems.length; i += batchSize) {
			const batch = libraryItems.slice(i, i + batchSize);
			const itemKeys = batch.map((it: Zotero.Item) => it.key).join(',');
			if (batch.length === 0) continue;

			const library = Zotero.Libraries.get(libraryID);
			if (!library) continue;
			const isGroup = library.isGroup;

			const apiUrl = isGroup
				? `${base}groups/${library.id}/items?itemKey=${itemKeys}&include=data`
				: `${base}users/${userID}/items?itemKey=${itemKeys}&include=data`;

			try {
				const xhr = await Zotero.HTTP.request('GET', apiUrl, {
					headers: {
						'Zotero-API-Key': apiKey,
						'Zotero-API-Version': ZOTERO_CONFIG.API_VERSION
					}
				});

				const data = JSON.parse(xhr.responseText);
				const fetchedItems = Array.isArray(data) ? data : [];

				for (const it of fetchedItems) {
					const d = it && it.data;
					if (d && d.itemType === 'attachment' && d.md5) {
						results.push({
							key: d.key,
							md5: d.md5,
							mtime: d.mtime ? parseInt(d.mtime, 10) : null
						});
					}
				}
			} catch (error) {
				console.error('Error fetching file hashes:', error);
				continue;
			}
		}
	}

	return results;
}

/**
 * Gets the file hash for an attachment item.
 * @param item Zotero item
 * @returns Promise resolving to the file hash or null if the hash could not be retrieved.
 */
export async function getFileHash(item: Zotero.Item): Promise<FileHashInfo | null> {
	const results = await getFileHashes([item]);
	return results.length > 0 ? results[0] : null;
}