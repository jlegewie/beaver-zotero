/**
 * Whether the client declares `external_records`, which gives it the database
 * search tools (OpenAlex, PubMed, ClinicalTrials.gov). Restricted to development
 * and staging builds until release opt-in.
 */
export function isExternalRecordsEnabled(): boolean {
    return process.env.NODE_ENV === 'development' || process.env.BUILD_ENV === 'staging';
}
