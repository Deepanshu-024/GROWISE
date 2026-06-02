# Gro(W)ise — Business Scale Analyzer

> Understand the bottlenecks your business can face before they hit. Gro(W)ise analyzes your codebase for scalability risks, revenue threats, and architectural weaknesses.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Database Setup](#database-setup)
  - [Running Locally](#running-locally)
- [Project Structure](#project-structure)
- [Analysis Pipeline](#analysis-pipeline)
- [Specialized Agents](#specialized-agents)
- [API Routes](#api-routes)
- [Usage](#usage)
- [Deployment](#deployment)
- [Contributing](#contributing)

---

## Overview

Gro(W)ise is an AI-powered business scalability analyzer. It connects to your GitHub repositories, scans the codebase using a fleet of specialized agents, and produces structured reports that pinpoint scalability risks, potential revenue threats, and architectural weaknesses — before they become production incidents.

Users connect their GitHub account, select a repository, and receive a detailed report broken down into:

- **Birds-Eye View** — architecture archetypes, primary bottleneck classification, product maturity stage, and risk exposure summary.
- **Scale Issues (Clusters)** — grouped findings by severity (critical, warning, info) with root causes, failure modes, cost of inaction, and mitigation strategies.
- **Revenue Risk Assessment** — direct revenue loss potential, user churn risk, compliance exposure, and an overall verdict.

An integrated chat interface lets users ask follow-up questions, generate GitHub issues directly from findings, and request implementation plans — all scoped to the report context.

---

## Features

- **GitHub OAuth App Integration** — connect any repository via GitHub App installation.
- **Automated Framework Detection** — identifies Next.js and React projects automatically.
- **Business Classification** — categorises the repository into one or more architectural archetypes (database-heavy, auth-heavy, compute-heavy, AI-powered, realtime, event-driven, financial-transactional, content-heavy).
- **Eight Specialized Analysis Agents** — each agent targets a specific domain and runs code analysis tools against the repository.
- **Background Job Processing** — analysis runs asynchronously via Inngest so the UI stays responsive; the project page polls every 10 seconds until the report is ready.
- **Structured XML Reports** — compiled findings are stored as structured XML and parsed into typed TypeScript interfaces for display.
- **Interactive Chat** — ask questions about findings, create GitHub issues, or generate implementation plans, all within the report context.
- **Usage Limits** — 2 free analyses per user; chat is limited to 3 messages per conversation and 2 conversations per project.
- **Dark Mode** — default dark theme with system detection.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Next.js App                          │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │  Home / UI   │   │  Dashboard   │   │  Project/Report│  │
│  └──────┬───────┘   └──────┬───────┘   └───────┬────────┘  │
│         │                  │                   │            │
│  ┌──────▼───────────────────▼───────────────────▼────────┐  │
│  │              Server Actions / API Routes               │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │                               │
│  ┌──────────────────────────▼────────────────────────────┐  │
│  │                     Inngest                            │  │
│  │  ┌────────────────────────────────────────────────┐   │  │
│  │  │         analyzeRepositoryWorkflow              │   │  │
│  │  │  1. Business Classification                    │   │  │
│  │  │  2. Orchestration Context Resolution           │   │  │
│  │  │  3. Parallel Agent Execution (up to 8)         │   │  │
│  │  │  4. Report Compilation                         │   │  │
│  │  └────────────────────────────────────────────────┘   │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │                               │
│  ┌──────────────────────────▼────────────────────────────┐  │
│  │                   PostgreSQL (Prisma)                  │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key external services:**

| Service | Role |
|---|---|
| Clerk | User authentication and session management |
| GitHub App (Octokit) | Repository access, OAuth, issue creation |
| OpenAI (GPT-4o) | LLM backbone for agent reasoning |
| Google Gemini | Supplementary LLM |
| Inngest | Background job orchestration and retries |
| E2B Code Interpreter | Sandboxed code execution during analysis |
| Firecrawl | Web scraping for external context |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| UI | React 19, Tailwind CSS 4, shadcn/ui, Radix UI |
| Animations | Motion (Framer Motion) |
| Authentication | Clerk |
| Database | PostgreSQL, Prisma ORM 7 |
| AI / LLM | LangChain, LangGraph, OpenAI, Google Gemini |
| Agent Framework | Inngest Agent Kit |
| Background Jobs | Inngest |
| Code Parsing | web-tree-sitter (AST), tree-sitter-wasms |
| GitHub Integration | @octokit/rest, @octokit/auth-app |
| Code Execution | E2B Code Interpreter |
| Web Scraping | Firecrawl |

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (recommended) or npm/yarn
- PostgreSQL database
- GitHub App (for repository access)
- Clerk account (for authentication)
- OpenAI API key
- Inngest account (for background jobs)

### Installation

```bash
git clone <repo-url>
cd <repo-directory>
pnpm install
```

### Environment Variables

Create a `.env.local` file in the project root with the following variables:

```env
# App
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/growwise

# Clerk Authentication
CLERK_SECRET_KEY=sk_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_NAME=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."

# LLM APIs
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=

# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# Optional: E2B (sandboxed code execution)
E2B_API_KEY=

# Optional: Firecrawl (web scraping)
FIRECRAWL_API_KEY=
```

### Database Setup

```bash
# Generate Prisma client and run migrations
pnpm prisma migrate deploy

# Or for local development with migration creation
pnpm prisma migrate dev
```

### Running Locally

```bash
# Start the Next.js development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

To process background jobs locally, run the Inngest dev server in a separate terminal:

```bash
npx inngest-cli@latest dev
```

---

## Project Structure

```
.
├── actions/                    # Server actions (business logic)
│   ├── agents/                 # Eight specialized analysis agents
│   │   ├── ai-powered.ts
│   │   ├── auth.ts
│   │   ├── compute-heavy.ts
│   │   ├── content-heavy.ts
│   │   ├── db.ts
│   │   ├── event-driven.ts
│   │   ├── orchestrator.ts
│   │   ├── realtime.ts
│   │   ├── report-compiler.ts
│   │   └── transaction.ts
│   ├── analysis/               # Framework detection, classification, tools
│   │   └── tools/              # Individual code analysis tools (AST, imports, etc.)
│   ├── github/                 # GitHub API interactions
│   ├── firecrawl/              # Web scraping utilities
│   ├── chat.ts                 # Chat message persistence
│   ├── chatbot.ts              # AI chat response generation
│   ├── get-analysis-usage.ts   # Usage limit checks
│   ├── get-reported-repos.ts   # Fetches analyzed repositories
│   └── trigger-workflow.ts     # Kicks off Inngest analysis workflow
│
├── prisma/
│   ├── schema.prisma           # Database models
│   └── migrations/
│
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── agent/          # Agent orchestration and test endpoints
│   │   │   ├── github/         # GitHub OAuth and repository endpoints
│   │   │   ├── inngest/        # Inngest webhook handler
│   │   │   └── webhook/clerk/  # Clerk user sync webhook
│   │   ├── dashboard/          # GitHub settings page
│   │   ├── pricing/            # Pricing page
│   │   ├── contact/            # Contact page
│   │   ├── project/[id]/       # Report viewer and chat interface
│   │   ├── reports/[id]/       # Raw reports page
│   │   ├── layout.tsx          # Root layout (Clerk, fonts, metadata)
│   │   └── page.tsx            # Home page
│   │
│   ├── components/
│   │   ├── navigation.tsx
│   │   ├── github-section.tsx
│   │   ├── github-connect-button.tsx
│   │   ├── hero-section.tsx
│   │   ├── lamp-demo.tsx
│   │   ├── prompt-input.tsx
│   │   └── ui/                 # shadcn/ui primitives
│   │
│   ├── inngest/
│   │   ├── client.ts           # Inngest client
│   │   └── functions.ts        # analyzeRepositoryWorkflow definition
│   │
│   └── lib/
│       ├── github.ts           # GitHub token management and API helpers
│       ├── llm.ts              # LLM client configuration
│       ├── prisma.ts           # Prisma client singleton
│       ├── findings-parser.ts  # Parses raw agent output into typed findings
│       ├── utils.ts            # cn() utility and shared helpers
│       └── interface/tools.ts  # Shared tool type definitions
```

---

## Analysis Pipeline

When a user triggers an analysis, the following sequence runs:

1. **Framework Detection** (synchronous) — determines whether the repository is Next.js, React, or unsupported.
2. **Usage Check** — verifies the user has remaining free analyses (limit: 2).
3. **Inngest Workflow Trigger** — the analysis job is enqueued; the user is redirected to the project page immediately with the UUID.
4. **Business Classification** — the repository's `package.json`, dependencies, and directory structure are analysed to assign architectural archetypes and confidence scores.
5. **Orchestration Context Resolution** — the orchestrator determines which agents should run based on the detected archetypes.
6. **Parallel Agent Execution** — up to 8 specialized agents run concurrently, each using AST-level code analysis tools.
7. **Report Compilation** — the report compiler aggregates all agent findings into a structured XML report stored in the database.
8. **Frontend Polling** — the project page polls every 10 seconds until `compiledReport` is populated, then renders the parsed report.

---

## Specialized Agents

Each agent targets a specific architectural concern:

| Agent | Icon | Analyzes |
|---|---|---|
| `database-heavy` | 🗄️ | Query patterns, connection pooling, ORM usage, N+1 risks |
| `auth-heavy` | 🔐 | Authentication flows, session management, token handling |
| `compute-heavy` | ⚡ | CPU-bound operations, blocking code, worker usage |
| `ai-powered` | 🤖 | LLM integrations, prompt handling, model cost risks |
| `realtime` | 📡 | WebSocket usage, SSE, polling patterns, concurrency |
| `event-driven` | 🔔 | Queue integrations, event loop patterns, backpressure |
| `financial-transactional` | 💳 | Payment flows, idempotency, race conditions, retry logic |
| `content-heavy` | 🌐 | CDN patterns, media handling, bandwidth costs |

Each agent has access to a shared set of AST-level code analysis tools:

- `getRouteMap` — extracts all route definitions
- `getDependencies` — lists project dependencies
- `buildImportFrequencyMap` — identifies the most-imported modules
- `scanDatabaseAccess` — finds database query patterns
- `checkConnectionPool` — checks connection pool configuration
- `getSchemaDefinitions` — extracts Prisma/database schemas
- `getMiddlewareChain` — traces middleware usage
- `resolveImports` — follows import chains
- `traceFunction` — traces function call graphs

---

## API Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/github/status` | Check GitHub connection status |
| `POST` | `/api/github/install` | Initiate GitHub App OAuth |
| `GET` | `/api/github/callback` | Handle GitHub OAuth callback |
| `GET` | `/api/github/repositories` | List repositories for installation |
| `POST` | `/api/github/disconnect` | Revoke GitHub access |
| `POST` | `/api/agent/orchestrate` | Run all agents for a repository |
| `GET` | `/api/agent/repositories` | Get analysis-ready repositories |
| `POST` | `/api/inngest` | Inngest webhook handler |
| `POST` | `/api/webhook/clerk` | Clerk user sync webhook |

Individual agent test endpoints exist at `/api/agent/[type]-test` for isolated debugging.

---

## Usage

1. **Sign up** or log in via the Clerk-powered auth.
2. **Connect GitHub** — click "Connect GitHub & Import Repository" on the home page and complete the OAuth flow.
3. **Select a repository** from the dropdown list.
4. **Click Analyze** — the system checks your usage limit and queues the analysis job.
5. **Wait for the report** — you are redirected immediately; the page polls until analysis completes.
6. **Explore the report** — switch between the Birds-Eye View, Scale Issues, and Revenue Risk tabs.
7. **Chat with the report** — use the sidebar chat to ask questions, create GitHub issues, or request implementation plans.

---

## Deployment

The recommended deployment target is [Vercel](https://vercel.com).

```bash
# Production build (generates Prisma client then builds Next.js)
pnpm build

# Start production server
pnpm start
```

**Vercel-specific notes:**

- Set all environment variables in the Vercel project settings.
- Configure the `NEXT_PUBLIC_APP_URL` to the production URL.
- Set up the Clerk webhook to point to `https://<your-domain>/api/webhook/clerk`.
- Set up the Inngest integration and point the Inngest webhook to `https://<your-domain>/api/inngest`.
- Ensure `GITHUB_PRIVATE_KEY` is stored as a multi-line secret (newlines preserved).

---

## Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-feature`).
3. Make your changes and ensure the project builds cleanly (`pnpm build`).
4. Run the linter (`pnpm lint`).
5. Open a pull request with a clear description of the change.

---

*Gro(W)ise — Scale your business with confidence.*
