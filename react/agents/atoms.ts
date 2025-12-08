import { atom } from "jotai";
import { AgentRun } from "./types";

// All completed runs for the thread (loaded from DB or finished streaming)
export const threadRunsAtom = atom<AgentRun[]>([]);

// The currently streaming run (null when not streaming)
export const activeRunAtom = atom<AgentRun | null>(null);

// Combined view for rendering
export const allRunsAtom = atom((get) => {
    const completed = get(threadRunsAtom);
    const active = get(activeRunAtom);
    return active ? [...completed, active] : completed;
});
