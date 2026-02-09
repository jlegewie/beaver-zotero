import { useEffect } from 'react';
import { LexicalEditor } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

interface EditorRefPluginProps {
    editorRef: React.MutableRefObject<LexicalEditor | null>;
}

export default function EditorRefPlugin({ editorRef }: EditorRefPluginProps): null {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        editorRef.current = editor;
        return () => {
            editorRef.current = null;
        };
    }, [editor, editorRef]);

    return null;
}
