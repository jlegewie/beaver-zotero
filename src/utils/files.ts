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
		logger(`getAttachmentDataInMemory: Requesting download URL from: ${apiUrl}`);
		const redirectResponse = await Zotero.HTTP.request('GET', apiUrl, {
			headers: { 'Zotero-API-Key': apiKey }
		});

		const downloadUrl = redirectResponse.responseURL;
		if (!downloadUrl || redirectResponse.status !== 302) {
			throw new Error(`getAttachmentDataInMemory: Failed to get a download redirect. Server responded with status ${redirectResponse.status}`);
		}

		Zotero.debug(`Downloading file from S3 URL: ${downloadUrl}`, 2);

		// 5. Make the second request to the signed S3 URL to get the file content
		const fileResponse = await Zotero.HTTP.request('GET', downloadUrl, { responseType: 'arraybuffer' });

		if (fileResponse.status !== 200) {
			throw new Error(`getAttachmentDataInMemory: File download failed. S3 responded with status ${fileResponse.status}`);
		}

		// 6. Return the data as a Uint8Array
		return new Uint8Array(fileResponse.response);

	} catch (e) {
		logger(`getAttachmentDataInMemory: Error during in-memory attachment download: ${e}`);
		return null;
	}
}