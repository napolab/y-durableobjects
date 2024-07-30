import "@acab/reset.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { Description } from "./description";
import Editor from "./editor";
import "./styles.css";

// biome-ignore lint/style/noNonNullAssertion: <explanation>
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div>
      <Description />
      <Editor id="1" />
    </div>
  </React.StrictMode>,
);
