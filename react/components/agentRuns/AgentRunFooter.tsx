import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun } from '../../agents/types';
import { RepeatIcon, ShareIcon, ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { copyToClipboard } from '../../utils/clipboard';
import IconButton from '../ui/IconButton';
import MenuButton from '../ui/MenuButton';
import type { MenuItem } from '../ui/menu/ContextMenu';
import Button from '../ui/Button';
import CitedSourcesList from '../sources/CitedSourcesList';
import { renderToMarkdown, renderToHTML, preprocessNoteContent } from '../../utils/citationRenderers';
import CopyButton from '../ui/buttons/CopyButton';
import { citationMapAtom, citationsByRunIdAtom, citationKeyToMarkerAtom } from '../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { CitedSource, getCitationKey } from '../../types/citations';
import { messageSourcesVisibilityAtom, toggleMessageSourcesVisibilityAtom, setMessageSourcesVisibilityAtom } from '../../atoms/messageUIState';
import { toolResultsMapAtom, allRunsAtom } from '../../agents/atoms';
import { extractRunResponseContent } from '../../utils/threadContent';
import TokenUsageDisplay from './TokenUsageDisplay';
import { regenerateFromRunAtom, streamingDoneRunIdsAtom } from '../../atoms/agentRunAtoms';
import { currentThreadIdAtom } from '../../atoms/threads';
import { store } from '../../store';
import Tooltip from '../ui/Tooltip';
import Spinner from '../icons/Spinner';
import { prepareCitationRenderContext } from '../../utils/citationRenderContext';
import { getHost } from '../../host';

interface AgentRunFooterProps {
    run: AgentRun;
}

/**
 * Footer component for agent runs.
 * Displays sources, share options, regenerate, and copy buttons.
 */
export const AgentRunFooter: React.FC<AgentRunFooterProps> = ({ run }) => {
    const citationDataMap = useAtomValue(citationMapAtom);
    const citationsByRunId = useAtomValue(citationsByRunIdAtom);
    const runCitations = citationsByRunId[run.id] || [];
    const externalReferenceMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);
    const toolResultsMap = useAtomValue(toolResultsMapAtom);
    const citationMarkerMap = useAtomValue(citationKeyToMarkerAtom);
    const allRuns = useAtomValue(allRunsAtom);
    
    // Force re-render when menu opens to get fresh context for disabled state
    const [, forceUpdate] = useState({});
    
    const handleMenuToggle = useCallback((isOpen: boolean) => {
        if (isOpen) forceUpdate({});
    }, []);

    // Get unique citations for this run with their thread-scoped markers.
    // Citations render directly from metadata (citation v2) — no enrichment.
    const uniqueCitations = useMemo(() => {
        const seen = new Set<string>();
        const unique: CitedSource[] = [];

        for (const citation of runCitations) {
            if (citation.invalid) continue;
            const key = getCitationKey(citation);
            if (!seen.has(key)) {
                seen.add(key);
                unique.push({
                    ...citation,
                    numericCitation: citationMarkerMap[key] || null,
                });
            }
        }

        return unique;
    }, [runCitations, citationMarkerMap]);

    // Sources visibility state
    const sourcesVisibilityMap = useAtomValue(messageSourcesVisibilityAtom);
    const sourcesVisible = sourcesVisibilityMap[run.id] ?? false;
    const toggleSourcesVisibility = useSetAtom(toggleMessageSourcesVisibilityAtom);
    const setSourcesVisibility = useSetAtom(setMessageSourcesVisibilityAtom);

    // Toggle sources visibility
    const toggleSources = () => {
        toggleSourcesVisibility(run.id);
    };

    // Auto-hide sources if no citations
    useEffect(() => {
        if (uniqueCitations.length === 0 && sourcesVisible) {
            setSourcesVisibility({ messageId: run.id, visible: false });
        }
    }, [run.id, setSourcesVisibility, sourcesVisible, uniqueCitations.length]);

    // Combine all text content from the run's model messages
    const combinedContent = useMemo(() => {
        return extractRunResponseContent(run, toolResultsMap);
    }, [run.model_messages, toolResultsMap]);

    // Build share menu items
    const getShareMenuItems = () => {
        const host = getHost();
        const noteWriter = host.noteWriter;
        const hasParent = noteWriter?.canSaveAsChildNote() ?? false;

        const items: MenuItem[] = [
            {
                label: 'Copy',
                onClick: () => handleCopy()
            },
            {
                label: 'Copy link to message',
                onClick: () => copyRunUrl()
            },
            {
                label: 'Copy message ID',
                onClick: () => copyRunId()
            }
        ];

        if (noteWriter) {
            items.splice(1, 0,
                {
                    label: 'Save as note',
                    onClick: () => saveToLibrary(),
                    disabled: isResolvingCitations
                },
                {
                    label: 'Save as child note',
                    onClick: () => saveToItem(),
                    disabled: !hasParent || isResolvingCitations
                },
            );
        }

        if (host.config?.isDevelopment() ?? false) {
            items.push({
                label: 'Copy chat ID',
                onClick: () => copyThreadId()
            });
            items.push({
                label: 'Copy citation metadata',
                onClick: () => copyCitationMetadata()
            });
        }

        return items;
    };

    const handleCopy = async () => {
        const formattedContent = renderToMarkdown(combinedContent);
        await copyToClipboard(formattedContent);
    };

    const buildRunNoteContentHtml = async () => {
        const userQuestion = run.user_prompt.content;
        const sections: string[] = [];
        if (userQuestion) {
            sections.push(`## User\n\n> ${userQuestion.replace(/\n/g, '\n> ')}`);
        }
        sections.push(`## Beaver\n\n${combinedContent}`);
        const noteMarkdown = sections.join('\n\n---\n\n');

        const renderContent = preprocessNoteContent(noteMarkdown);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        return renderToHTML(renderContent, "markdown", renderContextData);
    };

    /** Save as standalone note to current library/collection. */
    const saveToLibrary = async () => {
        const noteWriter = getHost().noteWriter;
        if (!noteWriter) return;
        const contentHtml = await buildRunNoteContentHtml();
        const responseIndex = allRuns.findIndex(r => r.id === run.id) + 1;
        await noteWriter.saveNote({
            contentHtml,
            asChild: false,
            format: {
                kind: 'agent-run',
                responseIndex: responseIndex || undefined,
                runId: run.id,
            },
        });
    };

    /** Save as child note attached to selected/current item. */
    const saveToItem = async () => {
        const noteWriter = getHost().noteWriter;
        if (!noteWriter) return;
        const contentHtml = await buildRunNoteContentHtml();
        const responseIndex = allRuns.findIndex(r => r.id === run.id) + 1;
        await noteWriter.saveNote({
            contentHtml,
            asChild: true,
            requireParent: true,
            format: {
                kind: 'agent-run',
                responseIndex: responseIndex || undefined,
                runId: run.id,
            },
        });
    };

    const copyRunUrl = async () => {
        const threadId = store.get(currentThreadIdAtom);
        if (!threadId) return;
        await copyToClipboard(`zotero://beaver/thread/${threadId}/run/${run.id}`);
    };

    const copyRunId = async () => {
        await copyToClipboard(run.id);
    };

    const copyCitationMetadata = async () => {
        await copyToClipboard(JSON.stringify(runCitations, null, 2));
    };

    const copyThreadId = async () => {
        await copyToClipboard(store.get(currentThreadIdAtom ) || '');
    };

    const regenerateFromRun = useSetAtom(regenerateFromRunAtom);

    const handleRegenerate = async () => {
        // regenerateFromRunAtom walks the resume chain back to the root
        // internally, so we can pass the clicked run's id directly.
        await regenerateFromRun(run.id);
    };

    // Hide during streaming (but show during post-processing when citations are resolving)
    const streamingDoneRunIds = useAtomValue(streamingDoneRunIdsAtom);
    const isResolvingCitations = streamingDoneRunIds.has(run.id);
    const isStreaming = run.status === 'in_progress' && !isResolvingCitations;

    return (
        <div className="px-4">
            <div
                className={`
                    display-flex flex-row items-center pt-2 mr-2
                    ${isStreaming ? 'hidden' : ''}
                `}
            >
                {/* Sources button or resolving spinner */}
                <div className="flex-1">
                    {isResolvingCitations && uniqueCitations.length === 0 ? (
                        <div className="display-flex items-center gap-2 font-color-secondary">
                            <Spinner size={12} />
                            <span className="text-sm font-color-secondary">Linking sources...</span>
                        </div>
                    ) : uniqueCitations.length > 0 ? (
                        <Button
                            variant="ghost"
                            onClick={toggleSources}
                            icon={sourcesVisible ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="mr-0 scale-12 -ml-1"
                        >
                            <span>
                                {uniqueCitations.length} Source{uniqueCitations.length === 1 ? '' : 's'}
                            </span>
                        </Button>
                    ) : null}
                </div>
                
                {/* Action buttons */}
                <div className="display-flex gap-4">
                    {/* Usage display */}
                    {(getHost().config?.isDevelopment() ?? false) && run.status === 'completed' && run.total_usage && run.total_cost && (
                        <TokenUsageDisplay usage={run.total_usage} cost={run.total_cost} />
                    )}
                    {/* Share button */}
                    <MenuButton
                        icon={ShareIcon}
                        menuItems={getShareMenuItems()}
                        className="scale-11"
                        ariaLabel="Share"
                        variant="ghost"
                        positionAdjustment={{ x: 0, y: 0 }}
                        toggleCallback={handleMenuToggle}
                        tooltipContent="More options"
                    />
                    <Tooltip
                        content="Retry"
                        showArrow
                    >
                        <IconButton
                            icon={RepeatIcon}
                            onClick={handleRegenerate}
                            className="scale-11"
                            ariaLabel="Retry"
                        />
                    </Tooltip>
                    <Tooltip
                        content="Copy"
                        showArrow
                    >
                        <CopyButton
                            content={combinedContent}
                            formatContent={renderToMarkdown}
                            className="scale-11"
                        />
                    </Tooltip>
                </div>
            </div>

            {/* Sources section */}
            {sourcesVisible && (
                <CitedSourcesList citations={uniqueCitations} />
            )}
        </div>
    );
};

export default AgentRunFooter;
