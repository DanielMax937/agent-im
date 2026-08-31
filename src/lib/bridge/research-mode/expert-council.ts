/**
 * Expert Council for research mode.
 *
 * When the reviewer consecutively rejects Agent A's work (≥ threshold),
 * the orchestrator triggers an "expert council" — a set of domain experts
 * whose personas are generated based on the research goal, and who can be
 * consulted via codex exec non-interactive mode.
 *
 * Flow:
 *   1. Agent A reads goal + references → determines ~5 domain experts
 *   2. Each expert gets a persona.md stored in the session directory
 *   3. When consulting, each expert is invoked via `codex exec` with
 *      their persona injected as instructions and the question as prompt
 *   4. Results are aggregated as "Expert Council Notes"
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getLogger } from '../../../logger';

/**
 * Execute codex with prompt piped via stdin (avoids CLI arg length limits).
 * Returns stdout content.
 */
function execCodexWithStdin(
  cmd: string,
  args: string[],
  stdinContent: string,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      timeout: options?.timeout ?? 120_000,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`codex exec exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    // Handle abort signal
    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      });
    }

    // Write prompt to stdin and close
    child.stdin.write(stdinContent);
    child.stdin.end();
  });
}

export interface ExpertDefinition {
  id: string;
  displayName: string;
  domain: string;
  /** Key research works, textbooks, or blogs this expert is known for. */
  signatureWorks: string[];
  /** Methodological stance: conservative/aggressive, theory/practice, etc. */
  stance: string;
  /** Brief persona description for system prompt. */
  personaDescription: string;
}

export interface ExpertCouncilConfig {
  /** Number of consecutive rejections before triggering. Default: 3. */
  rejectThreshold?: number;
  /** Max number of experts to consult. Default: 5. */
  maxExperts?: number;
  /** Max times expert council can be triggered per session. Default: 2. */
  maxCouncilsPerSession?: number;
  /** Model to use for expert consultation. */
  expertModel?: string;
}

export interface ExpertConsultResult {
  expertId: string;
  displayName: string;
  domain: string;
  response: string;
  /** Whether the consultation succeeded. */
  success: boolean;
  error?: string;
}

export interface ExpertCouncilResult {
  experts: ExpertDefinition[];
  consultations: ExpertConsultResult[];
  /** Formatted notes for injection into the researcher's next prompt. */
  formattedNotes: string;
  triggeredAt: string;
}

const DEFAULT_REJECT_THRESHOLD = 5;
const DEFAULT_MAX_EXPERTS = 5;
const DEFAULT_MAX_COUNCILS = 2;

/**
 * Build the prompt that asks an LLM to determine domain experts.
 */
function buildExpertDeterminationPrompt(
  goalText: string,
  referencesSummary: string,
): string {
  return `You are helping set up a research advisory council. Based on the research goal and available references below, determine exactly 5 domain experts who would be most relevant to advise on this work.

## Research Goal

${goalText}

## Available References Summary

${referencesSummary || '(no references provided)'}

## Your Task

For each expert, provide:
1. **id**: A short kebab-case identifier (e.g., "time-series-expert")
2. **displayName**: A descriptive name for the role (e.g., "Time Series Forecasting Specialist")
3. **domain**: Their primary domain of expertise
4. **signatureWorks**: 2-3 key textbooks, papers, or methodologies they are associated with (these serve as anchoring references for their perspective — they represent the methodological lens, not claims of authorship)
5. **stance**: Their methodological stance (e.g., "rigorous statistical testing, skeptical of overfitting")
6. **personaDescription**: A 2-3 sentence description of their advisory style

Output ONLY a JSON array of 5 experts. No other text.

\`\`\`json
[
  {
    "id": "example-expert",
    "displayName": "Example Domain Expert",
    "domain": "example domain",
    "signatureWorks": ["Book A by Author X", "Methodology B"],
    "stance": "conservative, evidence-based",
    "personaDescription": "Approaches problems with rigorous methodology. Always asks for empirical evidence before accepting claims."
  }
]
\`\`\``;
}

/**
 * Parse expert definitions from LLM output.
 */
function parseExpertDefinitions(output: string): ExpertDefinition[] | null {
  // Try to extract JSON array from the output
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter(
        (e: unknown) =>
          e && typeof e === 'object' && 'id' in e && 'displayName' in e,
      )
      .slice(0, DEFAULT_MAX_EXPERTS)
      .map((e: Record<string, unknown>) => ({
        id: String(e.id || 'unknown'),
        displayName: String(e.displayName || 'Expert'),
        domain: String(e.domain || 'general'),
        signatureWorks: Array.isArray(e.signatureWorks)
          ? e.signatureWorks.map(String)
          : [],
        stance: String(e.stance || 'neutral'),
        personaDescription: String(e.personaDescription || ''),
      }));
  } catch {
    return null;
  }
}

/**
 * Generate a persona.md file content for an expert.
 */
