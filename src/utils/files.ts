import { logger } from "./logger";

/**
 * Checks if an attachment is on the server.
 * @param item Zotero item
 * @returns true if the attachment is on the server
 */
export function isAttachmentOnServer(item: Zotero.Item): boolean {
    if (!item.isAttachment() || !item.isStoredFileAttachment()) {
        return false;
    }
    // File is on the server if it's not in the 'to_upload' state.
    // The other states (in_sync, to_download, etc.) all imply existence on the server.
    return item.attachmentSyncState !== Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD;
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
			headers: { 'Zotero-API-Key': apiKey }
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
 * Downloads an attachment that exists on the server but not locally to a temporary file.
 * This function does NOT change the item's sync state or save the file to the user's
 * permanent Zotero storage directory. The goal is to get file access for
 * an upload without disrupting the user's library.
 *
 * NOTE: The caller of this function is responsible for deleting the temporary file
 *       from the filesystem once it is no longer needed.
 *
 * @param {Zotero.Item} item - The attachment item to download.
 * @returns {Promise<string|null>} A promise that resolves with the path to the
 *   temporary file on success, or null if the file could not be downloaded.
 */
export async function getAttachmentDataInMemory(item: Zotero.Item): Promise<Uint8Array | null> {

	// 1. Validate the input item
	if (!item || !item.isStoredFileAttachment()) {
		logger("getAttachmentDataInMemory: Item is not a valid stored file attachment.");
		return null;
	}

	if (!isAttachmentOnServer(item)) {
		logger("getAttachmentDataInMemory: File is not on server.");
		return null;
	}

	// 2. Get the necessary API credentials for the download
	const userID = Zotero.Users.getCurrentUserID();
	if (!userID) {
		logger("getAttachmentDataInMemory: Cannot download file: Not logged into a Zotero account.");
		return null;
	}

	const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
	if (!apiKey) {
		logger("getAttachmentDataInMemory: Cannot download file: Missing Zotero API key.");
		return null;
	}

	// 3. Construct the API URL (this endpoint will 302 to a signed URL)
	const baseApiUrl = ZOTERO_CONFIG.API_URL;
	const apiUrl = item.library.isGroup
		? `${baseApiUrl}groups/${item.libraryID}/items/${item.key}/file`
		: `${baseApiUrl}users/${userID}/items/${item.key}/file`;
	
	const retryOptions = {
		errorDelayIntervals: [500, 1500, 3000] // 3 retries
	};

	try {
		// 4. Single request: follow redirect and get bytes
		logger(`getAttachmentDataInMemory: Requesting download URL from: ${apiUrl}`);
		const resp = await Zotero.HTTP.request('GET', apiUrl, {
			headers: { 'Zotero-API-Key': apiKey },
			responseType: 'arraybuffer', // defaults to following redirects
			...retryOptions
		});
		if (resp.status !== 200) {
			return null;
		}

		const data = new Uint8Array(resp.response);

		return data;
	} catch (e) {
		return null;
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
		let xhr = new XMLHttpRequest();
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
		};

		xhr.onloadend = () => resolve(info);
		xhr.onerror = () => resolve(null);
		xhr.send(null);
	});
}