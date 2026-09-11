import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

/** Host-owned authentication. Hosts without an adapter retain the shared SDK policy. */
export interface CredentialAdapter {
    auth: SupabaseClient["auth"];
    getGeneration(): number;
}

let adapter: CredentialAdapter | undefined;
export function setCredentialAdapter(
    value: CredentialAdapter | undefined,
): void {
    adapter = value;
}
export function getCredentialGeneration(): number {
    return adapter?.getGeneration() ?? 0;
}
export function assertCredentialGeneration(generation: number): void {
    if (generation !== getCredentialGeneration()) {
        throw Object.assign(
            new Error("The account changed during this operation"),
            { code: "ACCOUNT_CHANGED" },
        );
    }
}
export const credentials = new Proxy({} as SupabaseClient["auth"], {
    get(_target, key) {
        const auth = adapter?.auth ?? supabase.auth;
        const value = Reflect.get(auth, key);
        return typeof value === "function" ? value.bind(auth) : value;
    },
});
