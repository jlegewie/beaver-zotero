// @ts-ignore: Not sure why this is needed
import { useEffect } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { fileStatusAtom } from '../atoms/ui'; // Assuming the atom is in ui.ts
import { FileStatus } from '../types/fileStatus';
import { supabase } from '../../src/services/supabaseClient';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';

/**
 * Hook that subscribes to the user's file status record changes in Supabase
 * and keeps the fileStatusAtom updated.
 */
export const useFileStatus = (): void => {
    const setFileStatus = useSetAtom(fileStatusAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const user = useAtomValue(userAtom);

    useEffect(() => {
        // Skip if user is not authenticated or user object is not loaded
        if (!isAuthenticated || !user) {
            setFileStatus(null); // Clear status if not authenticated
            return;
        }

        // Helper to format data from Supabase (if needed, though types should match)
        const formatStatus = (statusData: any): FileStatus => ({
            ...statusData, 
            // Ensure numeric types if Supabase returns them differently
            total_files: Number(statusData.total_files || 0),
            upload_pending: Number(statusData.upload_pending || 0),
            upload_completed: Number(statusData.upload_completed || 0),
            upload_failed: Number(statusData.upload_failed || 0),
            md_unavailable: Number(statusData.md_unavailable || 0),
            md_queued: Number(statusData.md_queued || 0),
            md_processing: Number(statusData.md_processing || 0),
            md_converted: Number(statusData.md_converted || 0),
            md_chunked: Number(statusData.md_chunked || 0),
            md_embedded: Number(statusData.md_embedded || 0),
            md_failed: Number(statusData.md_failed || 0),
            docling_unavailable: Number(statusData.docling_unavailable || 0),
            docling_queued: Number(statusData.docling_queued || 0),
            docling_processing: Number(statusData.docling_processing || 0),
            docling_converted: Number(statusData.docling_converted || 0),
            docling_chunked: Number(statusData.docling_chunked || 0),
            docling_embedded: Number(statusData.docling_embedded || 0),
            docling_failed: Number(statusData.docling_failed || 0),
        });

        // Initial fetch of the user's file status
        const fetchInitialStatus = async () => {
            const { data, error } = await supabase
                .from('files_status')
                .select('*')
                .eq('user_id', user.id)
                .maybeSingle(); // Use maybeSingle() as the record might not exist initially

            if (error) {
                console.error('Error fetching initial file status:', error);
                setFileStatus(null); // Set to null on error
                return;
            }

            if (data) {
                setFileStatus(formatStatus(data));
            } else {
                // Handle case where the user has no record yet (optional: set default?)
                setFileStatus(null); 
            }
        };

        // Execute initial fetch
        fetchInitialStatus();

        // Set up realtime subscription for the specific user's record
        const subscription = supabase
            .channel(`file-status-${user.id}`)
            .on<FileStatus>( // Specify the payload type for type safety
                'postgres_changes',
                {
                    event: '*', // Listen for INSERT, UPDATE, DELETE
                    schema: 'public',
                    table: 'files_status',
                    filter: `user_id=eq.${user.id}` // Filter events for this user only
                },
                (payload) => {
                    Zotero.debug(`useFileStatus: Received event: ${payload.eventType}`);
                    if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                        setFileStatus(formatStatus(payload.new));
                    } else if (payload.eventType === 'DELETE') {
                        // Record deleted, likely should not happen but handle defensively
                        setFileStatus(null);
                    }
                }
            )
            .subscribe((status, err) => {
                if (err) {
                    console.error(`useFileStatus: realtime subscription error:`, err);
                } else {
                    Zotero.debug(`useFileStatus: realtime subscription status: ${status}`);
                }
            });

        // Clean up subscription on unmount or when user changes
        return () => {
            Zotero.debug(`useFileStatus: Unsubscribing from file-status-${user.id}`);
            subscription.unsubscribe();
        };
    }, [isAuthenticated, user, setFileStatus]); // Rerun effect if auth status or user changes
};