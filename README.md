# Yjs on Cloudflare Workers with Durable Objects Demo

This project demonstrates the integration of Yjs, a real-time collaboration framework, with Cloudflare Workers using Durable Objects, eliminating the dependency on Node.js. This setup is inspired by the `y-websocket` adapter and aims to provide a scalable and efficient solution for real-time collaborative applications.

[![Yjs on Cloudflare Workers with Durable Objects Demo Movie](https://i.gyazo.com/e94637740dbb11fc5107b0cd0850326d.gif)](https://gyazo.com/e94637740dbb11fc5107b0cd0850326d)

Demo: https://yjs.napochaan.dev/

## Getting Started

To get the demo running on your local environment, follow these steps:

### Prerequisites

Ensure you have the latest version of Node.js installed on your machine.

### Installation

Clone the repository and install the dependencies:

```bash
git clone https://github.com/napolab/yjs-worker
cd yjs-worker
npm install
```

### Running the UI

Navigate to the UI application directory and start the development server:

```bash
cd apps/web
npm run dev
```

This command will serve the UI on a local web server. Open your preferred web browser and navigate to the provided URL to interact with the UI.

### Running the Server

To start the server that includes the Cloudflare Worker with Durable Objects:

```bash
cd apps/workers
npm run dev
```

This will emulate the Cloudflare Worker environment locally, allowing you to test the Yjs integration.

## Future Plans

- Implement ping/pong and describe behavior on close to ensure stable connections.
- Improve the demo using Lexical for a more robust real-time collaborative editing experience.

Contributions and feedback are welcome as we continue to enhance the capabilities of this demo.
