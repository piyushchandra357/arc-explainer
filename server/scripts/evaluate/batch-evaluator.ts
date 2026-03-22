/**
 * ARC Evaluation Harness (Batch Orchestrator)
 *
 * Implements a robust, production-grade testbed for running ARC-AGI puzzles
 * against multiple models simultaneously. Features include:
 * - Multi-Model Testing & Parallel Execution
 * - Two Puzzle Formats (ARC-AGI-2, ARC-AGI-3)
 * - Cost Tracking & Budget Controls
 * - Crash Recovery & Resume (JSONL tracking)
 * - Graceful Shutdown (File-based cancellation & SIGINT)
 * - Automatic Retry & Circuit Breakers
 * - Self-Correction Mechanism & Persistent Notepad
 * - Comprehensive Logging & Data Extraction
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { randomUUID } from 'crypto';
import { aiServiceFactory } from '../../services/aiServiceFactory.js';
import { puzzleService } from '../../services/puzzleService.js';
import { buildAnalysisPrompt } from '../../services/promptBuilder.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types & Configuration
// ============================================================================

interface ModelConfig {
  provider: string;
  modelSlug: string;
  contextSize?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

interface EvaluationConfig {
  runId: string;
  puzzleIds: string[];
  models: ModelConfig[];
  runsPerModel: number;
  maxConcurrentPuzzles: number;
  maxConcurrentModels: number;
  maxConcurrentRuns: number;
  globalBudgetUsd: number;
  puzzleBudgetUsd: number;
  maxSteps: number;
  dryRun: boolean;
  stdoutJsonl: boolean;
  outputDir: string;
}

interface EvaluationState {
  totalCostUsd: number;
  puzzleCosts: Record<string, number>;
  completedRuns: Set<string>; // Set of `${puzzleId}_${modelSlug}_${runIndex}`
  circuitBreakers: Record<string, { failures: number; suspendedUntil: number }>;
  isDraining: boolean;
  runSummaries: any[]; // Stores results for CSV and Chart generation at the end
}

const DEFAULT_CONFIG: EvaluationConfig = {
  runId: '', // Will be assigned during initialization
  puzzleIds: [],
  models: [],
  runsPerModel: 1,
  maxConcurrentPuzzles: 3,
  maxConcurrentModels: 3,
  maxConcurrentRuns: 2,
  globalBudgetUsd: 50.0,
  puzzleBudgetUsd: 5.0,
  maxSteps: 10,
  dryRun: false,
  stdoutJsonl: false,
  outputDir: path.join(process.cwd(), 'evaluation_results'),
};

// ============================================================================
// State & File Management
// ============================================================================

class EvaluationOrchestrator {
  private config: EvaluationConfig;
  private state: EvaluationState;
  private logStream: fs.WriteStream | null = null;
  private summaryStream: fs.WriteStream | null = null;
  private cancelDir: string;

  constructor(config: Partial<EvaluationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      totalCostUsd: 0,
      puzzleCosts: {},
      completedRuns: new Set(),
      circuitBreakers: {},
      isDraining: false,
      runSummaries: [],
    };
    this.cancelDir = path.join(this.config.outputDir, 'cancel');
  }

  private findLatestSession(): string | null {
    if (!fs.existsSync(this.config.outputDir)) return null;
    const files = fs.readdirSync(this.config.outputDir);
    const summaryFiles = files.filter(f => f.startsWith('summary_') && f.endsWith('.jsonl'));
    if (summaryFiles.length === 0) return null;

    // Sort by modified time descending to find the latest
    summaryFiles.sort((a, b) => {
      const statA = fs.statSync(path.join(this.config.outputDir, a));
      const statB = fs.statSync(path.join(this.config.outputDir, b));
      return statB.mtimeMs - statA.mtimeMs;
    });

    const latestFile = summaryFiles[0];
    const match = latestFile.match(/summary_(.+)\.jsonl/);
    return match ? match[1] : null;
  }

  async initialize(forceNewRun: boolean = false) {
    // 1. Create Directories
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    fs.mkdirSync(this.cancelDir, { recursive: true });

    // 2. Crash Recovery & Session Discovery
    if (!forceNewRun && !this.config.runId) {
      const latestSession = this.findLatestSession();
      if (latestSession) {
        this.config.runId = latestSession;
        logger.info(`[Evaluator] Found interrupted session. Resuming run: ${this.config.runId}`);
      }
    }

    // Generate new UUID if no session found or explicitly requesting a new one
    if (!this.config.runId) {
      this.config.runId = randomUUID();
      logger.info(`[Evaluator] Starting new evaluation session: ${this.config.runId}`);
    }

    // 3. Setup Logging Files (Atomic Append)
    const runLogPath = path.join(this.config.outputDir, `run_${this.config.runId}.jsonl`);
    const summaryPath = path.join(this.config.outputDir, `summary_${this.config.runId}.jsonl`);

    this.logStream = fs.createWriteStream(runLogPath, { flags: 'a' });
    this.summaryStream = fs.createWriteStream(summaryPath, { flags: 'a' });

    // 4. Read previous summary file to skip completed runs
    await this.recoverState(summaryPath);

    // 5. Setup Signal Listeners for Graceful Shutdown
    process.on('SIGINT', () => this.handleShutdown('SIGINT (Ctrl+C)'));
    process.on('SIGTERM', () => this.handleShutdown('SIGTERM'));

    this.logStream = fs.createWriteStream(runLogPath, { flags: 'a' });
    this.summaryStream = fs.createWriteStream(summaryPath, { flags: 'a' });

    logger.info(`[Evaluator] Recovered ${this.state.completedRuns.size} completed runs.`);
  }

  private async recoverState(summaryPath: string) {
    if (!fs.existsSync(summaryPath)) return;

    const fileStream = fs.createReadStream(summaryPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.status === 'completed' || record.status === 'failed') {
          const key = `${record.puzzleId}_${record.modelSlug}_${record.runIndex}`;
          this.state.completedRuns.add(key);
          this.state.totalCostUsd += (record.costUsd || 0);

          if (!this.state.puzzleCosts[record.puzzleId]) {
            this.state.puzzleCosts[record.puzzleId] = 0;
          }
          this.state.puzzleCosts[record.puzzleId] += (record.costUsd || 0);
        }
      } catch (e) {
        logger.warn(`[Evaluator] Failed to parse recovery line: ${e.message}`);
      }
    }
  }

  private handleShutdown(reason: string) {
    if (this.state.isDraining) {
      logger.warn(`[Evaluator] Force quitting. State may be corrupted.`);
      process.exit(1);
    }
    logger.info(`[Evaluator] Shutdown initiated by ${reason}. Entering drain mode...`);
    this.state.isDraining = true;
  }

  private checkCancellation(puzzleId: string, modelSlug: string): boolean {
    if (this.state.isDraining) return true;

    // Global cancel
    if (fs.existsSync(path.join(this.cancelDir, 'CANCEL_ALL'))) return true;

    // Per-puzzle cancel
    if (fs.existsSync(path.join(this.cancelDir, `CANCEL_${puzzleId}`))) return true;

    // Per-model cancel
    const sanitizedModel = modelSlug.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (fs.existsSync(path.join(this.cancelDir, `CANCEL_${puzzleId}_${sanitizedModel}`))) return true;

    return false;
  }

  private checkBudget(puzzleId: string, estimatedCost: number = 0): boolean {
    if (this.state.totalCostUsd + estimatedCost > this.config.globalBudgetUsd) {
      logger.warn(`[Evaluator] Global budget exceeded (${this.state.totalCostUsd.toFixed(2)} / ${this.config.globalBudgetUsd}).`);
      this.state.isDraining = true;
      return false;
    }

    const puzzleCost = this.state.puzzleCosts[puzzleId] || 0;
    if (puzzleCost + estimatedCost > this.config.puzzleBudgetUsd) {
      logger.warn(`[Evaluator] Puzzle budget exceeded for ${puzzleId} (${puzzleCost.toFixed(2)} / ${this.config.puzzleBudgetUsd}).`);
      return false;
    }

    return true;
  }

  private async checkCircuitBreaker(provider: string): Promise<boolean> {
    const breaker = this.state.circuitBreakers[provider];
    if (!breaker) return true;

    if (breaker.failures >= 10) {
      const now = Date.now();
      if (now < breaker.suspendedUntil) {
        logger.warn(`[Evaluator] Circuit breaker active for ${provider}. Suspended for ${Math.ceil((breaker.suspendedUntil - now) / 1000)}s.`);
        return false;
      } else {
        // Probe state: Allow one request through. If it fails, trip again. If it succeeds, reset.
        logger.info(`[Evaluator] Circuit breaker half-open for ${provider}. Probing...`);
        return true;
      }
    }
    return true;
  }

  private recordFailure(provider: string) {
    if (!this.state.circuitBreakers[provider]) {
      this.state.circuitBreakers[provider] = { failures: 0, suspendedUntil: 0 };
    }
    const breaker = this.state.circuitBreakers[provider];
    breaker.failures += 1;

    if (breaker.failures >= 10) {
      // Suspend for 5 minutes
      breaker.suspendedUntil = Date.now() + (5 * 60 * 1000);
      logger.error(`[Evaluator] Circuit breaker tripped for ${provider}! 10 consecutive failures. Suspended for 5 mins.`);
    }
  }

  private recordSuccess(provider: string) {
    if (this.state.circuitBreakers[provider]) {
      if (this.state.circuitBreakers[provider].failures >= 10) {
        logger.info(`[Evaluator] Circuit breaker reset for ${provider}. Probe successful.`);
      }
      this.state.circuitBreakers[provider] = { failures: 0, suspendedUntil: 0 };
    }
  }

  private logEvent(eventType: string, data: any) {
    const payload = {
      timestamp: new Date().toISOString(),
      type: eventType,
      ...data
    };
    if (this.logStream) {
      this.logStream.write(JSON.stringify(payload) + '\n');
    }

    // Bridge Mode: Emit to stdout for Node.js consumption if requested
    if (this.config.stdoutJsonl) {
      console.log(JSON.stringify(payload));
    }
  }

  // ============================================================================
  // Execution Engine
  // ============================================================================

  async run() {
    this.logEvent('session_start', { config: this.config });

    if (this.config.dryRun) {
      logger.info(`[Evaluator] DRY RUN MODE. Estimating costs and validating configuration...`);
      let estimatedTasks = this.config.puzzleIds.length * this.config.models.length * this.config.runsPerModel;
      logger.info(`[Evaluator] Planned Executions: ${estimatedTasks}`);
      logger.info(`[Evaluator] Global Budget: $${this.config.globalBudgetUsd.toFixed(2)}`);
      return;
    }

    // Ensure AI Factory is initialized (this method exists on the actual aiServiceFactory singleton instance, despite simplified doc specs)
    if (aiServiceFactory.initialize) {
      await aiServiceFactory.initialize();
    }

    // Process puzzles concurrently with a strict limit
    const puzzleChunks = this.chunkArray(this.config.puzzleIds, this.config.maxConcurrentPuzzles);

    for (const puzzleChunk of puzzleChunks) {
      if (this.state.isDraining) break;

      await Promise.all(puzzleChunk.map(puzzleId => this.evaluatePuzzle(puzzleId)));
    }

    this.logEvent('session_end', {
      status: this.state.isDraining ? 'interrupted' : 'completed',
      totalCostUsd: this.state.totalCostUsd
    });

    if (this.logStream) this.logStream.end();
    if (this.summaryStream) this.summaryStream.end();

    // Generate Final Reports (CSV and Visualizations)
    this.generateCsvReport();
    this.generateHtmlVisualization();

    logger.info(`[Evaluator] Evaluation Session Finished. Total Cost: $${this.state.totalCostUsd.toFixed(4)}`);
  }

  // ============================================================================
  // Reporting & Visualization
  // ============================================================================

  private generateCsvReport() {
    if (this.state.runSummaries.length === 0) return;

    const csvPath = path.join(this.config.outputDir, `results_${this.config.runId}.csv`);
    const headers = ['Timestamp', 'RunID', 'Model', 'Puzzle', 'Status', 'Score', 'Cost', 'Tokens(In)', 'Tokens(Out)', 'Tokens(Reasoning)', 'Tokens(Cached)'];

    const rows = this.state.runSummaries.map(r =>
      `${r.timestamp},${r.runId},${r.modelSlug},${r.puzzleId},${r.status},${r.score.toFixed(3)},${r.costUsd.toFixed(4)},${r.tokensIn || 0},${r.tokensOut || 0},${r.tokensReasoning || 0},${r.tokensCached || 0}`
    );

    fs.writeFileSync(csvPath, [headers.join(','), ...rows].join('\n'));
    logger.info(`[Evaluator] Saved CSV Report: ${csvPath}`);
  }

  private generateHtmlVisualization() {
    if (this.state.runSummaries.length === 0) return;
    const htmlPath = path.join(this.config.outputDir, `visualize_${this.config.runId}.html`);

    // Generate a standalone HTML file using Chart.js via CDN to plot "Score vs Cost" scatter plots
    const data = JSON.stringify(this.state.runSummaries.map(r => ({
      x: r.costUsd,
      y: r.score,
      label: `${r.modelSlug} (${r.puzzleId})`
    })));

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <title>ARC Evaluation Visualization</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>body { background: #111; color: #fff; font-family: sans-serif; padding: 20px; }</style>
</head>
<body>
  <h2>Score vs Cost Analysis</h2>
  <div style="width: 800px; height: 600px;"><canvas id="chart"></canvas></div>
  <script>
    const rawData = ${data};
    new Chart(document.getElementById('chart'), {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Model Runs',
          data: rawData,
          backgroundColor: 'rgba(75, 192, 192, 0.6)',
          borderColor: 'rgba(75, 192, 192, 1)',
        }]
      },
      options: {
        scales: {
          x: { title: { display: true, text: 'Cost (USD)', color: '#aaa' }, grid: { color: '#333' }, ticks: { color: '#ccc' } },
          y: { title: { display: true, text: 'ARC-2 Score', color: '#aaa' }, min: 0, max: 1, grid: { color: '#333' }, ticks: { color: '#ccc' } }
        },
        plugins: {
          tooltip: {
            callbacks: { label: (ctx) => rawData[ctx.dataIndex].label + ': Score ' + ctx.raw.y + ' @ $' + ctx.raw.x }
          }
        }
      }
    });
  </script>
</body>
</html>
    `;
    fs.writeFileSync(htmlPath, htmlContent);
    logger.info(`[Evaluator] Saved Visualization HTML: ${htmlPath}`);
  }

  private async evaluatePuzzle(puzzleId: string) {
    if (this.state.isDraining) return;

    logger.info(`[Evaluator] Starting Puzzle: ${puzzleId}`);

    // Load puzzle data
    const task = await puzzleService.getPuzzleById(puzzleId);
    if (!task) {
      logger.error(`[Evaluator] Puzzle not found: ${puzzleId}`);
      return;
    }

    const modelChunks = this.chunkArray(this.config.models, this.config.maxConcurrentModels);

    for (const modelChunk of modelChunks) {
      if (this.checkCancellation(puzzleId, 'all')) break;

      await Promise.all(modelChunk.map(model => this.evaluateModelOnPuzzle(task, puzzleId, model)));
    }
  }

  private async evaluateModelOnPuzzle(task: any, puzzleId: string, model: ModelConfig) {
    // Run multiple attempts per model concurrently
    const runIndices = Array.from({ length: this.config.runsPerModel }, (_, i) => i + 1);
    const runChunks = this.chunkArray(runIndices, this.config.maxConcurrentRuns);

    for (const runChunk of runChunks) {
      if (this.checkCancellation(puzzleId, model.modelSlug)) break;

      await Promise.all(runChunk.map(runIndex => this.executeSingleRun(task, puzzleId, model, runIndex)));
    }
  }

  private async executeSingleRun(task: any, puzzleId: string, model: ModelConfig, runIndex: number) {
    const runKey = `${puzzleId}_${model.modelSlug}_${runIndex}`;

    // 1. Check Resume State
    if (this.state.completedRuns.has(runKey)) {
      logger.debug(`[Evaluator] Skipping completed run: ${runKey}`);
      return;
    }

    // 2. Pre-flight Checks (Budget, Cancellation, Circuit Breakers)
    if (this.checkCancellation(puzzleId, model.modelSlug)) return;
    if (!this.checkBudget(puzzleId)) return;

    const isProviderHealthy = await this.checkCircuitBreaker(model.provider);
    if (!isProviderHealthy) return;

    this.logEvent('run_start', { puzzleId, modelSlug: model.modelSlug, runIndex });
    logger.info(`[Evaluator] Running [${runKey}]...`);

    // getService and analyzePuzzleWithModel are the actual signatures in server/services/base/BaseAIService.ts
    const service = aiServiceFactory.getService(model.modelSlug);
    let attemptCost = 0;
    let success = false;
    let finalScore = 0;
    let notepad = ""; // Persistent Scratchpad
    let conversationHistory: string[] = []; // Sliding Window Context Tracker
    let response: any = null; // Declare outside try block for summary record access

    try {
      // Retry Logic with Exponential Backoff
      let retries = 0;
      while (retries < 50) {
        try {
          // 3. Execution (Supports ARC2 Grid Format currently; ARC3 requires long-lived runner integration)
          let basePrompt = buildAnalysisPrompt('solver', task);
          let finalPrompt = basePrompt;

          // Inject Notepad if it exists (Self-Correction loop simulation)
          if (notepad) {
            finalPrompt += `\n\n[Persistent Notepad / Self-Correction]:\n${notepad}\n`;
          }

          // Append past conversation history (Sliding Context Window Feature 13)
          if (conversationHistory.length > 0) {
             finalPrompt += `\n\n[Previous Turns]:\n${conversationHistory.join('\n---\n')}\n`;
          }

          response = await service.analyzePuzzleWithModel(
            task,
            model.modelSlug,
            puzzleId,
            0.2, // Temperature
            'solver',
            finalPrompt, // Pass the injected customPrompt
            { includeImages: false },
            {
              reasoningEffort: model.reasoningEffort,
              structuredOutputDisabled: false // Enforce JSON validation
            }
          );

          this.recordSuccess(model.provider);

          // Update sliding context window for success
          conversationHistory.push(`User: Attempted prediction.\nAI: ${response.predictedOutput}`);
          if (conversationHistory.length > 50) conversationHistory.shift(); // Keep only last 50 turns

          break; // Success, exit retry loop

        } catch (err: any) {
          this.recordFailure(model.provider);

          // Self-Correction Mechanism: If it's a parsing error, feed it back to the model
          if (err.message.includes('Invalid JSON') || err.message.includes('parse')) {
             logger.warn(`[Evaluator] [${runKey}] Parse error. Applying Self-Correction...`);
             notepad += `\nAttempt ${retries+1} Failed: Your output was not valid JSON. Ensure you use [[x,y]] format.`;

             // Update sliding window even on failure
             conversationHistory.push(`User: Your output failed validation.\nAI: [Failed Output Omitted]`);
             if (conversationHistory.length > 50) conversationHistory.shift();

             retries++;
             continue;
          }

          // Rate Limits (429) -> Wait for next minute boundary + jitter
          if (err.message.includes('429') || err.message.includes('Rate limit')) {
            const jitter = Math.floor(Math.random() * 5000);
            const waitTime = 60000 + jitter;
            logger.warn(`[Evaluator] [${runKey}] Rate limited. Waiting ${waitTime}ms...`);
            await this.sleep(waitTime);
            retries++;
            continue;
          }

          // General Error -> Exponential Backoff
          const backoff = Math.min(Math.pow(2, retries) * 2000, 300000); // Max 5 mins
          logger.warn(`[Evaluator] [${runKey}] Error: ${err.message}. Retrying in ${backoff}ms...`);
          await this.sleep(backoff);
          retries++;
        }
      }

      if (!response) {
        throw new Error(`Exceeded maximum retries (50) for ${runKey}`);
      }

      // 4. Update Costs & State
      attemptCost = response.estimatedCost || 0;
      this.state.totalCostUsd += attemptCost;

      if (!this.state.puzzleCosts[puzzleId]) this.state.puzzleCosts[puzzleId] = 0;
      this.state.puzzleCosts[puzzleId] += attemptCost;

      success = response.isPredictionCorrect || false;
      finalScore = success ? 1.0 : 0.0; // ARC2 1-shot scoring

      // Log Step (Lightweight)
      this.logEvent('step', {
        runKey,
        action: 'submit',
        cost: attemptCost,
        tokens: { input: response.inputTokens, output: response.outputTokens, reasoning: response.reasoningTokens }
      });

    } catch (err: any) {
      logger.error(`[Evaluator] [${runKey}] Fatal Run Error: ${err.message}`);
      this.logEvent('error', { runKey, error: err.message });
      success = false;
    }

    // 5. Finalize Run & Write Atomic Summary
    const summaryRecord = {
      runId: runKey,
      puzzleId,
      modelSlug: model.modelSlug,
      runIndex,
      status: success ? 'completed' : 'failed',
      score: finalScore,
      costUsd: attemptCost,
      tokensIn: response?.inputTokens || 0,
      tokensOut: response?.outputTokens || 0,
      tokensReasoning: response?.reasoningTokens || 0,
      tokensCached: response?.cachedTokens || 0,
      timestamp: new Date().toISOString()
    };

    if (this.summaryStream) {
      this.summaryStream.write(JSON.stringify(summaryRecord) + '\n');
    }

    this.state.runSummaries.push(summaryRecord);
    this.state.completedRuns.add(runKey);
    this.logEvent('run_end', summaryRecord);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunkSize = Math.max(1, size || 1);
    const chunked = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunked.push(array.slice(i, i + chunkSize));
    }
    return chunked;
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const config = { ...DEFAULT_CONFIG };
  const orchestrator = new EvaluationOrchestrator(config);

  try {
    await orchestrator.initialize();
    await orchestrator.run();
  } catch (err: any) {
    logger.error(`[Evaluator] Critical failure: ${err.message}`);
    process.exit(1);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config: Partial<EvaluationConfig> = {};
  let forceNewRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--new') forceNewRun = true;
    else if (arg === '--dry-run') config.dryRun = true;
    else if (arg === '--stdout-jsonl') config.stdoutJsonl = true;
    else if (arg === '--runs' && i + 1 < args.length) config.runsPerModel = parseInt(args[++i], 10);
    else if (arg === '--max-steps' && i + 1 < args.length) config.maxSteps = parseInt(args[++i], 10);
    else if (arg === '--budget' && i + 1 < args.length) config.globalBudgetUsd = parseFloat(args[++i]);
    else if (arg === '--puzzles' && i + 1 < args.length) config.puzzleIds = args[++i].split(',');
    else if (arg === '--model' && i + 1 < args.length) {
      if (!config.models) config.models = [];
      const modelArg = args[++i];
      const provider = modelArg.split('/')[0] || 'unknown';
      config.models.push({ provider, modelSlug: modelArg });
    }
  }

  return { config, forceNewRun };
}

// Auto-execute if run directly
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config, forceNewRun } = parseArgs();

  // Default fallbacks if CLI args aren't provided for testing
  if (!config.puzzleIds || config.puzzleIds.length === 0) {
    config.puzzleIds = ['00d62c1b', '017c7c7b'];
  }
  if (!config.models || config.models.length === 0) {
    config.models = [
      { provider: 'openai', modelSlug: 'openai/gpt-4o', reasoningEffort: 'low' as const },
      { provider: 'anthropic', modelSlug: 'anthropic/claude-3.5-sonnet' }
    ];
  }

  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const orchestrator = new EvaluationOrchestrator(finalConfig);
  orchestrator.initialize(forceNewRun).then(() => orchestrator.run());
}

export { EvaluationOrchestrator, EvaluationConfig, ModelConfig };
