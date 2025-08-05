# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`y-durableobjects` is a library for real-time collaboration in Cloudflare Workers using Yjs and Durable Objects. It provides WebSocket-based synchronization for Yjs documents with persistent storage.

## Common Development Commands

### Build and Development

- `pnpm build` - Build the library using tsup
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm lint` - Run all linters (ESLint and Prettier)
- `pnpm fmt` - Format code with Prettier and ESLint
- `pnpm test` - Run tests with Vitest

### Testing

- Tests use Vitest with Cloudflare Workers pool
- Run a single test: `pnpm test path/to/test.test.ts`
- Tests are configured with `vitest.config.ts` using Cloudflare Workers environment

### Release Process

- `pnpm release` - Publish packages using changesets

## Architecture

### Core Components

1. **YDurableObjects** (`src/yjs/index.ts`)

   - Main Durable Object class extending Cloudflare's DurableObject
   - Manages WebSocket connections and Yjs document synchronization
   - Handles persistence through YTransactionStorage
   - Provides JS RPC methods: `getYDoc()` and `updateYDoc()`

2. **WSSharedDoc** (`src/yjs/remote/ws-shared-doc.ts`)

   - Yjs document wrapper with WebSocket notification support
   - Manages awareness protocol for collaborative features
   - Handles document updates and broadcasts

3. **YTransactionStorage** (`src/yjs/storage/index.ts`)

   - Persistence layer for Yjs updates
   - Uses Durable Object storage with transaction support
   - Implements incremental update storage with periodic compaction

4. **Hono Integration** (`src/index.ts`)
   - Provides `yRoute()` helper for easy Hono app integration
   - Handles WebSocket upgrade and connection routing

### Message Protocol

- Uses binary WebSocket messages for Yjs synchronization
- Message types defined in `src/yjs/message-type/index.ts`
- Supports sync, awareness, and auth message types

### Development Constraints

1. **Cloudflare Workers Environment**

   - Code must be compatible with Workers runtime
   - Uses Cloudflare-specific APIs (DurableObject, WebSocketPair)
   - External imports marked in tsup config: `hono`, `/cloudflare:/`

2. **TypeScript Strict Mode**

   - Strict boolean expressions enforced
   - No explicit any allowed
   - Consistent type imports/exports required

3. **Code Style**
   - Kebab-case for filenames
   - No console.log in production code
   - Import ordering enforced by ESLint
   - Prettier formatting required

### Testing Approach

Tests follow these patterns:

- Unit tests for individual components
- Integration tests using Cloudflare Workers test environment
- WebSocket connection tests with mock implementations
- Storage tests with in-memory implementations
