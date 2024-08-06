---
"y-durableobjects": major
---

Add JS RPC Support for getYDoc and updateYDoc

1. **Major Features**:

   - **JS RPC APIs `getYDoc` and `updateYDoc`**:
     - Implemented new JS RPC APIs to fetch (`getYDoc`) and update (`updateYDoc`) YDocs within Durable Objects.
     - Allows manipulating YDocs from sources other than WebSocket, enhancing flexibility and control.

2. **Hono Integration**:

   - Added examples for integrating `y-durableobjects` with Hono, using both shorthand and detailed methods.
   - Demonstrated how to handle WebSocket connections via fetch due to the current limitations of JS RPC (see [Cloudflare issue](https://github.com/cloudflare/workerd/issues/2319)).

3. **Extending with JS RPC**:

   - Explained how to extend `y-durableobjects` for advanced operations, including accessing and manipulating protected fields:
     - `app`: The Hono app instance used to handle requests.
     - `doc`: An instance of `WSSharedDoc` managing the YDoc state.
     - `storage`: A `YTransactionStorageImpl` instance for storing and retrieving YDoc updates.
     - `sessions`: A map to manage active WebSocket sessions.
     - `awarenessClients`: A set to track client awareness states.
   - Provided a minimal example of creating a custom Durable Object by extending `YDurableObjects`.

4. **Client-side Typed Fetch with Hono RPC**:

   - Included a guide for creating a typed client using `hc` from `hono/client` to facilitate Hono RPC on the client side.

5. **Documentation Updates**:
   - Updated the README with detailed examples and explanations for the new features and integrations.
   - Ensured clarity and ease of understanding for developers looking to utilize the new functionalities.
