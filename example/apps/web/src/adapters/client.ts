import { hc } from "hono/client";
import type { AppType } from "workers";

const API_URL = import.meta.env.PROD ? import.meta.env.VITE_API_URL : "http://localhost:8787";

export const client = hc<AppType>(API_URL);

// const ws = client.editor[":id"].$ws({ param: { id: "1" }})
