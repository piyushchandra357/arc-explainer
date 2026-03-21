# ARC Explainer: In-Depth Feature Specification Document

## 1. Executive Summary

**Mission:** ARC Explainer is a full-stack platform built as a personal research suite for the Abstract Reasoning Corpus for Artificial General Intelligence (ARC-AGI). Its goal is to provide an exhaustive set of tools for researchers to analyze, explore, debate, and benchmark AI agents (e.g., OpenAI's o-series, Claude 3.5 Sonnet, xAI Grok-4, OpenRouter models).

**Core Philosophies:**
- **Database-First Execution:** Every UI element must represent existing PostgreSQL data. Temporary API states are not rendered; UI components re-fetch after DB writes.
- **Single Responsibility Principle (SRP) & DRY:** Logic is tightly segregated. Repositories (Accuracy, Trustworthiness, Cost, Metrics, SnakeBench sub-repos) solely own their SQL.
- **Multi-Domain Platform:** Supports classical ARC1/2/3 grids, the generative RE-ARC Bench tasks, and Worm Arena (SnakeBench environment testing), effectively treating diverse AI tests seamlessly.

---

## 2. System Architecture & Internal Workings

### 2.1 Technology Stack
- **Frontend:** React 18, TypeScript, Vite, Wouter (Routing), TanStack Query, TailwindCSS, `shadcn/ui`, `DaisyUI`.
- **Backend:** Node.js, Express.js, TypeScript (ESM).
- **Database:** PostgreSQL accessed via Drizzle ORM (with in-memory fallback).
- **AI Integrations:** Unified `BaseAIService` abstracting multiple APIs (OpenAI Responses API, Anthropic, Google Gemini, xAI/Grok, OpenRouter).
- **Subprocesses:** Dedicated `PythonBridge` orchestrates execution of Python-based reasoning models and visual solvers (Saturn, Grover, Poetiq, Beetree, SnakeBench).
- **Real-time / Streaming:** Server-Sent Events (SSE) and WebSockets handle token-by-token text generation and frame-by-frame game live streams.

### 2.2 Python Subprocess Integration (`pythonBridge.ts`)
The `PythonBridge` is the foundational layer for integrating heavy computational or Python-specific AI models.
* **Protocol:** Communication happens over `stdin`/`stdout` using NDJSON (Newline Delimited JSON).
* **Execution Flow:**
    * Node spawns a child process (e.g., `saturn_wrapper.py`, `beetree_wrapper.py`).
    * Node pushes initial configurations and contexts via `stdin`.
    * Python streams output back. Events can include `{type: 'start'}`, `{type: 'progress'}`, `{type: 'log'}`, and `{type: 'final'}`.
    * Node captures the final JSON block, aggregates verbose logs (stderr + stdout buffer), and fulfills the HTTP/SSE request to the client.
* **UTF-8 Hardening:** The environment sets `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` to prevent issues with emojis and non-standard characters crashing the bridge on Windows.

---

## 3. Core Features & Domains (In-Depth)

### 3.1 ARC-AGI Explainer (Puzzle Analysis & Exploration)

**Puzzle Analyst Mode (`/task/:taskId`):**
A dense, high-data UI grid for researchers to view an ARC task.
* **Flow:** The UI queries the `ExplanationRepository` for all attempts made on this task. It groups the explanations by model and correctness, rendering input/output grids dynamically.

**Model Debate & Rebuttals:**
Allows an AI to analyze and critique the incorrect reasoning of another AI.
* **Data Model:** Explanations have a self-referential `rebutting_explanation_id`.
* **Flow:** A `POST` request to `/api/puzzle/analyze/:taskId/:model` with "Debate Mode" active takes the original `ExplanationData`, formulates a challenge prompt, and streams the rebuttal.
* **Recursion:** `/api/explanations/:id/chain` uses a recursive CTE in PostgreSQL to walk the chain of rebuttals back to the original thought.

**Conversation Chaining (Responses API):**
* **Context Preservation:** Leverages provider-native IDs (OpenAI's o-series, Grok-4) to retain memory without resending massive prompt histories.
* **Flow:**
    1. First analysis returns a `providerResponseId`. This is stored in the DB.
    2. Subsequent requests from the UI (like in the PuzzleDiscussion view) send `previousResponseId`.
    3. The backend sends this to the provider, instructing the AI to remember its prior reasoning tokens.

**Streaming Analyses (SSE Handshake):**
* Circumvents URL limits for massive prompts.
* **Step 1:** Client `POST /api/stream/analyze` with the massive payload. Server caches this using an LRU mapping, returning `{ sessionId, expiresAt }`.
* **Step 2:** Client opens an `EventSource` (`GET /api/stream/analyze/:taskId/:modelKey/:sessionId`). Server pulls the cached payload, executes the LLM call, and pipes `stream.chunk` events back.

### 3.2 RE-ARC Bench

A rigorous verification layer built by porting the `arc_agi_benchmarking` Python repository to evaluate synthetic datasets.

**Dataset Generation (`generateDataset`):**
* **Cryptographic Determinism:** To prevent data leaks, public `seedId`s are provided by users, but the backend derives an `internalSeed` using an HMAC-SHA256 hash with a server-side `RE_ARC_SEED_PEPPER`.
* **Execution:** Spawns a Python subprocess executing `external/re-arc/lib.py`. It streams JSON definitions of synthetic tasks. The Node backend parses these, caches the true output grids via a `SimpleLRU` cache (`__testOnly_datasetCache`), and yields the tasks *without* outputs to the client as a gzip stream.

**Submission Evaluation (`evaluateSubmission`):**
* **Decoding:** Reads the submitted JSON. Recovers the `seedId` and `internalSeed` from the obfuscated task IDs using the server pepper.
* **Caching Strategy:**
    * **Cache Hit:** If the dataset exists in `__testOnly_datasetCache`, it avoids the expensive Python regeneration entirely.
    * **Cache Miss:** Re-spawns Python to regenerate the ground-truth outputs silently in the background.
* **Scoring Algorithm Parity:** Implements `scoreTask(testCases, predictions)`. Mirroring the official ARC-AGI rules, it evaluates: `attempt1Correct = gridsEqual(...) || attempt2Correct = gridsEqual(...)`. A task's total score is solved test cases / total test cases.
* **Streaming Feedback:** Emits SSE progress events as tasks are evaluated, culminating in a `score` or `mismatches` (if the submission array size doesn't match the test cases).

### 3.3 Worm Arena & SnakeBench

An isolated "Snake" environment for observing LLM planning and spatial reasoning over sequential rounds.

**Match Execution:**
* Python loops through game rounds, executing LLM inference at each step to determine Snake movement.
* Database updates occur at every round to track live state.

**Insights Reporting (`WormArenaReportService`):**
* Orchestrates an LLM-powered summary of a model's performance.
* **Flow:**
    1. Aggregates data: win rates, cost, average survival rounds, frequent death causes, and nemesis opponents.
    2. Constructs a massive context payload and hits the `INSIGHTS_SUMMARY_MODEL` (e.g., `gpt-5-mini`) via the Responses API.
    3. **Structured Outputs:** Forces the model to respond adhering to a strict JSON schema (`WormArenaModelInsightsSummary`), containing predefined keys like `summary`, `deathAnalysis`, `toughOpponents`, and `recommendations`.
    4. **Output formatting:** Takes the structured JSON and formats it into a Markdown document and a 280-character Tweet (incorporating variables like `@arcprize` and dynamic URLs).
* **Streaming:** Implements `streamModelInsightsReport` to provide real-time chunking of the LLM's analytical stream directly into the UI dashboard.

### 3.4 ARC3 Agent Playground

A highly modularized approach to ARC-AGI-3 testing.
* **Data Organization:** Each test environment is isolated inside `shared/arc3Games/`. It maps specific `replays` and metadata rules exclusively for that domain.
* **Submission Moderation:** Given the execution risk of raw `.py` files, community submissions default to `status='pending'` and require a token-gated `/api/arc3-community/submissions/:id/publish` call by an admin before becoming active in the system.

---

## 4. Analytics, Metrics & Cost Tracking

* **Cost Normalization (`CostRepository`):** Centralizes cost calculation. Strips suffixes (`:free`, `:beta`) to sum true historical spend correctly. Queries hit optimized indexes `(model_name, estimated_cost)`.
* **Pure Accuracy vs Debate Accuracy:**
    * `GET /api/feedback/accuracy-stats` filters out rebuttals (`WHERE rebutting_explanation_id IS NULL`) to measure true 1-shot ability.
    * `GET /api/feedback/debate-accuracy-stats` does the inverse to judge an AI's critical review skills.
* **Model-to-Model Union Math:** `/api/metrics/compare` analyzes overlap (e.g., did Model A solve what Model B missed?). Supports multi-attempt aggregations (treating `model-attempt1` and `model-attempt2` as a unioned solver to match ARC competition logic).

---

## 5. Potential Pitfalls & Areas for Improvement

1. **RE-ARC Cache Bloat Risk:**
   * **Issue:** The `__testOnly_datasetCache` uses a `SimpleLRU` capped at 50 datasets. Since full datasets can be large, high concurrency on different seeds could thrash the cache, resulting in constant Python re-spawns and high latency.
   * **Improvement:** Migrate the RE-ARC cache to Redis or Memcached if concurrent evaluations scale.

2. **Python Subprocess Zombies (`pythonBridge.ts`):**
   * **Issue:** While `reArcService.ts` has a robust `InactivityTimeoutManager`, the general `PythonBridge` executing long-running visual solvers (like Saturn) lacks a strict internal inactivity timeout. If Python hangs without crashing, the Node promise will hang indefinitely.
   * **Improvement:** Implement standard timeout/kill logic across all `spawn()` instances in `pythonBridge.ts`.

3. **Data Leakage in OpenRouter Discovery:**
   * **Issue:** Admin ingestion endpoints auto-sync models from HuggingFace and OpenRouter. If bad actors upload maliciously formatted dataset keys on HuggingFace, it could corrupt internal DB tracking IDs.
   * **Improvement:** Ensure stringent Zod validation occurs *before* database insertion during `ingest-hf` scripts.

4. **Structured JSON Fallbacks:**
   * **Issue:** Currently, if `output_parsed` is missing during Insights generation, `WormArenaReportService` attempts a raw `JSON.parse(llmSummary)`. If the LLM generates markdown wrapped JSON (e.g. ` ```json {...} ``` `), the parse will throw.
   * **Improvement:** Add a regex sanitizer to strip markdown code blocks from the raw `output_text` before falling back to `JSON.parse`.

---
*End of In-Depth Feature Specification Document*