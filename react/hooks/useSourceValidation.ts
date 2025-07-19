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

/**
 * Hook options for source validation
 */
export interface UseSourceValidationOptions {
    source: InputSource;
    validationType?: SourceValidationType;
    enabled?: boolean;
    enableUpload?: boolean;
    forceRefresh?: boolean;
}

/**
 * Hook for validating sources with backend integration and upload capabilities
 */
export function useSourceValidation({
    source,
    validationType = SourceValidationType.LIGHTWEIGHT,
    enabled = true,
    enableUpload = true,
    forceRefresh = false
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

    // Create validation function
    const validateSource = useCallback(async (force = false) => {
        if (!enabled || !isAuthenticated) {
            setValidationResult(prev => ({
                ...prev,
                isValid: true, // Assume valid if not authenticated
                isValidating: false,
                backendChecked: false
            }));
            return;
        }

        try {
            setValidationResult(prev => ({ ...prev, isValidating: true }));

            const options: SourceValidationOptions = {
                validationType,
                enableUpload,
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
    }, [source, validationType, enabled, enableUpload, forceRefresh, isAuthenticated]);

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