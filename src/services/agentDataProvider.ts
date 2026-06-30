/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */


export { handleZoteroDataRequest } from './agentDataProvider/handleZoteroDataRequest';
export { handleZoteroDocumentRequest } from './agentDataProvider/handleZoteroDocumentRequest';
export { handleZoteroAttachmentPageImagesRequest } from './agentDataProvider/handleZoteroAttachmentPageImagesRequest';
export { handleZoteroAttachmentImageRequest } from './agentDataProvider/handleZoteroAttachmentImageRequest';
export { handleZoteroViewImagesRequest } from './agentDataProvider/handleZoteroViewImagesRequest';
export { handleZoteroAttachmentSearchRequest } from './agentDataProvider/handleZoteroAttachmentSearchRequest';
export { handleExternalReferenceCheckRequest } from './agentDataProvider/handleExternalReferenceCheckRequest';
export { handleItemSearchByMetadataRequest } from './agentDataProvider/handleItemSearchByMetadataRequest';
export { handleItemSearchByTopicRequest } from './agentDataProvider/handleItemSearchByTopicRequest';
export { handleResolveSearchFiltersRequest } from './agentDataProvider/handleResolveSearchFiltersRequest';
export { handleZoteroSearchRequest } from './agentDataProvider/handleZoteroSearchRequest';
export { handleListItemsRequest } from './agentDataProvider/handleListItemsRequest';
export { handleGetMetadataRequest } from './agentDataProvider/handleGetMetadataRequest';
export { handleGetAnnotationsRequest } from './agentDataProvider/handleGetAnnotationsRequest';
export { handleFindAnnotationsRequest } from './agentDataProvider/handleFindAnnotationsRequest';
export { handleListCollectionsRequest } from './agentDataProvider/handleListCollectionsRequest';
export { handleListTagsRequest } from './agentDataProvider/handleListTagsRequest';
export { handleListLibrariesRequest } from './agentDataProvider/handleListLibrariesRequest';
export { handleAgentActionValidateRequest } from './agentDataProvider/handleAgentActionValidateRequest';
export { handleAgentActionExecuteRequest } from './agentDataProvider/handleAgentActionExecuteRequest';
export { handleDeleteItemsRequest } from './agentDataProvider/handleDeleteItemsRequest';
export { handleReadNoteRequest } from './agentDataProvider/handleReadNoteRequest';
export { validateCreateNoteAction, executeCreateNoteAction } from './agentDataProvider/actions/createNote';
