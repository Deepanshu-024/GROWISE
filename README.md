# Gro(W)ise — Business Scale Analyzer

Gro(W)ise analyzes your codebase for scalability risks, revenue threats, and architectural weaknesses — helping you understand the bottlenecks your business can face before they hit. Scalability analysis is powered by intelligent agents.
<img width="1919" height="910" alt="image" src="https://github.com/user-attachments/assets/99631bf8-d263-43b9-9810-7eede4c16b27" />


## Setup Guide

### Prerequisites

- Node.js 18+
- npm, yarn, pnpm, or bun

### Installation

```bash
npm install
# or
yarn install
# or
pnpm install
# or
bun install
```

### Environment Variables

Copy the example environment file and fill in the required values:

```bash
cp .env.example .env.local
```

Set `NEXT_PUBLIC_APP_URL` to your deployment URL (defaults to `http://localhost:3000`).

### Running the Development Server

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Building for Production

```bash
npm run build
npm start
```
