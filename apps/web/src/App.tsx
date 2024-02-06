import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  LexicalEditor,
} from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import LexicalErrorBoundary from "@lexical/react/LexicalErrorBoundary";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { ComponentProps } from "react";

function initialEditorState(_editor: LexicalEditor): void {
  const root = $getRoot();
  const paragraph = $createParagraphNode();
  const text = $createTextNode("Welcome to collab!");
  paragraph.append(text);
  root.append(paragraph);
}

function Editor() {
  const initialConfig = {
    // NOTE: This is critical for collaboration plugin to set editor state to null. It
    // would indicate that the editor should not try to set any default state
    // (not even empty one), and let collaboration plugin do it instead
    editorState: null,
    namespace: "Demo",
    nodes: [],
    onError: (error: Error) => {
      throw error;
    },
    theme: {},
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <PlainTextPlugin
        contentEditable={<ContentEditable />}
        placeholder={<div>Enter some text...</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <CollaborationPlugin
        id=""
        username={crypto.randomUUID()}
        providerFactory={(id, yjsDocMap) => {
          const doc = new Y.Doc();
          yjsDocMap.set(id, doc);

          const provider = new WebsocketProvider(
            "wss://worker.yjs.napochaan.dev",
            // "ws://localhost:8787",
            id,
            doc,
          );

          // 公式通りやると型エラーになる調査する
          return provider as unknown as ReturnType<
            ComponentProps<typeof CollaborationPlugin>["providerFactory"]
          >;
        }}
        initialEditorState={initialEditorState}
        shouldBootstrap={true}
      />
    </LexicalComposer>
  );
}

export default Editor;
