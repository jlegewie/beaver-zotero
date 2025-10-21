import { useEffect, useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { InputSource } from '../types/sources';
import { 
    sourceValidationManager, 
    SourceValidationType, 
    SourceValidationResult, 
    SourceValidationOptions 
} from '../../src/services/sourceValidationManager';
import { isAuthenticatedAtom } from '../atoms/auth';
import { logger } from '../../src/utils/logger';
import { syncLibraryIdsAtom } from '../atoms/profile';

/**
 * Hook options for source validation
 */
export interface UseSourceValidationOptions {
    source: InputSource;
    validationType?: SourceValidationType;
    forceRefresh?: boolean;
    enabled?: boolean;
}

/**
 * Hook for validating sources with backend integration and upload capabilities
 */
export function useSourceValidation({
    source,
    validationType = SourceValidationType.PROCESSED_FILE,
    forceRefresh = false,
    enabled = true
}: UseSourceValidationOptions): SourceValidationResult & {
    refresh: () => void;
    invalidate: () => void;
} {
    const [validationResult, setValidationResult] = useState<SourceValidationResult>({
        isValid: true, // Start optimistic
        validationType,
        backendChecked: false,
        uploaded: false,
        isValidating: false
    });

    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);

    // Validation function
    const validateSource = useCallback(async (force = false) => {

        // Skip validation if disabled
        if (!enabled) {
            return;
        }

        // If not authenticated, assume invalid and return
        if (!isAuthenticated) {
            setValidationResult(prev => ({
                ...prev,
                isValid: false,
                isValidating: false,
                backendChecked: false
            }));
            return;
        }

        try {
            setValidationResult(prev => ({ ...prev, isValidating: true }));

            // Backend validation (with cache)
            const options: SourceValidationOptions = {
                validationType,
                forceRefresh: force
            };

            const result = await sourceValidationManager.validateSource(source, options);
            setValidationResult(result);

        } catch (error: any) {
            logger(`useSourceValidation: Validation failed for ${source.itemKey}: ${error.message}`, 1);
            setValidationResult(prev => ({
                ...prev,
                isValid: false,
                reason: `Validation error: ${error.message}`,
                isValidating: false
            }));
        }
    }, [source, validationType, forceRefresh, isAuthenticated, syncLibraryIds, enabled]);

    // Run validation when dependencies change
    useEffect(() => {
        validateSource(forceRefresh);
    }, [validateSource]);

    // Refresh function to manually trigger validation
    const refresh = useCallback(() => {
        validateSource(true);
    }, [validateSource]);

    // Invalidate function to clear cache
    const invalidate = useCallback(() => {
        sourceValidationManager.invalidateSource(source);
    }, [source]);

    return {
        ...validationResult,
        refresh,
        invalidate
    };
}