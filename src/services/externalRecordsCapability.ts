/** External records search (PubMed, ClinicalTrials.gov) is restricted to development and staging builds until release opt-in. */
export function isExternalRecordsEnabled(): boolean {
    return process.env.NODE_ENV === 'development' || process.env.BUILD_ENV === 'staging';
}
