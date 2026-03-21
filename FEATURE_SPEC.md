# ARC Explainer: Comprehensive Feature Specification Document

## 1. Executive Summary

**Mission:** ARC Explainer is a comprehensive, full-stack platform built as a personal research suite for the Abstract Reasoning Corpus for Artificial General Intelligence (ARC-AGI). Designed by a video game producer, its primary goal is not to "solve" ARC but to provide an exhaustive set of tools for researchers to analyze, explore, debate, and benchmark AI agents (such as OpenAI's o-series, Claude 3.5 Sonnet, xAI Grok-4, Google Gemini, and OpenRouter models) working on the benchmark.

**Core Philosophies:**
- **Database-First Execution:** Everything rendered in the UI must exist in PostgreSQL. State is synchronized via DB reads rather than relying on ephemeral API responses.
- **Single Responsibility Principle (SRP) & DRY:** Distinct repositories and services segregate logic (e.g., Accuracy, Trustworthiness, Cost, Metrics, and SnakeBench).
- **Transparency & Verifiability:** AI reasoning is preserved explicitly (via conversation chaining and raw response storage). AI costs and token metrics are comprehensively tracked.
- **Multi-Domain Platform:** Supports ARC1/2/3 grids, the RE-ARC Bench generative tasks suite, and Worm Arena (SnakeBench), treating general visual reasoning and classic environment benchmarks seamlessly.

---

## 2. System Architecture

### 2.1 Technology Stack
- **Frontend:** React 18, TypeScript, Vite, Wouter (Routing), TanStack Query, TailwindCSS, `shadcn/ui` and `DaisyUI` components.
- **Backend:** Node.js, Express.js, TypeScript (ESM).
- **Database:** PostgreSQL accessed via Drizzle ORM (with in-memory fallback).
- **AI Integrations:** Unified `BaseAIService` abstracting multiple APIs (OpenAI Responses API, Anthropic, Google Gemini, xAI/Grok, DeepSeek, OpenRouter).
- **Solvers & Scripts:** Python sub-processes for solvers like Saturn, Grover, Poetiq, Beetree, and SnakeBench.
- **Real-time / Streaming:** Server-Sent Events (SSE) and WebSockets for token-by-token analysis streams and live Worm Arena matches.

### 2.2 Domain Segregation (Server-Side)
- **Repositories:** `AccuracyRepository`, `CostRepository`, `TrustworthinessRepository`, `MetricsRepository`, `ExplanationRepository`, and dedicated Worm Arena Repositories (`GameReadRepository`, `GameWriteRepository`, `LeaderboardRepository`, `CurationRepository`, `AnalyticsRepository`).
- **Services:** `puzzleAnalysisService`, `streaming/analysisStreamService`, `snakeBenchService`, `reArcService`, `WormArenaReportService`, and specialized AI Provider services.
- **Python Bridge:** Orchestrates execution of Python-based reasoning models and visual solvers (`pythonBridge.ts`).

---

## 3. Core Features & Domains

### 3.1 ARC-AGI Explainer (Puzzle Analysis & Exploration)
This domain allows users to browse ARC tasks, generate AI solutions, and evaluate model reasoning.

* **Puzzle Browser & Examiner:** Interactive UIs for viewing input/output grids, test cases, and community/AI explanations.
* **Puzzle Analyst Mode (`/task/:taskId`):** High-density grid of analyses.
* **AI Explanations & Predictions:** Generating text explanations and grid predictions using various AI providers.
* **Model Debate & Rebuttals:**
  * Allows one AI model to critique or challenge the reasoning of another.
  * Rebuttal chains are stored chronologically using `rebutting_explanation_id`.
* **Conversation Chaining (Responses API):** Multi-turn context retention native to the provider (OpenAI o-series, Grok-4). Keeps an AI's previous reasoning steps (via `providerResponseId`) for seamless follow-ups without token waste.
* **Structured Outputs:** Leverages provider JSON schemas (OpenAI structured outputs, xAI Grok JSON schema) to guarantee strict output formats for puzzle answers.
* **Streaming Analysis:** Token-by-token output streamed to the client using SSE with a two-step handshake (`POST /api/stream/analyze` -> `GET /api/stream/analyze/:sessionId`).

### 3.2 RE-ARC Bench
A self-service platform for generating unique ARC evaluation datasets and scoring AI solver submissions. Contributed by the community.

* **Dataset Generation (`/api/rearc/generate`):** Generates cryptographically unique 120-task evaluation datasets natively in Python.
* **Submission Evaluation (`/api/rearc/evaluate`):** Upload solver submissions (JSON format) and evaluate them against the dataset. Uses an LRU cache for high-speed evaluation.
* **Scoring Logic Parity:** Faithfully implements the official ARC-AGI scoring algorithm (a test pair is solved if ANY of 2 attempts matches the ground truth).
* **Leaderboards & Efficiency Plots:** Visualizes model efficiency, tracking how models scale reasoning vs. accuracy.

### 3.3 Worm Arena & SnakeBench
A platform for running AI vs. AI "Snake" environment matches.

* **Match Orchestration:** Run single matches (`/api/snakebench/run-match`) or batches between different LLM models.
* **Live Streaming:** Real-time match playback using SSE (`/api/wormarena/stream/:sessionId`).
* **Greatest Hits:** Curated library of interesting, high-cost, or extremely long matches.
* **Metrics & Leaderboards:** TrueSkill algorithm rankings, 30-apple placement distributions, run-length charts, and streaming model insight reports.

### 3.4 ARC3 Agent Playground
Integration for the newly-minted ARC-AGI-3 environment.

* **Playground (`/arc3/playground`):** Watch agents (Codex, OpenRouter, Haiku) solve real ARC-AGI-3 games.
* **Modular Structure:** `shared/arc3Games/` holds per-game registry files, explicit replays, and metadata.
* **Community Submissions:** Token-gated moderation system to approve/reject community `.py` submissions for the ARC3 arena.

---

## 4. Analytics, Metrics & Cost Tracking

The platform provides an extensive suite of metrics to study model effectiveness transparently:

* **Accuracy Statistics (`/api/feedback/accuracy-stats`):** Pure 1-shot puzzle solving accuracy (excludes debate rebuttals). Provides fair apples-to-apples comparisons.
* **Debate Accuracy (`/api/feedback/debate-accuracy-stats`):** Success rates specifically for AI challenges/rebuttals.
* **Model-to-Model Comparison (`/api/metrics/compare`):** Head-to-head performance across specific datasets, showing intersection and union stats.
* **Cost Tracking (`/api/metrics/costs/*`):** Comprehensive token usage and dollar cost tracking by model, aggregated via the `CostRepository`. Prevents overspending and highlights model efficiency.
* **Trustworthiness:** Metrics estimating how often a model's self-reported confidence aligns with its actual correctness.
* **Model Dataset Explorer (`/api/model-dataset/*`):** Dynamically discovers datasets (eval, training, eval2) and queries model success rates against them.

---

## 5. Administrative & Maintenance Tools

* **Bring Your Own Key (BYOK):** Production mode enforces user-provided API keys for premium models, ensuring the platform remains free to host.
* **Dataset Ingestion (`/admin/ingest-hf`):** Tools to pull bulk prediction data from HuggingFace datasets or Johanland into the SQL database.
* **OpenRouter Discovery:** Scripts to dynamically ingest and synchronize model catalogs from OpenRouter.

---

## 6. Verification & Implementation Notes

### Correctness and Scoring (Critical Implementation Detail)
The TypeScript implementation of the RE-ARC evaluation strictly mirrors the Python equivalent (`arc_agi_benchmarking/scoring/scoring.py`).
* **Rule:** A task's test case is marked correct if either `attempt_1` OR `attempt_2` matches the exact output grid.
* **Note on Verification:** Currently, the TypeScript backend performs identity/equality grid matching. If future RE-ARC tasks utilize non-identity custom verification rules, the evaluation must be shifted entirely to the Python subprocess verifiers.

### Streaming Architecture
The platform utilizes a robust SSE (Server-Sent Events) mechanism for analyses and live game arenas.
* **Handshake Protocol:** The client first sends a `POST` request to prime the server, which caches the payload and returns a `sessionId`. The client then opens an `EventSource` (`GET`) with that ID. This circumvents URL length limits for complex prompt payloads.

### UI Principles
* UIs are designed to be dynamic. Long-running configuration panels (e.g., Debate, Streaming runs) must organically collapse or disable themselves once processing begins, replacing static views with live-streaming states.

---

## 7. Analysis of Potential Issues & Areas for Improvement

Based on a deep review of the codebase documentation (`AGENTS.md`, `CLAUDE.md`, and `EXTERNAL_API.md`), here are potential areas where implementations might go wrong or could be improved:

1. **RE-ARC Scoring Single Source of Truth:**
   * **Issue:** Currently, TypeScript manually compares grids for RE-ARC evaluation (`reArcService.ts:scoreTask()`). While this works for identity-based tasks, it breaks the DRY principle regarding the official Python scoring library.
   * **Improvement:** The system should be refactored to delegate all RE-ARC scoring directly to the Python subprocess (`external/re-arc/verifiers.py`). This future-proofs the app for complex task types.

2. **Database Auto-migration Risks:**
   * **Issue:** Running `drizzle-kit push` auto-creates/modifies tables. Since `public.games` (SnakeBench) and ARC data are intimately linked but sometimes lack local file parity (e.g., Greatest Hits without local JSON replays), destructive migrations could orphan data.
   * **Improvement:** Use versioned SQL migrations (`drizzle-kit generate` followed by `drizzle-kit migrate`) for production rather than `db:push`.

3. **OpenAI Responses API Handshake Complexity:**
   * **Issue:** The custom `POST` -> `GET` SSE handshake requires careful payload caching. If the cache is not cleared correctly upon sudden client disconnects, it could cause memory leaks.
   * **Improvement:** Ensure aggressive garbage collection and hard TTLs on the cached SSE payloads in `storage.ts`.

4. **Structured Outputs Strictness:**
   * **Issue:** xAI's Grok API occasionally chokes on strict JSON schema definitions.
   * **Mitigation (Already Implemented, but fragile):** The system catches `400/422/503` errors and retries without a schema, falling back to text parsing. This parsing logic must be heavily unit-tested.

5. **N+1 Query Problems in Debate Chains:**
   * **Issue:** Querying debate chains (`GET /api/explanations/:id/chain`) relies on recursive CTEs in PostgreSQL. Deep chains might become expensive to compute.
   * **Improvement:** Cache debate chains or denormalize the root explanation ID to avoid recursive lookups on read-heavy paths.

6. **Worm Arena State Duplication:**
   * **Issue:** Python emits per-round SnakeBench logs, but Express wraps this into SSE. If Express and Python lose sync, the UI might show a completed match without final DB writes.
   * **Improvement:** Ensure atomic transactions when Python completes a match and Express records the result in the `GameWriteRepository`.

---
*End of Feature Specification Document*
