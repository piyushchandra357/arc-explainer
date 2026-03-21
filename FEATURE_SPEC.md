# ARC Explainer: Exhaustive Feature Specification Manual

## 1. Executive Summary

ARC Explainer is an exhaustive, full-stack research platform specifically tailored for analyzing AI performance on the Abstract Reasoning Corpus for Artificial General Intelligence (ARC-AGI). Engineered by a game producer and heavily integrated with bleeding-edge LLM APIs, it treats visual reasoning and classical environment benchmarks as first-class citizens.

**Core Directives:**
* **Strict SRP/DRY:** Distinct repositories (e.g., `AccuracyRepository.ts`, `CostRepository.ts`) own their data shapes. AI providers implement a unified interface.
* **Database-First State Management:** Transitory states are discarded. If it renders in the UI, it must exist in PostgreSQL. Components refetch on mutations.
* **Transparency & Reasoning Capture:** AI interactions are saved raw. Conversation chaining via `providerResponseId` retains encrypted context across turns.

---

## 2. Core Features & Domains

### 2.1 Puzzle Analyst (`/task/:taskId`)
**What it is:** A high-density grid viewer for examining an AI model's performance on a specific ARC task.

**How it works:**
* The component fetches a massive batch of `ExplanationData` using `usePaginatedExplanationSummaries` with `pageSize: 1000`.
* **Dynamic Layout Engine:** If a user clicks the "Correct" filter, the layout dynamically transitions to a two-column view (`lg:grid-cols-2`), pinning a `TaskEfficiencyLeaderboard` to the right-hand column while displaying the matching grids on the left.
* **Deep Linking:** URLs supporting `#correct` hashes or `?highlight=<id>` query parameters automatically expand the relevant row and scroll it into view, flashing a `ring-blue-400` border for 3 seconds (`setTimeout` driven visual feedback).
* **Code Fact:**
  ```tsx
  // Auto-scroll logic in PuzzleAnalyst.tsx
  const element = document.getElementById(`explanation-row-${highlightedId}`);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('ring-4', 'ring-blue-400', 'ring-opacity-50');
  }
  ```

### 2.2 Model Debate (`/debate/:taskId`)
**What it is:** An orchestration environment where one LLM critiques the incorrect reasoning of another LLM.

**How it works:**
* Filters existing explanations for incorrect answers (`correctness=incorrect`).
* If `?select=<id>` is present in the URL, `ModelDebate.tsx` auto-initiates the debate view for that specific explanation.
* **Data Flow:** When "Generate Challenge" is clicked, it calls `analyzeAndSaveMutation`. The backend (`puzzleAnalysisService.ts`) detects "Debate Mode" by looking for `originalExplanation` and `customChallenge` properties in the payload. It formulates a specific prompt pushing the challenger model to critique the original logic.
* **Database Traceability:** The new explanation is saved with `rebutting_explanation_id` pointing to the original ID. This allows the backend to reconstruct debate chains via recursive CTEs (`ExplanationRepository.getRebuttalChain()`).
* **UI Isolation:** `ModelDebate.tsx` is strictly an orchestrator; it delegates UI rendering to `PuzzleDebateHeader`, `ExplanationsList`, and `IndividualDebate`.

### 2.3 Progressive Reasoning & Conversation Chaining (`/discussion/:taskId`)
**What it is:** A multi-turn self-refinement loop where an AI is asked to improve upon its previous answer without wasting context tokens.

**How it works:**
* **Context Preservation:** Standard Chat Completions are stateless. ARC Explainer uses the modern **Responses API**. When an o-series or Grok model finishes an analysis, it returns a `providerResponseId` alongside the text.
* **Execution:** When refining, the client sends this `providerResponseId` as `previousResponseId`. The backend (e.g., `openai.ts`) passes this ID to the provider, instructing it to seamlessly restore its encrypted reasoning trace (`reasoning.encrypted_content`) and continue.
* **Eligibility Filtering:** The `useEligibleExplanations` hook filters for analyses completed within the last 30 days that possess a `providerResponseId`, presenting them on the `EligibleAnalysisLaunchpadCard`.

### 2.4 RE-ARC Bench (`/re-arc`)
**What it is:** A zero-trust, self-service dataset generation and solver evaluation engine built on the Python `re-arc` library.

**How it works (Generation):**
* **Cryptographic Seeding:** A user provides a `seedId` (usually a timestamp). The Node backend combines this with a server-side `RE_ARC_SEED_PEPPER` via HMAC-SHA256 to generate an `internalSeed`.
* **Python Invocation:** Node spawns `external/re-arc/lib.py --seed <internalSeed>`.
* **Caching:** As Python streams generated tasks via NDJSON, Node intercepts them. It strips the true output grids and stores them in a memory LRU cache (`__testOnly_datasetCache`), sending the obfuscated tasks back to the user as a gzip stream.

**How it works (Evaluation):**
* Users upload a JSON array of `[ { attempt_1: Grid, attempt_2: Grid } ]` matching the exact length of the test cases.
* **Decoding:** Node decodes the obfuscated task IDs using the server pepper to recover the `seedId`.
* **Scoring Logic Parity:** Mirroring the official ARC-AGI Python benchmarking script, `reArcService.ts:scoreTask` iterates through test cases. If *either* `attempt_1` OR `attempt_2` strictly equals the ground truth (`gridsEqual()`), the test case is marked solved.
* **Performance:** If the `seedId` hits the `__testOnly_datasetCache`, evaluation takes milliseconds. If it misses, Python is silently re-spawned to regenerate the ground truth on the fly.

### 2.5 Worm Arena / SnakeBench (`/worm-arena/live`)
**What it is:** An orchestrator for LLM vs. LLM "Snake" matches. Assesses spatial reasoning and planning.

