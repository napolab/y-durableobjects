import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import type { Provider } from "@lexical/yjs";
import { ComponentProps } from "react";
import { WebsocketProvider } from "y-websocket";
import { Doc } from "yjs";
import { client } from "../adapters/client";

type Props = ComponentProps<typeof CollaborationPlugin>;
type ProviderFactory = Props["providerFactory"];

export const providerFactory: ProviderFactory = (id, map) => {
  const doc = new Doc();
  map.set(id, doc);

  const url = client.editor[":id"].$url();
  const provider = new WebsocketProvider(url.toString().replace("http", "ws").replace("/:id", ""), id, doc);

  // 公式通りやると型エラーになる調査する
  return provider as unknown as Provider;
};
