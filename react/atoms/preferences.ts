import { atom } from "jotai";
/** Invalidates derived preference reads after the instance observer publishes a change. */
export const preferencesRevisionAtom = atom(0);
