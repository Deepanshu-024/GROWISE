# Chapter 3: Analysis

To achieve the objectives outlined in the previous chapter, the automated repository analysis platform relies on a sophisticated, multi-layered analytical pipeline. This chapter details the core analytical methodologies employed by the system, mirroring the rigor of data science pipelines but applied to the domain of software source code. 

The analysis phase is divided into three primary components: the preprocessing and categorization of the repository (Archetype Detection), the structural analysis performed by the LangGraph agents, and the evaluation of the system's own performance and reliability.

## 3.1 Codebase & System Analysis

Just as a machine learning model requires clean, well-formatted data to make accurate predictions, an LLM-based code agent requires a highly structured, contextualized view of a repository to perform an effective audit. Feeding an entire, unorganized repository into an LLM is analogous to feeding raw, unscaled image pixels into a simple neural network—the noise overwhelms the signal.

### 3.1.1 Repository Preprocessing and Archetype Detection

The first analytical step is "Archetype Detection." Before any deep analysis occurs, the system must understand the fundamental nature of the codebase it is evaluating. Is it a heavily data-driven backend? Is it a frontend-heavy marketing site? Is it a financial transaction processor?

**The Business Classification Engine**
Upon receiving a repository URL, the system initiates a preprocessing script that scans the root directory, `package.json`, configuration files (like `prisma/schema.prisma`), and high-level routing structures. This initial scan does not look for bugs; it looks for *indicators of intent*.

*   **Database-Heavy Indicators:** The presence of ORM configuration files (Prisma, TypeORM), a high volume of SQL files, or extensive data-fetching utility functions heavily weights the repository towards a "database-heavy" archetype.
*   **Auth-Heavy Indicators:** The detection of libraries like NextAuth, Clerk, or extensive middleware files managing JWTs (JSON Web Tokens) flags the repository as "auth-heavy."
*   **Transactional Indicators:** The presence of Stripe SDKs, cart management states, or webhook handlers categorizes the project as "financial-transactional."

By successfully categorizing the repository, the system drastically narrows the search space. If a repository is 90% static content and 10% routing, spawning a database optimization agent is a waste of computational resources and API limits. Archetype detection ensures that only the relevant, specialized AI agents are deployed.

### 3.1.2 Multi-Agent Model Analysis

Once the archetypes are defined, the LangGraph orchestrator takes over. LangGraph is a framework specifically designed for building stateful, multi-agent applications with LLMs. Unlike a standard linear LangChain process, LangGraph allows for cyclical, graph-based workflows, enabling agents to reason, delegate, and iterate.

**The Anatomy of a Specialized Agent**
Each agent deployed by the orchestrator (e.g., the `runDatabaseAgent` or `runAuthAgent`) is initialized with a distinct persona and a specific set of tools. The analytical strength of the system relies entirely on the precise tuning of these agents.

1.  **System Prompts:** The agents are not given generic instructions like "find bugs." They are given hyper-specific directives. For example, the Database Agent is instructed to specifically look for "missing composite indexes," "N+1 query patterns within loops," and "improper connection pooling."
2.  **Abstract Syntax Tree (AST) Search Tools:** The agents are equipped with the `searchCodeTool`. Instead of executing raw `grep` commands, this tool leverages AST parsing (via Tree-sitter). When an agent needs to find where a database query is executed, the AST tool structurally parses the TypeScript files, isolates the exact function invocations, and returns only the relevant logical blocks. This strips away irrelevant comments and formatting, providing the LLM with pure, high-density context.
3.  **Context Injection (Security):** During this phase, security is paramount. Agents cannot be trusted with hardcoded GitHub personal access tokens. Instead, the orchestrator utilizes a "context schema" pattern. The GitHub App installation ID is dynamically converted into short-lived, repository-scoped access tokens. These tokens are injected into the agent's context strictly for the duration of the analysis graph execution, ensuring complete credential security.

### 3.1.3 Performance and Reliability Analysis

An enterprise-grade analysis tool must not only be smart; it must be resilient. Analyzing a massive repository involving hundreds of file reads and thousands of lines of code generates a tremendous volume of API calls to both GitHub and the LLM provider (OpenAI/Anthropic).

**GitHub Rate Limit Handling**
A critical area of analysis involves how the system handles the strict rate limits imposed by the GitHub API. If an agent attempts to recursively read 50 files simultaneously, GitHub will block the requests, causing the entire agent to crash silently.
The system incorporates robust, exponential backoff and retry logic wrapped around the Octokit (GitHub API) clients. When the orchestrator detects an HTTP 403 (Rate Limit Exceeded) or 429 (Too Many Requests), it explicitly halts the agent's execution thread, calculates the required wait time based on the GitHub response headers, and resumes the analysis only when the limit resets.

**Agent Execution Tracking and SSE**
The performance of the agents themselves is continuously analyzed in real-time. The system tracks the `executionTimeMs` and the `totalToolCalls` for every agent. This data is critical for understanding the computational cost of the analysis.
*   If an agent takes 50 tool calls to find a single database query, its system prompt is likely too vague, causing it to "thrash" around the repository.
*   If an agent fails, the orchestrator catches the error, marks the archetype status as "failed," and gracefully continues executing the remaining agents in parallel.

These performance metrics, along with the actual risk findings, are streamed back to the frontend UI using Server-Sent Events (SSE). This real-time stream transforms what would be a long, opaque loading screen into a transparent, engaging dashboard where users can literally watch the AI "think," read files, and evaluate their architecture line-by-line.
