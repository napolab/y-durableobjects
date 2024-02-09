import React from "react";
import ReactDOM from "react-dom/client";
import Editor from "./editor";
import "@acab/reset.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Editor id="1" />
  </React.StrictMode>,
);
