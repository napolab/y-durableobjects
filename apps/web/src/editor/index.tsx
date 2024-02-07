import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import LexicalErrorBoundary from "@lexical/react/LexicalErrorBoundary";
import { TRANSFORMERS } from "@lexical/markdown";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { providerFactory } from "./provider";
import { initialConfig } from "./config";

const Editor = () => {
  const id = "1";

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={<ContentEditable className="editor" />}
        placeholder={<div>Enter some text...</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin />
      <TablePlugin />
      <TabIndentationPlugin />
      <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
      <CollaborationPlugin
        id={id}
        username={crypto.randomUUID()}
        providerFactory={providerFactory}
        shouldBootstrap
      />
    </LexicalComposer>
  );
};

export default Editor;
