import type { DeferredToolPreference, WSAgentActionExecuteRequest, WSAgentActionValidateRequest } from '@beaver/agent-core/protocol/agentProtocol';
import type { ExternalRefContext } from '../../utils/noteCitationExpand';

/** Captured by the originating client; absent grants never borrow another chat's policy. */
export interface OperationContext {
    owner?: string;
    accountGeneration?: number;
    userId?: string;
    onAttachmentResolved?: (payload: import("../attachmentResolved").AttachmentResolvedPayload) => void;
    threadId?: string | null;
    runId?: string;
    fullAccess?: boolean;
    preference?: (tool: string, data?: Record<string, any>) => DeferredToolPreference;
    externalRefs?: ExternalRefContext['externalRefs'];
    externalItemMapping?: ExternalRefContext['externalItemMapping'];
    renderedMarkdown?: Record<string, string>;
    renderMarkdown?: (content: string) => Promise<string>;
    grantCreatedNote?: (libraryId: number, key: string) => void;
}

export type ActionExecuteRequest = WSAgentActionExecuteRequest & { operation?: OperationContext };
export type ActionValidateRequest = WSAgentActionValidateRequest & { operation?: OperationContext };
