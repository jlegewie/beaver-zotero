import { logger } from '@beaver/agent-core/platform/logger';

/** Register an instance-owned route and revoke retained or in-flight invocations on release. */
export function registerEndpoint(path: string, endpoint: any): () => void {
    let active = true;
    const unavailable = (): [number, string, string] => [503, 'application/json', JSON.stringify({ error_code: 'endpoint_unavailable' })];
    const Registered = function (this: any) {} as any;
    Registered.prototype = Object.create(endpoint.prototype);
    Registered.prototype.init = async function (request: any) {
        if (!active) return unavailable();
        const result = await endpoint.prototype.init.call(this, request);
        return active ? result : unavailable();
    };
    Zotero.Server.Endpoints[path] = Registered;
    return () => {
        active = false;
        if (Zotero.Server?.Endpoints[path] === Registered) delete Zotero.Server.Endpoints[path];
    };
}

interface ZoteroRequestData {
    method: string;
    pathname: string;
    pathParams: Record<string, string>;
    searchParams: URLSearchParams;
    headers: Headers;
    data: any;
}

/** Account-safe JSON dispatch, with structural cross-realm errors. */
export function createEndpoint<TRequest, TResponse>(
    handler: (request: TRequest) => Promise<TResponse>,
    options: { allowScopeChange?: boolean } = {},
): new () => { supportedMethods: string[]; supportedDataTypes: string[]; init: (requestData: ZoteroRequestData) => Promise<[number, string, string]> } {
    const Endpoint = function(this: any) {} as any;
    
    Endpoint.prototype = {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json"],
        
        async init(requestData: ZoteroRequestData): Promise<[number, string, string]> {
            try {
                const account = Zotero.Beaver.account;
                const generation = account?.getGeneration();
                const scope = JSON.stringify(Zotero.Beaver.searchableLibraryIds);
                if (!account?.getSnapshot().session) return [401, "application/json", JSON.stringify({ error_code: 'not_authenticated' })];
                const result = await handler(requestData.data);
                if (generation !== account.getGeneration()) return [409, 'application/json', JSON.stringify({ error_code: 'account_changed' })];
                if (!options.allowScopeChange && scope !== JSON.stringify(Zotero.Beaver.searchableLibraryIds)) return [409, 'application/json', JSON.stringify({ error_code: 'library_access_changed' })];
                return [200, "application/json", JSON.stringify(result)];
            } catch (error) {
                logger(`LocalEndpoints: Endpoint error: ${error}`, 1);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return [(error as any)?.code === "window_unavailable" ? 409 : 500, "application/json", JSON.stringify({
                    error_code: (error as any)?.code,
                    error: errorMessage
                })];
            }
        }
    };
    
    return Endpoint;
}
