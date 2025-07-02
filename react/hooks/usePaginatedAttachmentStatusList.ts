import { useState, useEffect, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { userIdAtom } from '../atoms/auth';
import { planFeaturesAtom } from '../atoms/profile';
import {
    attachmentsService,
    AttachmentStatusPagedResponse,
    ProcessingStatus,
} from '../../src/services/attachmentsService';
import { FailedFileReference } from '../types/zotero';
import { logger } from '../../src/utils/logger';
import { RepeatIcon } from '../components/icons/icons';

const DEFAULT_ITEMS_PER_PAGE = 10;

/**
 * Paginated fetching hook for attachment processing statuses
 * @param statuses       Processing statuses to fetch
 * @param enabled        Whether fetching is enabled (e.g. list is expanded)
 * @param totalCount     Total number of matching items (for "show more" logic)
 * @param itemsPerPage   Items fetched per page
 */
export function usePaginatedAttachmentStatusList(
    statuses: ProcessingStatus[],
    enabled: boolean,
    totalCount: number,
    itemsPerPage: number = DEFAULT_ITEMS_PER_PAGE,
) {
    const [attachments, setAttachments] = useState<FailedFileReference[]>([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const userId     = useAtomValue(userIdAtom);
    const planConfig = useAtomValue(planFeaturesAtom);

    const fetchItems = useCallback(
        async (page: number) => {
            if (!userId) return;

            setIsLoading(true);
            try {
                const result: AttachmentStatusPagedResponse =
                    await attachmentsService.getAttachmentsByStatus(
                        statuses,
                        planConfig.processingTier,
                        page + 1,          // API is 1-based
                        itemsPerPage,
                    );

                /* Transform API response → FailedFileReference[] */
                const fetched = await Promise.all(
                    result.items.map(async (item) => {
                        let enableRetry = false;
                        let currentHash: string | undefined;

                        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
                            item.library_id,
                            item.zotero_key,
                        );

                        if (zoteroItem && zoteroItem.isAttachment()) {
                            currentHash = await zoteroItem.attachmentHash;
                            enableRetry = currentHash !== item.file_hash;
                        }

                        let errorCode = item.text_error_code;
                        if (planConfig.processingTier === 'standard') {
                            errorCode = item.md_error_code;
                        } else if (planConfig.processingTier === 'advanced') {
                            errorCode = item.docling_error_code;
                        }

                        return {
                            file_hash: item.file_hash || '',
                            library_id: item.library_id,
                            zotero_key: item.zotero_key,
                            errorCode,
                            buttonText: enableRetry && currentHash ? 'Retry' : undefined,
                            buttonAction:
                                enableRetry && currentHash
                                    ? () =>
                                          attachmentsService.updateFile(
                                              item.library_id,
                                              item.zotero_key,
                                              currentHash,
                                          )
                                    : undefined,
                            buttonIcon: enableRetry && currentHash ? RepeatIcon : undefined,
                        } as FailedFileReference;
                    }),
                );

                setAttachments((prev) =>
                    page === 0 ? fetched : [...prev, ...fetched],
                );
                
                // Simplified hasMore calculation
                const totalFetched = page === 0 ? fetched.length : (prev: number) => prev + fetched.length;
                setHasMore(result.has_more || (typeof totalFetched === 'number' ? totalFetched : 0) < totalCount);
                setCurrentPage(page);
            } catch (err) {
                logger(
                    `usePaginatedAttachmentStatusList: error for [${statuses.join(
                        ', ',
                    )}]: ${err}`,
                );
                setAttachments([]);
                setHasMore(false);
            } finally {
                setIsLoading(false);
            }
        },
        [
            userId,
            statuses,
            planConfig.processingTier,
            itemsPerPage,
            totalCount,
        ],
    );

    /* Fetch first page when enabled toggles on */
    useEffect(() => {
        if (enabled && totalCount > 0) {
            fetchItems(0);
        } else if (!enabled) {
            // reset when disabled
            setAttachments([]);
            setCurrentPage(0);
            setHasMore(false);
        }
    }, [enabled, totalCount, fetchItems]);

    /* Update hasMore when total count changes */
    useEffect(() => {
        if (enabled) {
            setHasMore(totalCount > attachments.length);
        }
    }, [totalCount, attachments.length, enabled]);

    const fetchNextPage = useCallback(() => {
        fetchItems(currentPage + 1);
    }, [fetchItems, currentPage]);

    return { attachments, hasMore, isLoading, fetchNextPage };
} 