function buildPersonaMarkdown(expert: ExpertDefinition): string {
  return `# Expert Persona: ${expert.displayName}

## Domain
${expert.domain}

## Methodological Stance
${expert.stance}

## Key Reference Works (anchoring perspective, not claims of authorship)
${expert.signatureWorks.map((w) => `- ${w}`).join('\n')}

## Advisory Style
${expert.personaDescription}

## Instructions

You are ${expert.displayName}, a domain expert in ${expert.domain}.
Your methodological stance: ${expert.stance}.
Your thinking is anchored in the perspectives and methodologies from: ${expert.signatureWorks.join(', ')}.

When consulted:
- Provide concrete, actionable advice grounded in your domain expertise
- Identify potential pitfalls based on your experience
- Suggest specific approaches or methodologies that could help
- Be direct and specific — avoid generic advice
- If you see a fundamental flaw in the approach, say so clearly
- Note: You are a simulated expert perspective, not a real person
`;
}

/**
 * Write expert persona files to the session directory.
 */
export function writeExpertPersonas(
  sessionDir: string,
  experts: ExpertDefinition[],
): void {
  const expertDir = path.join(sessionDir, 'experts');
  fs.mkdirSync(expertDir, { recursive: true });

  for (const expert of experts) {
    const personaDir = path.join(expertDir, expert.id);
    fs.mkdirSync(personaDir, { recursive: true });
    const personaPath = path.join(personaDir, 'persona.md');
    fs.writeFileSync(personaPath, buildPersonaMarkdown(expert));
  }
}

/**
 * Read expert persona content from disk.
 */
function readPersonaContent(sessionDir: string, expertId: string): string | null {
  const personaPath = path.join(sessionDir, 'experts', expertId, 'persona.md');
  try {
    return fs.readFileSync(personaPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Consult a single expert using codex exec non-interactive mode.
 *
 * The expert's persona.md is injected as system instructions,
 * and the question is provided as the prompt.
 */
export async function consultExpert(
  expert: ExpertDefinition,
  question: string,
  sessionDir: string,
  workingDir: string,
  options?: { model?: string; abortSignal?: AbortSignal },
): Promise<ExpertConsultResult> {
  const log = getLogger().child({ scope: 'expert-council', expertId: expert.id });
  const persona = readPersonaContent(sessionDir, expert.id);
  if (!persona) {
    return {
      expertId: expert.id,
      displayName: expert.displayName,
      domain: expert.domain,
      response: '',
      success: false,
      error: 'persona.md not found',
    };
  }

  // Build codex exec command with persona as instructions via -c flag
  // Use a temp file for instructions to avoid shell quoting issues
  const instructionsFile = path.join(sessionDir, 'experts', expert.id, '.instructions.tmp');
  const outputFile = path.join(sessionDir, 'experts', expert.id, 'response.md');

  try {
    // Write instructions to temp file for reference
    fs.writeFileSync(instructionsFile, persona);

    // Construct full prompt embedding persona + question
    const fullPrompt = `${persona}\n\n---\n\n## Question for ${expert.displayName}\n\n${question}`;

    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ephemeral',
      '--cd', workingDir,
      '-o', outputFile,
      '-', // read prompt from stdin
    ];

    if (options?.model) {
      args.push('-m', options.model);
    }

    log.info({ event: 'expert_consult_start', expert: expert.id, promptLen: fullPrompt.length }, `consulting expert: ${expert.displayName}`);

    const stdout = await execCodexWithStdin('codex', args, fullPrompt, {
      timeout: 120_000,
      signal: options?.abortSignal,
    });

    // Read output file first, fall back to stdout
    let response = '';
    if (fs.existsSync(outputFile)) {
      response = fs.readFileSync(outputFile, 'utf8');
    } else if (stdout) {
      response = stdout;
    }

    log.info({ event: 'expert_consult_done', expert: expert.id, responseLen: response.length }, 'expert consultation complete');

    return {
      expertId: expert.id,
      displayName: expert.displayName,
      domain: expert.domain,
      response: response.trim(),
      success: true,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ event: 'expert_consult_error', expert: expert.id, err: errMsg }, 'expert consultation failed');
    return {
      expertId: expert.id,
      displayName: expert.displayName,
      domain: expert.domain,
      response: '',
      success: false,
      error: errMsg,
    };
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(instructionsFile); } catch { /* ignore */ }
  }
}

/**
 * Determine experts by invoking codex exec with the determination prompt.
 * Uses stdin to pass the prompt (avoids CLI argument length limits).
 */
