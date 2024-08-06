# y-durableobjects

## 1.0.1

### Patch Changes

- d9839ce: change readme hono env description

## 1.0.0

### Major Changes

- 0446fbd: Add JS RPC Support for getYDoc and updateYDoc

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

## 0.4.2

### Patch Changes

- 1c87a94: fix yTansactionStorage maxBytes limits

## 0.4.1

### Patch Changes

- ee6cdf3: update dependencies pacakges
- a7f594a: export inner modules

## 0.4.0

### Minor Changes

- 0167e63: update hono4.3 client types

## 0.3.2

### Patch Changes

- 663be81: fix typo package.json keyword

## 0.3.1

### Patch Changes

- a3cd212: Fixed a problem that awareness remains when reloading.

## 0.3.0

### Minor Changes

- c2d0a17: yDoc must be saved with each change.

## 0.2.2

### Patch Changes

- 4176b18: enhanced readme

## 0.2.1

### Patch Changes

- 2a92448: fix hono dependencies

## 0.2.0

### Minor Changes

- 13dc461: add typed-websocket route

## 0.1.3

### Patch Changes

- 9b0bf0a: add homepage field
- 754fcf6: FIX README Hono typing

## 0.1.2

### Patch Changes

- b574bbf: fix readme code

## 0.1.1

### Patch Changes

- 1e1f4ce: add license

## 0.1.0

### Minor Changes

- 75e5ba9: y-durableobjects publish
