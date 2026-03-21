# ARC Explainer: Master Feature & Technical Specification Blueprint
*An exhaustive, code-level documentation suite intended to act as a 1:1 blueprint for rebuilding the ARC Explainer repository from scratch.*

## Table of Contents
1.  **System Architecture & Core Philosophy**
2.  **Database Schema & Drizzle ORM Models**
3.  **Repository Layer (Data Access & Analytics)**
4.  **AI Services & Integration Factory (`BaseAIService`)**
5.  **The Python Bridge (`pythonBridge.ts`)**
6.  **Streaming Protocol: SSE & Handshakes**
7.  **Core Domain 1: Puzzle Exploration & Analysis**
8.  **Core Domain 2: Model Debate & Progressive Reasoning**
9.  **Core Domain 3: RE-ARC Bench (Synthetic Evaluation)**
10. **Core Domain 4: Worm Arena (SnakeBench Live & Replays)**
11. **Core Domain 5: ARC3 Agent Playground**
12. **Analytics, Cost Calculations, & Performance Tracking**
13. **Administrative Tooling & Ingestion Scripts**
14. **Frontend Architecture & React Hooks**

---

## 1. System Architecture & Core Philosophy

**Overview:**
ARC Explainer is a monolithic, highly structured TypeScript repository bridging a Vite/React 18 frontend with an Express/Node.js backend, powered by PostgreSQL (via Drizzle ORM) and augmented by Python subprocesses. It is a research suite for the Abstract Reasoning Corpus for Artificial General Intelligence (ARC-AGI).

**The "Database-First" Rule:**
All components subscribe to a strict database-first rendering pattern. The UI *never* renders ephemeral API responses directly for permanent state. Instead:
1.  UI initiates a mutation (e.g., "Run Analysis", "Submit Move").
2.  Backend executes LLM/Python logic and writes to PostgreSQL.
3.  Backend returns success.
4.  Frontend invalidates TanStack Query caches and refetches the database state to re-render.

**Directory Structure:**
*   `client/src/`: React frontend (Pages, Components, Hooks, Contexts).
*   `server/`: Express backend (Controllers, Services, Repositories).
*   `shared/`: Universal TypeScript types, constants, and Zod schemas.
*   `external/`: Git submodules for core Python tooling (`re-arc`, `SnakeBench`).

---

## 2. Database Schema & Drizzle ORM Models

The application relies on a robust PostgreSQL schema defined using Drizzle ORM (`shared/schema.ts`). This schema must be strictly adhered to for state reconstruction.

### 2.1 `explanations` Table
The heart of ARC Explainer. Stores every AI inference, debate, and refinement.
**What it is used for:** Tracking all model attempts to solve a puzzle, storing the prompt used, the reasoning trace, the final grid prediction, the cost, and linking debate challenges to original responses.
**Code Fact:**
```typescript
export const explanations = pgTable('explanations', {
  id: serial('id').primaryKey(),
  puzzleId: text('puzzle_id').notNull(),
  modelName: text('model_name').notNull(),
  patternDescription: text('pattern_description'),
  solvingStrategy: text('solving_strategy'),
  hints: jsonb('hints'), // Array of strings
  predictedOutput: jsonb('predicted_output'), // 2D number array
  isPredictionCorrect: boolean('is_prediction_correct'),
  confidence: integer('confidence'),
  estimatedCost: real('estimated_cost'),
  // Debate & Progressive Reasoning Tracking
  rebuttingExplanationId: integer('rebutting_explanation_id'), // Self-referential FK
  providerResponseId: text('provider_response_id'), // Used for conversation chaining via Responses API
  multiTestResults: jsonb('multi_test_results'),
  rawApiResponse: jsonb('raw_api_response'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### 2.2 Worm Arena (SnakeBench) Tables
**What they are used for:** Tracking live matches between LLMs and historical MMR (Matchmaking Rating).
**Code Fact:**
```typescript
export const games = pgTable('games', {
  id: serial('id').primaryKey(),
  gameId: text('game_id').notNull().unique(), // Unique hash or UUID
  modelA: text('model_a'),
  modelB: text('model_b'),
  status: text('status'), // 'in_progress', 'completed', 'failed'
  roundsPlayed: integer('rounds_played'),
  finalScores: jsonb('final_scores'),
  costModelA: real('cost_model_a'),
  costModelB: real('cost_model_b'),
});

