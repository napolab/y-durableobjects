import { $generateHtmlFromNodes } from "@lexical/html";
import { TRANSFORMERS } from "@lexical/markdown";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import LexicalErrorBoundary from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import type { LexicalEditor } from "lexical";
import { type FC, useCallback, useRef } from "react";
import { initialConfig } from "./config";
import { providerFactory } from "./provider";

type Props = {
  id: string;
};

const Editor: FC<Props> = ({ id }) => {
  const ref = useRef<LexicalEditor>(null);

  const copyClipboard = useCallback(async () => {
    const editor = ref.current;
    if (editor === null) return;
    const code = await new Promise<string>((resolve) => {
      editor.getEditorState().read(() => {
        resolve($generateHtmlFromNodes(editor, null));
      });
    });
    await navigator.clipboard.writeText(code);
    alert("HTML copied to clipboard");
  }, []);

  return (
    <div className="root">
      <button type="button" onClick={copyClipboard}>
        Copy HTML
      </button>
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={<ContentEditable className="editor" />}
          placeholder={<div>Enter some text...</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <EditorRefPlugin editorRef={ref} />
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <TablePlugin />
        <TabIndentationPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <CollaborationPlugin id={id} username={crypto.randomUUID()} providerFactory={providerFactory} shouldBootstrap />
      </LexicalComposer>
    </div>
  );
};

export default Editor;