**How it works (Live Matches):**
* **Setup View:** Users select two OpenRouter-compatible models. The backend spawns a Python subprocess running the SnakeBench environment.
* **Dual Rendering:** Users can toggle between "Cartoon View" (a graphical UI with live reasoning panels) and "Console View" (a raw terminal mirror of the Python output).
* **Streaming Protocol:**
    * `WormArenaLive.tsx` uses `useWormArenaStreaming` to subscribe to an SSE channel (`/api/wormarena/stream/:sessionId`).
    * The UI continuously updates variables like `wallClockSeconds` (time since match start), `playerAScore` (parsed from inline JSON in the stream message), and live LLM reasoning logs.
* **Reporting (`WormArenaReportService.ts`):** Post-match, the platform builds an aggressive, eSports-style markdown report. It pushes match stats to `gpt-5-mini-2025-08-07` using Structured Outputs (`json_schema`), demanding keys like `deathAnalysis` and `toughOpponents`.

### 2.6 ARC3 Agent Playground (`/arc3/playground`)
**What it is:** A modular framework for ARC-AGI-3 grid environments.

**How it works:**
* **File Architecture:** Instead of a monolithic database, ARC3 relies on a registry pattern. `shared/arc3Games/` holds independent TS definitions and replay artifacts for each game type.
* **Community Sandbox:** Users submit `.py` scripts. These are stored with `status='pending'` to prevent arbitrary code execution on the server. Admins must explicitly hit `/api/arc3-community/submissions/:id/publish` to approve and run the code.

---

## 3. Systems Integration: PythonBridge (`pythonBridge.ts`)

**What it is:** The communication lifeline between the fast Node.js HTTP layer and the heavy, blocking Python ecosystem (Solvers, Re-Arc, SnakeBench).

**How it works:**
* **Spawning:** `spawn(pythonBin, [wrapperPath], spawnOpts)` creates the child process.
* **Data Transit:** Node writes initial configuration JSON to `child.stdin`. Python writes continuous NDJSON (Newline Delimited JSON) back to `child.stdout`.
* **Resilience:** The Node `readline` interface parses `stdout`. If a line fails `JSON.parse` (which happens frequently if an LLM randomly spits out raw text), the Bridge gracefully catches it and forwards it as a standard `{ type: 'log' }` event rather than crashing the stream.
* **Code Fact:** To prevent Windows from corrupting emojis (e.g., 📡) or complex grid characters, the bridge forces UTF-8 encoding natively at spawn:
  ```typescript
  const envUtf8 = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
  ```

---

## 4. Analytics & Cost Mathematics

**Accuracy vs. Debate Accuracy:**
* `AccuracyRepository.ts` separates signal from noise. To calculate true 1-shot solver accuracy, it queries the database explicitly filtering `WHERE rebutting_explanation_id IS NULL`. Debate accuracy does the exact inverse, isolating the model's critique capabilities.

**Head-to-Head Comparisons (`/api/metrics/compare`):**
* Supports multi-model union math. If comparing `model-A-attempt1` vs `model-A-attempt2`, the backend calculates the union (treating it as solved if *either* attempt succeeded), matching official ARC evaluation standards.

**Cost Tracking (`CostRepository.ts`):**
* Costs are tracked rigorously per token. To prevent fragmented data, the repository automatically normalizes model names (stripping `:free`, `:beta`, etc.) before aggregating `sum(estimated_cost)`, utilizing highly optimized compound indexes `(model_name, estimated_cost)`.

---

## 5. Potential Pitfalls & Areas for Architectural Improvement

1. **RE-ARC Cache Bloat Risk (`SimpleLRU`):**
   * **Issue:** `reArcService.ts` implements a naive in-memory `SimpleLRU` cache capped at 50 datasets. Synthetic datasets are memory-heavy. High concurrency across different generated `seedId`s will thrash this cache, triggering expensive synchronous Python re-spawns on cache misses.
   * **Fix:** Transition the `__testOnly_datasetCache` to Redis.

2. **Zombie Processes in PythonBridge:**
   * **Issue:** `reArcService.ts` correctly utilizes an `InactivityTimeoutManager` to kill hung Python processes. However, the generic `PythonBridge` executing tools like `Saturn` does not. If Saturn hangs indefinitely on an LLM API call, the Node thread will wait forever.
   * **Fix:** Port the `InactivityTimeoutManager` globally into `pythonBridge.ts`.

3. **Worm Arena State Desynchronization:**
   * **Issue:** Python emits frame updates via stdout, which Node relays via SSE. If the user disconnects mid-match, Node stops tracking the SSE stream, but Python continues updating the Database.
   * **Fix:** Ensure `GameWriteRepository` operations are strictly atomic and rely on Python's final `{ type: 'final' }` NDJSON event rather than intermediate Node state tracking.

4. **Structured JSON Fallback Fragility:**
   * **Issue:** In `WormArenaReportService.ts`, if the Responses API `output_parsed` object is missing, the service attempts a raw `JSON.parse(responseAny.output_text)`. If the LLM wraps its JSON in markdown (e.g., ` ```json {...} ``` `), the parse will throw an exception, resulting in a blank insights report.
   * **Fix:** Implement a robust regex sanitizer to strip markdown wrappers before attempting the fallback parse.

5. **N+1 Debate Chain Query Overhead:**
   * **Issue:** Fetching a debate chain (`GET /api/explanations/:id/chain`) uses a recursive CTE to traverse `rebutting_explanation_id`. On a heavily populated database with long chains, this read operation scales poorly.
   * **Fix:** Denormalize a `root_explanation_id` onto all child rows to allow a flat `SELECT * WHERE root = X` query.

---
*End of Exhaustive Feature Specification Manual*