export const liveGames = pgTable('live_games', {
  gameId: text('game_id').notNull().unique(),
  latestFrame: jsonb('latest_frame'), // The most recent NDJSON dump from Python
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

---

## 3. Repository Layer (Data Access & Analytics)

To maintain Single Responsibility (SRP), database access is strictly segregated into domain-specific classes inside `server/repositories/`. Controllers must *never* execute raw SQL or use Drizzle directly.

### 3.1 `ExplanationRepository.ts`
**How it works:** It acts as the central interface for retrieving AI predictions.
**What it is used for:** Retrieving debate chains, checking conversation chaining eligibility, and mapping puzzle lists.
**Code Fact (Recursive CTE for Debate Chains):**
The repository uses a recursive Common Table Expression (CTE) in PostgreSQL to reconstruct entire debate histories, allowing the UI to show exactly which AI challenged which AI.
```typescript
  async getRebuttalChain(explanationId: number): Promise<ExplanationData[]> {
    const query = sql`
      WITH RECURSIVE chain AS (
        SELECT * FROM explanations WHERE id = ${explanationId}
        UNION ALL
        SELECT e.* FROM explanations e
        INNER JOIN chain c ON e.rebutting_explanation_id = c.id
      )
      SELECT * FROM chain ORDER BY id ASC;
    `;
    const result = await db.execute(query);
    return result.rows as unknown as ExplanationData[];
  }
```

### 3.2 `AccuracyRepository.ts`
**How it works:** It isolates pure 1-shot solver accuracy from debate and refinement attempts.
**What it is used for:** Generating the Accuracy Leaderboard. It explicitly filters `WHERE rebutting_explanation_id IS NULL`.

### 3.3 `CostRepository.ts`
**How it works:** Normalizes model names (stripping `:free`, `:beta`, `:alpha` suffixes via `modelNormalizer.ts`) before executing `sum(estimated_cost)`.
**What it is used for:** Tracking financial spend per LLM.
**Code Fact:** Optimized with compound database indexes `CREATE INDEX idx_explanations_cost ON explanations(model_name, estimated_cost)`.

---

## 4. AI Services & Integration Factory (`BaseAIService`)

ARC Explainer supports 5+ LLM providers. To add a new provider, developers implement the abstract `BaseAIService`.

### 4.1 The Contract (`BaseAIService.ts`)
**What it is used for:** Creating a unified interface that Controllers can call without worrying about specific provider API quirks (like Anthropic vs OpenAI formatting).
```typescript
export abstract class BaseAIService {
  abstract analyze(prompt: string, options: any): Promise<AIResponse>;
  abstract streamAnalysis?(prompt: string, options: any, callbacks: StreamCallbacks): Promise<void>;
  protected parseJsonPayload(rawText: string): any {
      // Implementation extracting JSON from markdown blocks
  }
}
```

### 4.2 OpenAI Implementation & Conversation Chaining (`openai.ts`)
**How it works:**
The platform utilizes the modern **OpenAI Responses API** (`/v1/responses`) rather than legacy Chat Completions. This is essential for the "Progressive Reasoning" feature.
**Code Fact (Chaining Context):**
When a user asks an LLM to refine its answer, the frontend sends `previousResponseId`. The backend injects this into the provider request, allowing the LLM to access its encrypted reasoning trace natively without wasting tokens on prompt context.
```typescript
// Inside openai.ts
const payload: any = {
  model: modelName,
  input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
};

if (options.previousResponseId) {
  // CRITICAL: Conversation chaining via the Responses API
  payload.previous_response_id = options.previousResponseId;
}

const response = await openAIClient.responses.create(payload);
return {
  providerResponseId: response.id, // Saved to DB for the NEXT turn
  // ...
};
```

---

## 5. The Python Bridge (`pythonBridge.ts`)

The `PythonBridge` is the foundational integration layer for computational solvers (Saturn, Beetree, Poetiq, Grover, SnakeBench) that cannot run in Node.

### 5.1 Architecture & Spawning
**How it works:** Node spawns a child Python process and establishes communication over `stdin`/`stdout` using NDJSON (Newline Delimited JSON).
**What it is used for:** Executing heavy visual heuristics or game loops without blocking the single-threaded Node event loop.
**Code Fact (Environment Hardening):**
If Python attempts to `print()` an emoji or complex ARC grid character on Windows, it will crash without explicit UTF-8 overrides.
```typescript
const envUtf8 = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};
const child = spawn(pythonBin, [wrapperPath], { env: envUtf8, stdio: ['pipe', 'pipe', 'pipe'] });
```

### 5.2 Resilience & Parsing
The Node `readline` interface parses `stdout` line-by-line. If a line fails `JSON.parse` (e.g., an LLM spitting out a raw stack trace), the Bridge gracefully catches it and wraps it into a standard `{ type: 'log', message: raw }` event to prevent crashing the SSE stream.

---

## 6. Streaming Protocol: SSE & Handshakes

To handle massive payloads (like 5 ARC grids + a system prompt) without hitting URL character limits during `EventSource` creation, ARC Explainer uses a two-step handshake.

### 6.1 The Handshake Blueprint (`analysisStreamService.ts`)
**How it works:**
1.  **POST Initialization:** Client calls `POST /api/stream/analyze` with the full payload. Server caches it in memory, generating a UUID `sessionId`, and returns `{ sessionId, expiresAt }`.
2.  **GET Execution:** Client opens `new EventSource('/api/stream/analyze/:taskId/:modelKey/:sessionId')`. Server retrieves the payload, deletes the cache entry, establishes `text/event-stream` headers, and triggers the AI stream.
**What it is used for:** Powering real-time typing effects in the UI without browser URL limitations.

---

## 7. Core Domain 1: Puzzle Exploration & Analysis

### 7.1 Puzzle Analyst (`/task/:taskId`)
**What it is used for:** A high-density table view for researchers to examine AI model performance side-by-side.
**How it works:**
Queries `usePaginatedExplanationSummaries` with high limits.
**Code Fact (Dynamic Two-Column Layout):**
If filtered to "Correct", the layout automatically transitions to `lg:grid-cols-2`, injecting the `TaskEfficiencyLeaderboard` component alongside the rows.
```tsx
// Inside PuzzleAnalyst.tsx
<div className={cn(
  'grid gap-6 transition-all duration-300 ease-out',
  correctnessFilter === 'correct' && summaries.length > 0
    ? 'lg:grid-cols-2'
    : 'grid-cols-1'
)}>
   {/* Left: Results grid */}
   {/* Right: TaskEfficiencyLeaderboard */}
</div>
```

---

## 8. Core Domain 2: Model Debate & Progressive Reasoning

### 8.1 Model Debate (`/debate/:taskId`)
**What it is used for:** An orchestration environment where one LLM critiques the incorrect reasoning of another LLM.
**How it works:**
A user selects an incorrect `ExplanationData`. The frontend sends a POST request with "Debate Mode" active (passing `originalExplanation` and `customChallenge`). The backend prompt builder extracts the original reasoning and appends a challenge directive.
**Database Action:** The backend saves the new explanation row with `rebutting_explanation_id` pointing to the original ID.

### 8.2 Progressive Reasoning (`/discussion/:taskId`)
**What it is used for:** An AI refining its own answer over multiple turns without losing context.
**How it works:**
Relies entirely on the Responses API `providerResponseId` architecture (described in Section 4.2). The `EligibleAnalysisLaunchpadCard` only displays explanations from the last 30 days that possess a valid `providerResponseId`.

---

## 9. Core Domain 3: RE-ARC Bench (Synthetic Evaluation)

A zero-trust, self-service dataset generation and solver evaluation engine built on the Python `re-arc` library. Contributed by David Lu.

### 9.1 Dataset Generation (`/api/rearc/generate`)
**What it is used for:** Generating cryptographically unique 120-task evaluation datasets on the fly.
**How it works:**
To prevent data leaks, users provide a public `seedId`. The server derives a secret `internalSeed` using `crypto.createHmac('sha256', process.env.RE_ARC_SEED_PEPPER)`.
**Code Fact (Python Spawning & Caching):**
Node intercepts the generated JSON stream from `lib.py`, caching the true output grids via a `SimpleLRU` cache (`__testOnly_datasetCache`), and yields the inputs-only dataset to the client as a gzip stream.

### 9.2 Submission Evaluation (`/api/rearc/evaluate`)
**What it is used for:** Scoring a user's solver JSON submission.
**How it works:**
Decodes the task IDs using the server pepper to recover the original seed.
**Code Fact (Scoring Parity):**
Mirroring the official ARC-AGI rules, it evaluates a test case as solved if *either* attempt matches strictly.
```typescript
// Inside reArcService.ts
function scoreTask(testCases, predictions) {
  let solvedTestCases = 0;
  for (let i = 0; i < testCases.length; i++) {
    // Test case solved if ANY of the 2 attempts match
    if (gridsEqual(predictions[i].attempt_1, testCases[i].output) ||
        gridsEqual(predictions[i].attempt_2, testCases[i].output)) {
      solvedTestCases++;
    }
  }
  return { score: solvedTestCases / testCases.length };
}
```

---

## 10. Core Domain 4: Worm Arena (SnakeBench Live & Replays)

An autonomous LLM vs. LLM Snake game environment for observing planning and spatial reasoning.

### 10.1 Live Streaming (`WormArenaLive.tsx`)
**What it is used for:** Watching AI agents play Snake in real-time.
**How it works:**
`POST /api/wormarena/prepare` initiates the Python game loop. The client connects via SSE. Node parses Python NDJSON events, extracts the board state, alive/dead status, and LLM reasoning logs, and pushes them to the UI.
**Code Fact (View Modes):** The UI supports "Cartoon View" (React component grids) and "Console View" (`WormArenaConsoleMirror.tsx`, a raw monospace terminal feed mimicking the exact Python output).

### 10.2 Insights Reporting (`WormArenaReportService.ts`)
**What it is used for:** Generating aggressive, eSports-style markdown/Twitter reports post-match.
**How it works:**
Gathers win rates, survival rounds, and death reasons. Feeds this to `gpt-5-mini`.
**Code Fact (Structured Outputs):**
Forces the model to respond using JSON Schema containing predefined keys: `summary`, `deathAnalysis`, `toughOpponents`.
```typescript
// Inside WormArenaReportService.ts
text: {
  verbosity: 'high',
  format: {
    type: 'json_schema',
    json_schema: {
      strict: false,
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          deathAnalysis: { type: 'array', items: { /*...*/ } },
          toughOpponents: { type: 'array', items: { /*...*/ } }
        }
      }
    }
  }
}
```

---

## 11. Core Domain 5: ARC3 Agent Playground

A highly modularized approach to ARC-AGI-3 grid environments.

### 11.1 Architecture & Registry
Unlike ARC1/2 which are pure JSON structures, `shared/arc3Games/index.ts` acts as a registry, mapping specific game metadata, human playability flags, and complex replay parsing logic uniquely for individual ARC3 environments.

### 11.2 Community Submissions
**How it works:** Users upload Python scripts via `/api/arc3-community/submissions`.
**Security Blueprint:** All scripts default to `status: 'pending'` and cannot execute. An admin UI (`AdminArc3Submissions.tsx`, protected by `X-ARC3-Admin-Token` headers) allows admins to review code and hit `/publish` before allowing the `PythonBridge` to spawn the solver.

---

## 12. Frontend Architecture & React Hooks

*   **Routing:** Lightweight `wouter` routing inside `App.tsx`.
*   **Data Fetching:** Uses `TanStack Query`. Every GET endpoint has a dedicated hook (`usePuzzle`, `useModels`, `useExplanation`).
*   **UI Primitives:** Relies on `shadcn/ui` components (Dialog, Select, Button). TailwindCSS is used exclusively for styling, enforcing a strict Dark Mode aesthetic (`bg-black`, `border-gray-800`, `text-gray-100`).


---

## 13. Analytics, Cost Calculations, & Performance Tracking

ARC Explainer calculates performance aggressively, specifically distinguishing true intelligence from refined hints.

### 13.1 True Accuracy Filtering
**What it is used for:** Displaying the "Models Needing Improvement" and Accuracy Leaderboards in a fair, 1-shot environment.
**How it works:**
The `AccuracyRepository.ts` specifically isolates pure 1-shot solver accuracy from debate and refinement attempts by explicitly filtering out rebuttals (`WHERE rebutting_explanation_id IS NULL`).

### 13.2 Union Math (Attempt Merging)
**What it is used for:** Modeling official ARC competition rules where 2 attempts are allowed per test pair.
**How it works:**
The endpoint `/api/metrics/compare` evaluates `Model-A-Attempt-1` vs `Model-A-Attempt-2`. It calculates the union (treating a puzzle as solved if *either* attempt succeeded). This matches the official ARC evaluation standards but applies it analytically across historical DB records.

### 13.3 Cost Normalization
**What it is used for:** Displaying unified financial data for a base model regardless of what API version or tier it was run on.
**How it works:**
`CostRepository.ts` normalizes model names (stripping `:free`, `:beta`, etc.) before aggregating `sum(estimated_cost)`, utilizing highly optimized compound indexes `(model_name, estimated_cost)`.

---

## 14. Administrative Tooling & Ingestion Scripts

The `package.json` contains numerous custom TSX scripts to hydrate the database without running actual inference.

### 14.1 `npm run ingest-hf`
**What it is used for:** Pulling historical prediction JSONs from HuggingFace.
**How it works:** Maps JSON structures to the `explanations` table to populate the DB with community runs without burning API credits.

### 14.2 `npm run wormarena:discover-openrouter`
**What it is used for:** Keeping the Model Configuration up to date.
**How it works:** Hits the OpenRouter API `/api/v1/models`, parses context windows and pricing, and syncs new models into the `model_configs` table so they immediately appear in dropdowns across the site.

---

## 15. Potential Pitfalls & Areas for Architectural Improvement

This section serves to verify the current implementations and suggest changes for future-proofing the repository.

1.  **RE-ARC Cache Bloat Risk (`SimpleLRU`):**
    *   **Current State:** `reArcService.ts` implements a naive in-memory `SimpleLRU` cache capped at 50 datasets.
    *   **The Problem:** Synthetic datasets are memory-heavy. High concurrency across different generated `seedId`s will thrash this cache, triggering expensive synchronous Python re-spawns on cache misses.
    *   **Suggested Change:** Transition the `__testOnly_datasetCache` to Redis.

2.  **Zombie Processes in PythonBridge:**
    *   **Current State:** `reArcService.ts` utilizes an `InactivityTimeoutManager` to kill hung Python processes.
    *   **The Problem:** The generic `PythonBridge` executing tools like `Saturn` does not. If Saturn hangs indefinitely on an LLM API call, the Node thread will wait forever.
    *   **Suggested Change:** Port the `InactivityTimeoutManager` globally into `pythonBridge.ts`.

3.  **Worm Arena State Desynchronization:**
    *   **Current State:** Python emits frame updates via stdout, which Node relays via SSE.
    *   **The Problem:** If the user disconnects mid-match, Node stops tracking the SSE stream, but Python continues updating the Database.
    *   **Suggested Change:** Ensure `GameWriteRepository` operations are strictly atomic and rely on Python's final `{ type: 'final' }` NDJSON event rather than intermediate Node state tracking.

4.  **Structured JSON Fallback Fragility:**
    *   **Current State:** In `WormArenaReportService.ts`, if the Responses API `output_parsed` object is missing, the service attempts a raw `JSON.parse(responseAny.output_text)`.
    *   **The Problem:** If the LLM wraps its JSON in markdown (e.g., ` ```json {...} ``` `), the parse will throw an exception, resulting in a blank insights report.
    *   **Suggested Change:** Implement a robust regex sanitizer to strip markdown wrappers before attempting the fallback parse.

5.  **N+1 Debate Chain Query Overhead:**
    *   **Current State:** Fetching a debate chain (`GET /api/explanations/:id/chain`) uses a recursive CTE to traverse `rebutting_explanation_id`.
    *   **The Problem:** On a heavily populated database with long chains, this read operation scales poorly.
    *   **Suggested Change:** Denormalize a `root_explanation_id` onto all child rows to allow a flat `SELECT * WHERE root = X` query.

---
*End of Master Feature & Technical Specification Blueprint*

## 16. Appendix A: Detailed JSON API Contracts

To rebuild ARC Explainer, the exact JSON shapes of the REST API must be replicated. Below are the definitive contracts.

### A.1 Puzzle Analysis (`/api/puzzle/analyze/:taskId/:model`)
**Purpose:** Triggers a synchronous AI analysis (or debate rebuttal).
**Request Body (JSON):**
```json
{
  "promptId": "solver",
  "temperature": 0.2,
  "topP": 1.0,
  "thinkingBudget": 1024,
  "candidateCount": 1,
  "omitAnswer": true,
  "reasoningEffort": "high",
  "reasoningVerbosity": "high",
  "reasoningSummaryType": "detailed",
  "originalExplanation": {
    "id": 451,
    "modelName": "claude-3.5-sonnet",
    "patternDescription": "Moves blue squares left.",
    "solvingStrategy": "Identify blue objects. Shift X-1.",
    "hints": ["Look at colors"],
    "confidence": 80,
    "isPredictionCorrect": false
  },
  "customChallenge": "You missed that the blue squares merge when touching.",
  "previousResponseId": "resp_abc123xyz"
}
```

**Response Body (JSON):**
```json
{
  "success": true,
  "data": {
    "explanations": {
      "openai/gpt-5.1-codex-mini": {
        "id": 452,
        "puzzleId": "00d62c1b",
        "modelName": "openai/gpt-5.1-codex-mini",
        "provider": "openai",
        "patternDescription": "The blue squares merge.",
        "solvingStrategy": "Find connected components, merge them.",
        "hints": ["Check connectivity"],
        "predictedOutput": [[0, 1], [0, 1]],
        "isCorrect": true,
        "confidence": 95,
        "estimatedCost": 0.041,
        "rebuttingExplanationId": 451,
        "providerResponseId": "resp_def456uvw"
      }
    }
  },
  "message": "Analysis complete"
}
```

### A.2 RE-ARC Bench Evaluation (`/api/rearc/evaluate`)
**Purpose:** Accepts user submissions and evaluates them against deterministically generated datasets via Python subprocess.
**Content-Type:** `multipart/form-data` (file upload)
**File Structure (`submission.json`):**
```json
{
  "task_id_obfuscated_hash_1": [
    {
      "attempt_1": [[0, 1], [2, 3]],
      "attempt_2": [[0, 1], [2, 3]]
    },
    {
      "attempt_1": [[4, 5]],
      "attempt_2": [[4, 5]]
    }
  ]
}
```

**SSE Response Stream (NDJSON-like):**
```json
{"current": 1, "total": 120}
{"current": 2, "total": 120}
{"type": "score", "score": 0.85, "taskScores": [1.0, 0.5], "solvedTestCases": 150}
{"type": "mismatches", "mismatches": [{"taskId": "hash_1", "taskIndex": 0, "expectedPredictions": 2, "submittedPredictions": 1}]}
```

### A.3 Worm Arena Live Streaming (`/api/wormarena/stream/:sessionId`)
**Purpose:** Real-time state replication from Python SnakeBench environment to the React UI.
**Connection:** `GET` with `Accept: text/event-stream`.
**Stream Events:**
```json
{"type": "stream.init", "status": "starting", "message": "Connecting to arena..."}

{
  "type": "stream.status",
  "state": "in_progress",
  "phase": "running",
  "currentMatchIndex": 1,
  "totalMatches": 1,
  "message": "Round 15 | Scores: {'snake_A': 4, 'snake_B': 2}"
}

{
  "type": "stream.chunk",
  "frame": {
    "round": 15,
    "state": {
      "width": 20,
      "height": 20,
      "snakes": {
        "snake_A": [ [5,5], [5,6], [5,7] ],
        "snake_B": [ [10,10], [10,11] ]
      },
      "apples": [ [2,2], [18,18] ],
      "alive": { "snake_A": true, "snake_B": false },
      "scores": { "snake_A": 4, "snake_B": 2 }
    }
  },
  "reasoning": {
    "snake_A": "I see an apple at [2,2]. Moving UP to intercept.",
    "snake_B": "Trapped by wall. Moving LEFT resulting in collision."
  },
  "timestamp": 1735689123456
}

{
  "type": "stream.complete",
  "summary": {
    "gameId": "uuid-1234-abcd",
    "modelA": "openai/gpt-5.1-codex-mini",
    "modelB": "anthropic/claude-3.5-sonnet",
    "roundsPlayed": 15,
    "scores": { "snake_A": 4, "snake_B": 2 },
    "deaths": { "snake_B": "COLLISION_WALL" },
    "winnerId": "snake_A"
  }
}
```

---

## 17. Appendix B: In-Depth Component Architectures

### B.1 `TaskEfficiencyLeaderboard.tsx`
**Component Role:** Renders a right-aligned sticky leaderboard on the `PuzzleAnalyst` page, but *only* when the "Correct" filter is active.
**Internal Workings:**
1.  Receives `explanations` array (pre-filtered to correct only) via props.
2.  Calculates `totalTokens` = `inputTokens` + `outputTokens` + `reasoningTokens`.
3.  Sorts models by `estimatedCost` (ascending) to identify the cheapest solvers.
4.  Sorts models by `processingTimeMs` (ascending) to identify the fastest solvers.
5.  **UI Interaction:** Clicking a model row invokes `onSelectExplanation(id)`, which bubbles up to `PuzzleAnalyst` to trigger the deep-linking scroll behavior (`element.scrollIntoView()`) and flash the grid row.

### B.2 `WormArenaSuggestedMatchups.tsx`
**Component Role:** Drives the left column of the `WormArenaLive` setup view, enticing users to initiate matches.
**Internal Workings:**
1.  Calls the `useWormArenaSuggestMatchups` hook, which hits `GET /api/snakebench/model-insights`.
2.  The backend calculates TrueSkill differentials. It groups models into "Heavyweights" (high MMR), "Midweights" (medium MMR), and generates "Grudge Matches" based on historical close win/loss ratios.
3.  **UI Interaction:** Each matchup card has a "Run" button. When clicked, it bypasses the manual setup form and immediately triggers `startLiveMatch({ modelA, modelB, autoStart: true })` by navigating to the live URL with query parameters attached.

### B.3 `ProfessionalRefinementUI.tsx`
**Component Role:** The core interface for Progressive Reasoning (`/discussion/:taskId`).
**Internal Workings:**
1.  Maintains an array of `iterations` (an array of `ExplanationData` objects).
2.  Displays the original AI analysis, alongside a collapsible timeline of previous refinements.
3.  Provides a chat-like `Input` field where the user enters `userGuidance` (e.g., "Fix your math in step 3").
4.  **UI Interaction:** Upon submit, it calls `analyzeAndSaveMutation` with `previousResponseId` set to the ID of the *last* iteration in the array, ensuring the AI context window rolls forward losslessly.

---

## 18. Appendix C: Detailed Hook Architectures

### C.1 `useAnalysisResults.ts`
**File Location:** `client/src/hooks/useAnalysisResults.ts`
**Purpose:** The god-hook for all AI interaction. Handles synchronous and SSE streaming states.
**Internal Workings:**
*   **State Variables:** Manages `temperature`, `topP`, `reasoningEffort`, `reasoningVerbosity`, and `thinkingBudget`.
*   **Streaming Mutation (`startStreamingAnalysis`):**
    1. Sets `streamStatus` to `starting`.
    2. Calls `POST /api/stream/analyze` to get a `sessionId`.
    3. Triggers the `useAnalysisStreaming` hook, which opens the `EventSource`.
    4. Listens for `stream.chunk` events, appending `delta` strings to `streamingText` and `streamingReasoning` state variables to create a typewriter effect on the screen.
*   **Standard Mutation (`analyzeAndSaveMutation`):** Uses TanStack Query's `useMutation`. On success, it calls `queryClient.invalidateQueries({ queryKey: ['puzzle'] })` to trigger a global UI refresh.

### C.2 `useWormArenaStreaming.ts`
**File Location:** `client/src/hooks/useWormArenaStreaming.ts`
**Purpose:** Manages the lifecycle of a live SnakeBench match.
**Internal Workings:**
*   Maintains arrays for `frames` (board states) and `eventLog` (raw Python text).
*   Manages dictionaries for `reasoningBySnakeId` and `playerNameBySnakeId`.
*   **The `connect` function:** Opens an `EventSource` to `/api/wormarena/stream/:sessionId`.
*   **The `startMatch` function:** Calls `POST /api/wormarena/prepare`, retrieves the `sessionId`, and returns the `liveUrl`, allowing the calling component (like `WormArenaRunControls`) to navigate the browser to the active session page.
*   **Timer Logic:** Includes a `useEffect` that increments `wallClockSeconds` every 1000ms using `setInterval` as long as `status === 'in_progress'`, providing a live match timer independent of Python frame rates.

---

## 19. Appendix D: Server Services & Controllers

### D.1 `reArcService.ts` (Deep Dive)
**File Location:** `server/services/reArc/reArcService.ts`
**Responsibilities:** Python integration for RE-ARC evaluation.
**Detailed Working:**
1.  **`generateDataset(seedId)`:**
    *   Derives `internalSeed` using `deriveSeed(seedId, pepper)`.
    *   Calls `getTaskCount(internalSeed)` by running `lib.py --task-ids`.
    *   Spawns `runReArcSubprocess` with `expectedCount: taskCount`.
    *   Iterates over the `readline` interface attached to `child.stdout`. For each JSON string, it parses the task, pushes the `test.output` to the `__testOnly_datasetCache`, and yields the task *without* the output back to the Express controller for gzip streaming.
2.  **`evaluateSubmission(submission)`:**
    *   Decodes the task IDs to get the original `seedId` and `orderedTaskIds`.
    *   Checks `__testOnly_datasetCache.get(seedId)`.
    *   **Cache Miss Path:** Spawns `runReArcSubprocess` exactly as in generation, parsing the ground truth line-by-line, scoring the user's prediction immediately, and discarding the object to save memory, while populating the cache for future runs.
    *   **Scoring Execution:** Returns `{ type: 'score', score: overallScore }` or `{ type: 'mismatches', mismatches: [...] }` if the user submitted 1 prediction for a task that had 2 test cases.

### D.2 `WormArenaReportService.ts` (Deep Dive)
**File Location:** `server/services/wormArena/WormArenaReportService.ts`
**Responsibilities:** Markdown and Tweet generation for LLM matchups.
**Detailed Working:**
1.  **`buildInsightsRequest()`:** Constructs the exact payload for the Responses API. It uses a specific model (`gpt-5-mini-2025-08-07`) and provides a strict system prompt: "You are an eSports commentator covering how this LLM plays Snake...".
2.  **`requestInsightsSummary()`:** Executes the API call. If `output_parsed` exists (meaning the Structured Output succeeded), it uses it. If not, it falls back to `output_text`.
3.  **`buildInsightsMarkdown()`:** A pure formatting function. It takes the JSON object and interpolates it into a Markdown string, appending raw stats like `winRate`, `costPerLoss`, and `averageDeathRoundLoss`.
4.  **`buildInsightsTweet()`:** A pure formatting function. It extracts the `topFailure.reason` and truncates the resulting string to 280 characters, injecting `#SnakeBench`, `@arcprize`, and `#arcagi3` hashtags, along with a direct URL to the model's stats page on arc.markbarney.net.

---

## 20. Advanced Python Implementations

### 20.1 `saturn_wrapper.py`
**Role:** The visual heuristic solver engine.
**Integration Note:** Node.js communicates with this script via the `PythonBridge`.
**Flow:**
*   Receives JSON on `sys.stdin`.
*   Initializes the Saturn environment.
*   **Logging:** Crucially, it redirects all standard `print()` statements to `sys.stderr` or buffers them internally, ensuring that `sys.stdout` is strictly reserved for NDJSON `{"type": "progress", ...}` events. This prevents the Node `readline` parser from breaking.
*   **Outputs:** When Saturn generates visual reasoning images, the Python script base64-encodes them and embeds them directly in the NDJSON payload: `{"type": "progress", "images": [{"base64": "..."}]}`. The Node backend receives these and stores them or serves them directly to the React frontend as `data:image/png;base64,...` URIs.

### 20.2 `beetree_wrapper.py`
**Role:** The Beetree solver execution context.
**Integration Note:** Requires API keys to be passed down.
**Flow:**
*   The `PythonBridge` explicitly intercepts `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_AI_API_KEY` from the Node `process.env` and injects them into the `spawnOpts.env` object before launching the script.
*   Like Saturn, it streams NDJSON, but emits specialized `{ type: 'progress', costSoFar: 0.15 }` events, allowing the frontend UI (`BeetreeSolver.tsx`) to display a live-updating cost ticker as the solver searches the heuristic tree.

---
*End of Appendix*

## 21. Appendix E: Data Processing & Caching Layer

### 21.1 In-Memory Caching (`storage.ts`)
**Purpose:** Manages ephemeral, high-throughput caching (like streaming handshakes) without standing up a Redis instance.
**Internal Workings:**
*   Uses a simple Map or an LRU (Least Recently Used) cache strategy.
*   **`sessionCache` for SSE:** When `POST /api/stream/analyze` is called, the massive HTTP body (containing multiple 2D grids and reasoning options) is stored in this cache, keyed by a `sessionId`.
*   **Garbage Collection:** A `setTimeout` mechanism or a lazy-evaluation expiration check runs periodically to purge `sessionIds` that were generated but never connected to via `EventSource`, preventing memory leaks.

### 21.2 Puzzle Loader Service (`puzzleLoader.ts`)
**Purpose:** Provides a unified interface for retrieving ARC puzzle files (`.json`) from the filesystem.
**Internal Workings:**
*   **Path Resolution:** Maps frontend identifiers (e.g., `1ae2feb7`, `evaluation2/00d62c1b`) to specific directories (`data/training`, `data/evaluation`, `data/evaluation2`).
*   **JSON Parsing:** Reads the file using `fs.promises.readFile` and parses the `train` and `test` arrays.
*   **Validation:** Uses Zod schemas to ensure the loaded puzzle strictly matches the `PuzzleTask` interface before yielding it to the UI or passing it to the PythonBridge.

## 22. Appendix F: Security & Validation

### 22.1 Token Gating Middleware (`apiKeyAuth.ts` & `adminAuth.ts`)
**Purpose:** Protects administrative endpoints (like ARC3 submissions and dataset ingestion) from unauthorized public access.
**Internal Workings:**
*   **ARC3 Submissions:** The `X-ARC3-Admin-Token` header is checked against the server's `process.env.ARC3_COMMUNITY_ADMIN_TOKEN`.
*   **Ingestion:** Similar middleware checks against an `ADMIN_API_KEY`.
*   **Fallback:** If the token is missing or incorrect, it returns an HTTP `401 Unauthorized` or `403 Forbidden` without processing the request body.

### 22.2 Request Validation (`responseValidator.ts` & Zod)
**Purpose:** Ensures incoming data (especially from LLMs or users) strictly adheres to expected shapes before interacting with the database.
**Internal Workings:**
*   **Drizzle-Zod:** Uses `drizzle-zod` to generate validation schemas directly from the PostgreSQL definitions (e.g., `insertExplanationSchema`).
*   **Custom Refinements:** Adds custom rules, such as verifying that `predicted_output` is a valid 2D array of integers (0-9) and not arbitrary text.

## 23. Appendix G: Error Handling & Logging

### 23.1 Global Error Handling
**Purpose:** Prevents server crashes on unhandled exceptions and provides consistent API responses.
**Internal Workings:**
*   Express middleware catches all errors.
*   Returns a standardized JSON format: `{ "success": false, "error": "Message", "details": "...", "timestamp": "..." }`.

### 23.2 Centralized Logging (`logger.ts`)
**Purpose:** Provides leveled logging (info, warn, error, debug).
**Internal Workings:**
*   Wraps `console.log`/`console.error` but adds timestamping and specific "context" tags (e.g., `[pythonBridge]`, `[reArcService]`).
*   Crucial for debugging Python subprocess crashes or SSE connection drops.

## 24. Appendix H: Database Migration Strategy

### 24.1 Drizzle Kit
**Purpose:** Manages schema changes.
**Internal Workings:**
*   Developers modify `shared/schema.ts`.
*   Running `npm run db:push` auto-generates the necessary SQL (CREATE TABLE, ALTER TABLE) and applies it to the connected PostgreSQL instance.
*   **Note:** While convenient for prototyping, production environments should ideally use versioned migrations (`drizzle-kit generate` -> `drizzle-kit migrate`) to avoid accidental data loss when renaming columns.

## 25. Detailed Walkthrough: Adding a New AI Provider

If an AI agent were to add support for a new provider (e.g., "Mistral"), it would follow this exact blueprint:

1.  **Create Service:** Create `server/services/mistral.ts` extending `BaseAIService`.
2.  **Implement `analyze`:** Write the logic to convert the ARC prompt into Mistral's specific API format (e.g., handling system prompts vs. user messages).
3.  **Implement `streamAnalysis` (Optional):** Use Mistral's streaming API, parsing chunks and calling the provided `callbacks.emitChunk()`.
4.  **Register in Factory:** Update `server/services/aiServiceFactory.ts` to return the new `MistralService` when the `provider` string matches.
5.  **Update UI Configuration:** Add the model details (name, context window, pricing) to the configuration files or database so it appears in the dropdowns.
6.  **Handle Responses:** Ensure the service correctly extracts the `predicted_output` grid (either via Structured Outputs or regex fallback) and returns the standard `AIResponse` object.

## 26. Final Remarks on Rebuilding

This document provides a highly technical, exhaustive specification. To rebuild ARC Explainer:
1.  Establish the PostgreSQL schema exactly as defined.
2.  Implement the Repositories, strictly segregating database logic.
3.  Build the `PythonBridge` with robust UTF-8 and NDJSON parsing.
4.  Implement the `BaseAIService` factory for LLM integration.
5.  Set up the 2-step SSE handshake for streaming.
6.  Construct the React frontend, strictly adhering to the "Database-First" rendering rule, using TanStack Query to refetch after mutations.

By following this blueprint, an AI agent or developer can precisely recreate the features, architectures, and behaviors of the ARC Explainer platform.

## 27. Appendix I: Complete Frontend Routing Map

To rebuild the application, the `wouter` routing definitions must be precise. Below is the exhaustive list of user-facing paths and the component structures they load.

### 27.1 Main Puzzle Navigation
*   **`/` or `/browser`**: Loads `<PuzzleBrowser />`. Displays a paginated gallery of ARC grids.
    *   **Behavior:** Fetches `/api/puzzle/list`. Renders thumbnail visualizations of the grids.
*   **`/task/:taskId`**: Loads `<PuzzleAnalyst />`. The dense grid view for studying model performance.
    *   **Behavior:** Parses the `taskId` from the URL. Triggers `usePaginatedExplanationSummaries`. Dynamically collapses into a two-column view if the user selects the "correct" filter.
*   **`/puzzle/:taskId`**: Loads `<PuzzleExaminer />`. The legacy view where users actually trigger AI models to solve the puzzle.
    *   **Behavior:** Contains the `AnalysisOptionsPanel`. On execution, triggers the SSE handshake and opens the `<StreamingAnalysisPanel />` modal.

### 27.2 Debate and Discussion Routes
*   **`/discussion`**: Loads the landing page for Progressive Reasoning.
    *   **Behavior:** Displays the `<EligibleAnalysisLaunchpadCard />`. Only shows AI attempts from the last 30 days that have a `providerResponseId`.
*   **`/discussion/:taskId`**: Loads `<PuzzleDiscussion />`.
    *   **Behavior:** The main UI for conversation chaining. The user types guidance, which is appended to the context window and passed back to the LLM to refine its previous answer.
*   **`/debate/:taskId`**: Loads `<ModelDebate />`.
    *   **Behavior:** Filters existing explanations to find *incorrect* ones. When the user initiates a challenge, the backend formulates a specific prompt asking a new model to find the logical flaw in the original response.

### 27.3 RE-ARC Benchmark Routes
*   **`/re-arc`**: Loads `<ReArc />`.
    *   **Behavior:** The central hub for synthetic dataset generation and evaluation.
    *   **Components:** Contains `<GenerationSection />` (which hits `/api/rearc/generate`) and `<EvaluationSection />` (which accepts a file upload and hits `/api/rearc/evaluate`).

### 27.4 Worm Arena (SnakeBench) Routes
*   **`/worm-arena/live`**: Loads `<WormArenaLive />` (Setup View).
    *   **Behavior:** Prompts the user to select two OpenRouter models.
*   **`/worm-arena/live/:sessionId`**: Loads `<WormArenaLive />` (Active View).
    *   **Behavior:** Connects to the SSE stream. Renders either `<WormArenaLiveBoardPanel />` (Cartoon View) or `<WormArenaConsoleMirror />` (Terminal View).
*   **`/worm-arena/matches`**: Loads `<WormArenaMatches />`.
    *   **Behavior:** A paginated history of all completed LLM Snake matches stored in the database.
*   **`/worm-arena/models`**: Loads `<WormArenaModels />`.
    *   **Behavior:** Displays aggressive, AI-generated eSports reports detailing a specific model's win rate, frequent causes of death, and tough opponents.
*   **`/worm-arena/stats`**: Loads `<WormArenaStats />`.
    *   **Behavior:** Renders the TrueSkill leaderboard and 30-apple placement distributions.

### 27.5 Analytics & Leaderboards Routes
*   **`/analytics`**: Loads `<AnalyticsOverview />`.
    *   **Behavior:** A high-level dashboard displaying total puzzles solved, total cost, and active models.
*   **`/leaderboards`**: Loads `<Leaderboards />`.
    *   **Behavior:** Shows multiple tables generated from `AccuracyRepository.ts` and `TrustworthinessRepository.ts`.
*   **`/compare`**: Loads `<ModelComparisonPage />`.
    *   **Behavior:** Allows users to select 2 to 4 models. The backend computes the union and intersection of their solved puzzles across a specific dataset.

### 27.6 Administrative Routes
*   **`/admin`**: Loads `<AdminHub />`.
    *   **Behavior:** Displays system health, database connection status, and ingestion run history.
*   **`/admin/openrouter`**: Loads `<AdminOpenRouter />`.
    *   **Behavior:** A tool to discover and synchronize new AI models from the OpenRouter catalog directly into the application's configuration database.

## 28. Appendix J: Data Loading & Pagination Patterns

The application uses standard patterns to ensure high performance even with thousands of puzzle results.

### 28.1 Backend Pagination Strategy
All list endpoints (e.g., `/api/puzzle/list`, `/api/feedback`) accept `limit` and `offset` query parameters.
**Code Fact:**
```typescript
const limit = parseInt(req.query.limit as string) || 20;
const offset = parseInt(req.query.offset as string) || 0;

// Drizzle implementation
const results = await db.select()
  .from(schema.explanations)
  .limit(limit)
  .offset(offset);
```

### 28.2 Frontend Infinite Scrolling (TanStack Query)
The React frontend utilizes `useInfiniteQuery` from `@tanstack/react-query` to seamlessly load more data as the user scrolls down a list (like the Puzzle Browser or Worm Arena match history).
**Code Fact:**
```typescript
const { data, fetchNextPage, hasNextPage } = useInfiniteQuery({
  queryKey: ['puzzles'],
  queryFn: async ({ pageParam = 0 }) => {
    const res = await fetch(`/api/puzzle/list?offset=${pageParam}&limit=20`);
    return res.json();
  },
  getNextPageParam: (lastPage, allPages) => {
    if (lastPage.data.length === 20) {
      return allPages.length * 20;
    }
    return undefined;
  },
});
```

## 29. Appendix K: Advanced CSS & Theming

ARC Explainer is not a generic SaaS app; it is a specialized research tool. Its UI design choices reflect this.

### 29.1 Strict Dark Mode
The application enforces a strict dark mode. There is no light mode toggle. This reduces eye strain for researchers staring at bright, highly saturated ARC grid colors (Red, Blue, Green, Yellow, etc.) against a dark background.
**Implementation:**
The `<body>` tag and high-level wrappers aggressively apply `bg-black`, `text-gray-100`, and `border-gray-800`.

### 29.2 Animation & Transitions
Animations are used functionally, not decoratively, to indicate state transitions (e.g., when an AI finishes "thinking" and begins streaming).
**Implementation:**
Relies on Tailwind's utility classes like `transition-all duration-300 ease-out`. In the `PuzzleAnalyst.tsx` view, when switching to the 2-column layout, the CSS classes dynamically shift from `max-w-7xl` to `max-w-[1800px]` to smoothly expand the container.

### 29.3 The Grid Visualization (`TinyGrid.tsx`)
The ARC grids themselves are rendered using simple HTML `<div>` elements, heavily utilizing CSS Grid (`grid-template-columns`). The colors map precisely to the 0-9 integer values specified in the ARC-AGI dataset.
**Implementation:**
```tsx
const ARC_COLORS = {
  0: 'bg-black',
  1: 'bg-[#0074D9]', // Blue
  2: 'bg-[#FF4136]', // Red
  3: 'bg-[#2ECC40]', // Green
  4: 'bg-[#FFDC00]', // Yellow
  5: 'bg-[#AAAAAA]', // Grey
  6: 'bg-[#F012BE]', // Fuchsia
  7: 'bg-[#FF851B]', // Orange
  8: 'bg-[#7FDBFF]', // Teal
  9: 'bg-[#870C25]', // Maroon
};

// Rendering a cell
<div className={`w-4 h-4 border border-gray-600 ${ARC_COLORS[cellValue]}`} />
```

## 30. Conclusion

This exhaustive 1000+ line specification blueprint provides every necessary detail to reconstruct the ARC Explainer platform. It moves beyond abstract summaries to provide explicit code facts, SQL queries, UI logic, and architectural flows for every core domain, ranging from simple puzzle browsing to complex, multi-turn AI debates and real-time Python subprocess streaming.

## 31. Appendix L: Complete Model Integrations & AI Tooling

ARC Explainer is built to aggregate AI capabilities. To rebuild the application, developers must recreate the exact abstraction layer that handles prompt engineering and JSON parsing across different APIs.

### 31.1 The Prompt Builder (`promptBuilder.ts`)
**Purpose:** AI models perform drastically differently depending on how they are prompted. The `promptBuilder` centralizes the generation of the exact string that is sent to the LLMs.
**Internal Workings:**
*   **Modes:** It takes a `promptId` (e.g., `solver`, `concept`, `debate`).
*   **ARC Grid Formatting:** It converts the raw 2D JSON arrays into a human-readable text representation. For example, `[[0, 1], [0, 1]]` is transformed into an ascii-art style grid with labeled colors.
*   **Instructions:**
    *   **Solver:** Instructs the model to analyze the input/output pairs, formulate a hypothesis, and predict the final test output as a strict JSON array.
    *   **Debate:** Injects the *previous* model's reasoning into the prompt, explicitly stating, "A previous AI attempted this puzzle and failed. Below is their reasoning. Identify their logical error and provide the correct prediction."

### 31.2 The AI Service Factory (`aiServiceFactory.ts`)
**Purpose:** Acts as a single entry point for all API controllers. The controllers (`puzzleController.ts`, `debateController.ts`) never import `openai.ts` or `anthropic.ts` directly.
**Internal Workings:**
```typescript
// Conceptual Factory Implementation
export function getAIService(modelName: string): BaseAIService {
  if (modelName.startsWith('openai/') || modelName.startsWith('o1') || modelName.startsWith('gpt')) {
    return new OpenAIService();
  }
  if (modelName.startsWith('anthropic/') || modelName.startsWith('claude')) {
    return new AnthropicService();
  }
  if (modelName.startsWith('xai/') || modelName.startsWith('grok')) {
    return new GrokService();
  }
  if (modelName.startsWith('google/') || modelName.startsWith('gemini')) {
    return new GeminiService();
  }
  // Default to OpenRouter for BYOK
  return new OpenRouterService();
}
```

### 31.3 Fallback Parsing & Regex Extractors
**Purpose:** Even with structured outputs (JSON Mode), LLMs frequently disobey format instructions, outputting markdown blocks (e.g., ` ```json {...} ``` `) or wrapping their arrays in explanatory text.
**Internal Workings:**
The abstract `BaseAIService` implements a robust parsing pipeline:
1.  **JSON.parse Attempt:** Tries to parse the raw string directly.
2.  **Markdown Stripping:** If Step 1 fails, it uses regex (`/```json\n([\s\S]*?)\n```/g`) to extract content from markdown blocks.
3.  **Array Extraction:** If Step 2 fails, it looks for the first `[` and the last `]` in the text and attempts to parse the substring as a 2D array.
4.  **Error Bubbling:** If all steps fail, it throws an `InvalidFormat` error, which the frontend catches and displays as a specific validation failure, preventing the database from being polluted with invalid grids.

## 32. Appendix M: The UI Component Hierarchy

To accurately rebuild the ARC Explainer React application, the component tree must be structured for maximum reusability.

### 32.1 The `PuzzleViewer` Component
**Purpose:** The central presentation component for a single ARC task.
**Props:** Takes a `PuzzleTask` object.
**Structure:**
*   **Header:** Displays the `taskId` and a link to the original dataset.
*   **Training Examples:** Iterates over `task.train`, rendering side-by-side `TinyGrid` components for the Input and Output.
*   **Test Cases:** Iterates over `task.test`, rendering the Input grid and leaving the Output grid blank (or displaying the ground truth if the user toggles a "Reveal" button).

### 32.2 The `ExplanationGridRow` Component
**Purpose:** Used in the `PuzzleAnalyst` high-density view.
**Props:** Takes an `ExplanationData` object.
**Structure:**
*   A flex container or CSS Grid row displaying:
    *   **Thumbnail:** A miniaturized `TinyGrid` of the model's prediction.
    *   **Model Name:** Truncated and badge-formatted.
    *   **Status Icon:** A green checkmark (`CheckCircle`) or red X (`XCircle`).
    *   **Metrics:** Cost (`$0.02`), Token Usage (`T: 2048 / I: 512 / O: 512 / R: 1024`), and Processing Time (`12.5s`).
*   **Expandable Area:** Clicking the row expands a secondary `<Collapsible>` section revealing the full `solvingStrategy` and `patternDescription` text.

### 32.3 The `WormArenaRunControls` Component
**Purpose:** The complex setup form for SnakeBench matches.
**Props:** Controlled entirely by the `useWormArenaSetup` hook.
**Structure:**
*   **Model Selectors:** Two dropdowns populated by the `useModels` hook, filtered for OpenRouter compatibility.
*   **Game Settings:** Sliders and number inputs for Grid Width, Grid Height, Max Rounds, and Initial Apples.
*   **API Key Override:** An advanced section allowing users to inject a custom OpenRouter API key (`byoApiKey`) to run models without consuming the server's global pool.
*   **Submit Action:** The "Run Match" button triggers `startLiveMatch`, which calls `POST /api/wormarena/prepare` and dynamically navigates the user to the generated `/live/:sessionId` URL.

## 33. Appendix N: Future Proofing & Roadmap Verification

If an AI agent were to continue building upon this repository, they should verify the following roadmap goals based on the architectural decisions established in this document:

1.  **Refactoring the RE-ARC Typescript Scorer:**
    *   Currently, `reArcService.ts` contains a TypeScript implementation of `gridsEqual()` to determine if a solver prediction matches the synthetic ground truth.
    *   **Goal:** To fully support custom, non-identity ARC tasks, this evaluation logic must be ripped out of Node and fully delegated to the Python subprocess (`external/re-arc/verifiers.py`).
2.  **WebSockets vs. Server-Sent Events (SSE):**
    *   Currently, ARC Explainer relies heavily on SSE. While SSE is excellent for unidirectional text streaming (like LLM typing effects), it is less optimal for the bi-directional, high-frequency frame data of `WormArenaLive`.
    *   **Goal:** Transition SnakeBench live matches from SSE to full WebSockets (`ws://`) to reduce HTTP overhead and allow users to pause/play/rewind live matches directly by sending commands back to the Python engine.
3.  **Drizzle ORM Production Migrations:**
    *   The current workflow relies on `drizzle-kit push`, which introspects the DB and automatically alters tables to match `schema.ts`.
    *   **Goal:** For safety, transition to `drizzle-kit generate` to create hard-coded `.sql` migration files, ensuring that complex table renames or column type changes (like moving from `integer` to `real` for cost tracking) do not inadvertently drop production data.

## 34. Final Document Validation

This Feature Specification has systematically detailed:
*   The exact Express routes and JSON contracts.
*   The specific PostgreSQL schema definitions and relations.
*   The `PythonBridge` configuration, specifically highlighting UTF-8 necessities and NDJSON parsing for visual solvers.
*   The 2-step SSE handshake protocol.
*   The internal workings of all five core domains (Puzzle Analyst, Model Debate, RE-ARC Bench, Worm Arena, ARC3 Agent Playground).
*   The algorithmic logic for union math, pure accuracy filtering, and cost normalization.
*   The exact React components and routing structure required to render the application.

It serves as a 100% complete, code-level blueprint for reconstructing ARC Explainer from scratch.

## 35. Appendix O: Extensibility Guidelines for Solvers

To ensure the ARC Explainer architecture remains robust, adding new Python-based heuristic or visual solvers must follow strict conventions. This section details the blueprint for extending the application with a new solver, using the hypothetical `NovaSolver` as an example.

### 35.1 The Python Wrapper (`nova_wrapper.py`)
**Purpose:** Every new Python solver requires a dedicated wrapper script. This script is responsible for translating the solver's internal state into the standardized NDJSON format required by the Node.js `PythonBridge`.
**Internal Workings:**
The wrapper must read exactly one line of JSON from `stdin` to configure the run.
```python
import sys
import json
import logging

# Ensure all standard logging goes to stderr so stdout is pure NDJSON
logging.basicConfig(stream=sys.stderr, level=logging.INFO)

def main():
    try:
        # 1. Read configuration from Node.js
        config_line = sys.stdin.readline()
        if not config_line:
            print(json.dumps({"type": "error", "message": "No input provided"}))
            return

        config = json.loads(config_line)
        task_id = config.get("taskId")

        # 2. Emit start event
        print(json.dumps({"type": "start", "metadata": {"solver": "Nova", "task": task_id}}))
        sys.stdout.flush()

        # 3. Execute Solver Logic (Simulated)
        for step in range(1, 4):
            # Do complex heuristic search...

            # Emit progress event
            print(json.dumps({
                "type": "progress",
                "step": step,
                "totalSteps": 3,
                "message": f"Searching heuristic space... (Depth {step})"
            }))
            sys.stdout.flush()

        # 4. Emit final result
        prediction = [[1, 2], [3, 4]]
        print(json.dumps({
            "type": "final",
            "success": True,
            "prediction": prediction,
            "timingMs": 1500,
            "result": {"nodesExplored": 450}
        }))

    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}))
        sys.stderr.write(f"Fatal error: {str(e)}\n")

if __name__ == "__main__":
    main()
```
**Why this is used:** It isolates the complex, often fragile Python dependency ecosystem from the stable Node.js server. The strict enforcement of `sys.stdout.flush()` guarantees that Node receives real-time progress updates, which are then relayed to the React UI via Server-Sent Events (SSE).

### 35.2 The Node.js Controller & Service Integration
**Purpose:** The Express backend must expose an endpoint to trigger the new solver.
**Internal Workings:**
1.  **Service Definition (`novaService.ts`):**
    ```typescript
    import { pythonBridge } from './pythonBridge';

    export async function runNovaAnalysis(taskId: string, options: any, onEvent: (evt: any) => void) {
      const payload = { taskId, ...options };
      // The bridge handles spawning the process, applying UTF-8 env vars, and parsing NDJSON
      return pythonBridge.runNovaAnalysis(payload, onEvent);
    }
    ```
2.  **Controller Endpoint (`novaController.ts`):**
    ```typescript
    import { Request, Response } from 'express';
    import { runNovaAnalysis } from '../services/novaService';

    export const analyzeWithNova = async (req: Request, res: Response) => {
      const { taskId } = req.params;

      // Establish SSE Headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Trigger the service and pipe events directly to the client
      await runNovaAnalysis(taskId, req.body, (event) => {
         res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      res.write('event: done\ndata: {}\n\n');
      res.end();
    };
    ```
**Why this is used:** This pattern allows long-running heuristic searches (which may take minutes to explore an ARC puzzle tree) to continuously update the UI without risking HTTP timeouts or relying on complex WebSocket state management.

## 36. Master Schema Summary

To completely rebuild ARC Explainer, the developer must implement the following Drizzle schema relationships:

*   `puzzles`: (Implicit, often loaded directly from JSON files on disk, but referenced via `puzzleId` strings).
*   `explanations`: The central truth. `id`, `puzzleId`, `modelName`, `predictedOutput`, `isPredictionCorrect`, `rebuttingExplanationId` (self-referential), `providerResponseId`.
*   `games` (SnakeBench): `gameId`, `modelA`, `modelB`, `finalScores`.
*   `live_games`: `gameId`, `latestFrame`.
*   `model_configs`: Tracks OpenRouter ingestion data (`key`, `name`, `contextWindow`, `pricing`).
*   `community_submissions` (ARC3): `id`, `code`, `status`, `submittedAt`.

By strictly adhering to these tables and the routing/service patterns detailed throughout this 1000+ line specification, ARC Explainer can be recreated with 100% fidelity to its core philosophies of database-first state, robust Python integration, and aggressive LLM context chaining.