export async function determineExperts(
  goalText: string,
  referencesSummary: string,
  workingDir: string,
  sessionDir: string,
  options?: { model?: string; abortSignal?: AbortSignal },
): Promise<ExpertDefinition[]> {
  const log = getLogger().child({ scope: 'expert-council' });
  const prompt = buildExpertDeterminationPrompt(goalText, referencesSummary);
  const outputFile = path.join(sessionDir, 'expert-determination.json');

  try {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ephemeral',
      '--cd', workingDir,
      '-o', outputFile,
      '-', // read prompt from stdin
    ];
    if (options?.model) {
      args.push('-m', options.model);
    }

    log.info({ event: 'expert_determination_start', promptLen: prompt.length }, 'determining domain experts');

    const output = await execCodexWithStdin('codex', args, prompt, {
      timeout: 120_000,
      signal: options?.abortSignal,
    });

    // Read from output file first, fall back to stdout
    let result = '';
    if (fs.existsSync(outputFile)) {
      result = fs.readFileSync(outputFile, 'utf8');
    } else if (output) {
      result = output;
    }

    const experts = parseExpertDefinitions(result);
    if (!experts || experts.length === 0) {
      log.warn({ event: 'expert_determination_parse_failed', output: result.slice(0, 500) }, 'failed to parse expert definitions');
      return [];
    }

    // Write persona files
    writeExpertPersonas(sessionDir, experts);
    log.info({ event: 'expert_determination_done', count: experts.length }, `determined ${experts.length} experts`);
    return experts;
  } catch (err) {
    log.warn({ event: 'expert_determination_error', err: err instanceof Error ? err.message : err }, 'expert determination failed');
    return [];
  }
}

/**
 * Run the full expert council: determine experts (if not yet done),
 * then consult each one with the given question.
 */
export async function runExpertCouncil(params: {
  goalText: string;
  referencesSummary: string;
  currentPlanSummary: string;
  lastReviewerAdvice: string;
  failedAttempts: string;
  workingDir: string;
  sessionDir: string;
  existingExperts?: ExpertDefinition[];
  config?: ExpertCouncilConfig;
  abortSignal?: AbortSignal;
}): Promise<ExpertCouncilResult> {
  const {
    goalText,
    referencesSummary,
    currentPlanSummary,
    lastReviewerAdvice,
    failedAttempts,
    workingDir,
    sessionDir,
    existingExperts,
    config,
    abortSignal,
  } = params;

  const model = config?.expertModel;

  // Step 1: Determine experts if not already done
  let experts = existingExperts ?? [];
  if (experts.length === 0) {
    experts = await determineExperts(goalText, referencesSummary, workingDir, sessionDir, {
      model,
      abortSignal,
    });
  }

  if (experts.length === 0) {
    return {
      experts: [],
      consultations: [],
      formattedNotes: '_(Expert council could not determine relevant experts)_',
      triggeredAt: new Date().toISOString(),
    };
  }

  // Step 2: Build the question for experts
  const question = `## Context

### Research Goal
${goalText}

### Current Plan Summary
${currentPlanSummary}

### Reviewer's Latest Advice (reason for rejection)
${lastReviewerAdvice}

### Previous Failed Attempts
${failedAttempts || '(none documented)'}

## What I Need From You

The reviewer has repeatedly rejected my approach. I need your expert perspective on:
1. What fundamental flaw or blind spot do you see in my current approach?
2. What specific alternative approach or methodology would you recommend?
3. What common pitfalls in this domain should I be aware of?

Please be concrete and actionable.`;

  // Step 3: Consult each expert (sequentially to manage resources)
  const consultations: ExpertConsultResult[] = [];
  for (const expert of experts) {
    if (abortSignal?.aborted) break;
    const result = await consultExpert(expert, question, sessionDir, workingDir, {
      model,
      abortSignal,
    });
    consultations.push(result);
  }

  // Step 4: Format results
  const formattedNotes = formatCouncilNotes(consultations);

  return {
    experts,
    consultations,
    formattedNotes,
    triggeredAt: new Date().toISOString(),
  };
}

/**
 * Format consultation results into a readable notes section.
 */
function formatCouncilNotes(consultations: ExpertConsultResult[]): string {
  const successful = consultations.filter((c) => c.success && c.response);
  if (successful.length === 0) {
    return '_(Expert council consultation yielded no usable responses)_';
  }

  const sections = successful.map(
    (c) =>
      `### 🎓 ${c.displayName} (${c.domain})\n\n${c.response.slice(0, 3000)}\n`,
  );

  return `## Expert Council Notes\n\nThe following domain experts were consulted after repeated plan rejections:\n\n${sections.join('\n---\n\n')}`;
}

/**
 * Check if the expert council should be triggered based on consecutive rejections.
 * Uses default threshold of 5 if not explicitly configured.
 */
export function shouldTriggerExpertCouncil(
  consecutiveRejects: number,
  councilsTriggered: number,
  config?: ExpertCouncilConfig,
): boolean {
  const threshold = config?.rejectThreshold ?? DEFAULT_REJECT_THRESHOLD;
  const maxCouncils = config?.maxCouncilsPerSession ?? DEFAULT_MAX_COUNCILS;
  // Trigger at threshold multiples: first at threshold, second at threshold*2, etc.
  const nextTriggerAt = threshold * (councilsTriggered + 1);
  return consecutiveRejects >= nextTriggerAt && councilsTriggered < maxCouncils;
}
