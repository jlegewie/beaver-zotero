/**
 * Word client operations.
 *
 * The backend asks a connected Word client to run a single op and answer with
 * its result. `WordOpMap` names every op together with its params and its
 * result payload; the request and response envelopes below derive from it, so
 * `op` discriminates both directions and a response cannot carry another op's
 * data. Adding an op means adding one entry to the map.
 */

import type { WSBaseEvent } from './agentProtocol';

/** Event name of the request the backend sends to a Word client. */
export const WORD_REQUEST_EVENT = 'word_request';

/** Message type of the response a Word client sends back. */
export const WORD_RESPONSE_TYPE = 'word_response';

// =============================================================================
// Op payloads
// =============================================================================

/** `read_document` takes no parameters. */
export type WordReadDocumentParams = Record<string, never>;

/** Result of `read_document` */
export interface WordReadDocumentData {
    /** Body of the active document as plain text */
    text: string;
    /** Document title, when the document declares one */
    document_name?: string | null;
}

/** Every Word op, with the params it accepts and the data it returns */
export interface WordOpMap {
    /** Read the active document's plain text */
    read_document: {
        params: WordReadDocumentParams;
        data: WordReadDocumentData;
    };
}

/** Identifier of a Word op */
export type WordOp = keyof WordOpMap;

/** Params accepted by a single op */
export type WordOpParams<Op extends WordOp> = WordOpMap[Op]['params'];

/** Data returned by a single op */
export type WordOpData<Op extends WordOp> = WordOpMap[Op]['data'];

// =============================================================================
// Request / response envelopes
// =============================================================================

/** Request from backend to run a Word op, narrowed to one op */
export interface WSWordRequestFor<Op extends WordOp> extends WSBaseEvent {
    event: typeof WORD_REQUEST_EVENT;
    request_id: string;
    op: Op;
    params: WordOpParams<Op>;
}

/** Request from backend to run a Word op */
export type WSWordRequest = { [Op in WordOp]: WSWordRequestFor<Op> }[WordOp];

/** Error codes for Word op failures */
export type WordOpErrorCode =
    | 'unsupported_op'    // Client does not implement the requested op
    | 'invalid_params'    // Params are missing or malformed for the op
    | 'no_document'       // No document is open in the client
    | 'operation_failed'; // General failure while running the op

/** Response to a Word op request, narrowed to one op */
export interface WSWordResponseFor<Op extends WordOp> {
    type: typeof WORD_RESPONSE_TYPE;
    request_id: string;
    /** Echo of the requested op; ties the response to that op's data shape */
    op: Op;
    /** Result of the op (absent when the op failed) */
    data?: WordOpData<Op> | null;
    /** Error message if the op failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: WordOpErrorCode | null;
}

/**
 * Reply to a request whose op this client does not implement. `op` echoes
 * whatever was asked for, which need not be an op this build knows — a backend
 * can be ahead of a client, and the client still has to answer.
 */
export interface WSWordUnsupportedOpResponse {
    type: typeof WORD_RESPONSE_TYPE;
    request_id: string;
    op: string;
    error: string;
    error_code: 'unsupported_op';
}

/** Response to a Word op request */
export type WSWordResponse =
    | { [Op in WordOp]: WSWordResponseFor<Op> }[WordOp]
    | WSWordUnsupportedOpResponse;
