import React from 'react';
import type { AgentActionInStreamProps } from '../../types';
import { AgentActionView } from './AgentActionView';
import { AnnotationToolCallView } from './AnnotationToolCallView';
import { EditNoteGroupView } from './EditNoteGroupView';

/**
 * Zotero router for the in-stream agent-action UI. The shared dispatchers
 * classify a tool-call part (annotation / edit-note group / standard action) and
 * hand it here via `getHost().components?.agentActionInStream(...)`; this picks
 * the matching Zotero component. The components themselves stay Zotero-coupled
 * (apply/undo of library mutations).
 */
export const AgentActionInStream: React.FC<AgentActionInStreamProps> = (props) => {
    switch (props.kind) {
        case 'annotation':
            return (
                <AnnotationToolCallView
                    part={props.part}
                    runId={props.runId}
                    runStatus={props.runStatus}
                />
            );
        case 'edit-note-group':
            return (
                <EditNoteGroupView
                    parts={props.parts}
                    target={props.target}
                    runId={props.runId}
                    responseIndex={props.responseIndex}
                    runStatus={props.runStatus}
                />
            );
        case 'tool-action':
            return (
                <AgentActionView
                    toolcallId={props.part.tool_call_id}
                    toolName={props.toolName}
                    runId={props.runId}
                    responseIndex={props.responseIndex}
                    pendingApproval={props.pendingApproval}
                    hasToolReturn={props.hasToolReturn}
                    streamingArgs={props.streamingArgs}
                    runStatus={props.runStatus}
                />
            );
        default:
            return null;
    }
};

export default AgentActionInStream;
