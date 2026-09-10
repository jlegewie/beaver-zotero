import { useAtomValue } from "jotai";
import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import { preferencesRevisionAtom } from "../atoms/preferences";

/** A persisted settings value follows instance notifications; unsaved editors use local state. */
export function usePreference<T>(
    read: () => T,
): [T, Dispatch<SetStateAction<T>>] {
    const revision = useAtomValue(preferencesRevisionAtom);
    const [value, setValue] = useState(read);
    useEffect(() => {
        setValue(read());
    }, [revision]);
    return [value, setValue];
}
