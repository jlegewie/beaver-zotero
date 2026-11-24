/**
 * Whether the client declares `external_records`: it handles the external-record
 * shapes (record rows, combined per-source snapshots, import proposals). The
 * backend offers the database search tools that return them (OpenAlex, PubMed,
 * ClinicalTrials.gov) only to declaring clients. Also gates `web_pages`, which
 * the backend's web search requires on top. Restricted to development and
 * staging builds until release opt-in.
 */
export function isExternalRecordsEnabled(): boolean {
    return process.env.NODE_ENV === 'development' || process.env.BUILD_ENV === 'staging';
}
