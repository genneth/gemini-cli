/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MessageType,
  type HistoryItemContextWindow,
  type LastCompressionEvent,
  type MemoryBreakdown,
  type MemoryFileInfo,
  type McpInstructionInfo,
  type NodeTypeSummary,
  type TopConsumer,
} from '../types.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import {
  tokenLimit,
  estimateTokenCountSync,
  flattenMemory,
  type ConcreteNode,
  type ContextManager,
  type GraphMutation,
} from '@google/gemini-cli-core';
import type { Content, Tool } from '@google/genai';

const TOP_CONSUMERS_LIMIT = 8;
const TOP_CONSUMER_LABEL_MAX = 60;

/** First non-empty text fragment of a node, truncated for display. */
function nodeLabel(node: ConcreteNode): string {
  let raw: string;
  const p = node.payload;
  switch (node.type) {
    case 'USER_PROMPT':
      raw = p.text ?? '(non-text prompt)';
      break;
    case 'TOOL_EXECUTION':
      raw = p.functionCall?.name ?? '(tool execution)';
      break;
    case 'MASKED_TOOL':
      raw = p.functionCall?.name ?? p.functionResponse?.name ?? '(masked tool)';
      break;
    case 'AGENT_THOUGHT':
    case 'AGENT_YIELD':
    case 'SNAPSHOT':
    case 'ROLLING_SUMMARY':
      raw = p.text ?? '';
      break;
    case 'SYSTEM_EVENT':
      raw = node.name;
      break;
    default:
      raw = '';
  }
  raw = raw.replace(/\s+/g, ' ').trim();
  if (raw.length > TOP_CONSUMER_LABEL_MAX) {
    return raw.slice(0, TOP_CONSUMER_LABEL_MAX - 1) + '…';
  }
  return raw;
}

/** Count USER_PROMPT nodes between (exclusive) the given index and the tail. */
function turnsFromIndex(nodes: readonly ConcreteNode[], idx: number): number {
  let turns = 0;
  for (let i = idx + 1; i < nodes.length; i++) {
    if (nodes[i].type === 'USER_PROMPT') turns++;
  }
  return turns;
}

function buildTopConsumers(
  nodes: readonly ConcreteNode[],
  manager: ContextManager,
): TopConsumer[] {
  const tokenCalc = manager.getEnvironment().tokenCalculator;
  const ranked = nodes
    .map((node, idx) => ({
      node,
      idx,
      tokens: tokenCalc.getTokenCost(node),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_CONSUMERS_LIMIT);

  return ranked.map(({ node, idx, tokens }) => ({
    nodeType: node.type,
    label: nodeLabel(node),
    tokens,
    ageTurns: turnsFromIndex(nodes, idx),
  }));
}

function buildTypeBreakdown(
  nodes: readonly ConcreteNode[],
  manager: ContextManager,
): NodeTypeSummary[] {
  const tokenCalc = manager.getEnvironment().tokenCalculator;
  const totals = new Map<string, { count: number; tokens: number }>();
  for (const node of nodes) {
    const entry = totals.get(node.type) ?? { count: 0, tokens: 0 };
    entry.count += 1;
    entry.tokens += tokenCalc.getTokenCost(node);
    totals.set(node.type, entry);
  }
  return Array.from(totals.entries())
    .map(([nodeType, { count, tokens }]) => ({ nodeType, count, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
}

function buildLastCompression(
  manager: ContextManager,
  activeNodes: readonly ConcreteNode[],
): LastCompressionEvent | null {
  const log = manager.getAuditLog();
  // Find the most recent mutation that actually changed something. A no-op
  // pass through a processor still emits an entry but with empty added/removed.
  let mutation: GraphMutation | undefined;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.removedIds.length > 0 || entry.addedNodes.length > 0) {
      mutation = entry;
      break;
    }
  }
  if (!mutation) return null;

  // Build a best-effort lookup table for removed nodes from sources we can
  // reach: current active nodes, the pristine graph, and earlier mutations'
  // added nodes. Anything not found leaves tokensSaved imprecise.
  const lookup = new Map<string, ConcreteNode>();
  for (const node of activeNodes) lookup.set(node.id, node);
  for (const node of manager.getPristineGraph()) lookup.set(node.id, node);
  for (const earlier of log) {
    if (earlier === mutation) break;
    for (const node of earlier.addedNodes) lookup.set(node.id, node);
  }

  const tokenCalc = manager.getEnvironment().tokenCalculator;
  let removedTokens = 0;
  let removedKnown = true;
  for (const id of mutation.removedIds) {
    const node = lookup.get(id);
    if (!node) {
      removedKnown = false;
      break;
    }
    removedTokens += tokenCalc.getTokenCost(node);
  }

  const addedTokens = mutation.addedNodes.reduce(
    (sum, node) => sum + tokenCalc.getTokenCost(node),
    0,
  );

  // Approximate "turns ago" by counting USER_PROMPT nodes in the active graph
  // that are newer than this mutation. Imprecise once the mutation itself ages
  // out of the active view, but cheaper than reconstructing graph snapshots.
  let turnsAgo = 0;
  for (const node of activeNodes) {
    if (node.type === 'USER_PROMPT' && node.timestamp > mutation.timestamp) {
      turnsAgo++;
    }
  }

  return {
    processorId: mutation.processorId,
    secondsAgo: Math.max(
      0,
      Math.round((Date.now() - mutation.timestamp) / 1000),
    ),
    turnsAgo,
    removedCount: mutation.removedIds.length,
    addedCount: mutation.addedNodes.length,
    tokensSaved: removedKnown ? removedTokens - addedTokens : null,
  };
}

function estimateStringTokens(text: string): number {
  if (!text) return 0;
  return estimateTokenCountSync([{ text }]);
}

function estimateTurnTokens(content: Content): number {
  return estimateTokenCountSync(content.parts || []);
}

function estimateToolDeclarationTokens(tools: readonly Tool[]): number {
  if (!tools || tools.length === 0) return 0;
  return estimateStringTokens(JSON.stringify(tools));
}

async function contextAction(context: CommandContext): Promise<void> {
  const config = context.services.agentContext?.config;
  if (!config) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Config not available.',
    });
    return;
  }

  const client = config.getGeminiClient();
  if (!client || !client.isInitialized()) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Chat not initialized yet.',
    });
    return;
  }

  const chat = client.getChat();
  const history = chat.getHistory();
  const model = config.getModel() || 'unknown';
  const limit = tokenLimit(model);

  // System prompt tokens (includes memory content)
  const sysInstruction = chat.getSystemInstruction();
  const totalSystemTokens = estimateStringTokens(sysInstruction);

  // Memory tokens from the *loaded* content (what's actually in the system
  // instruction), not from disk — files may have been edited since load.
  const loadedMemory = flattenMemory(config.getUserMemory());
  const memoryTokens = estimateStringTokens(loadedMemory);

  // Memory breakdown by category and per-file info
  let memoryBreakdown: MemoryBreakdown | null = null;
  let memoryFiles: MemoryFileInfo[] = [];
  let memoryFileCount = 0;
  const ctxMgr = config.getMemoryContextManager();
  if (ctxMgr) {
    memoryBreakdown = {
      global: estimateStringTokens(ctxMgr.getGlobalMemory()),
      project: estimateStringTokens(ctxMgr.getEnvironmentMemory()),
      extension: estimateStringTokens(ctxMgr.getExtensionMemory()),
      userProject: estimateStringTokens(ctxMgr.getUserProjectMemory()),
    };

    // Per-file breakdown from categorized paths
    const categorized = ctxMgr.getCategorizedLoadedPaths();
    const buildFileInfos = (
      paths: string[],
      category: MemoryFileInfo['category'],
    ): MemoryFileInfo[] => paths.map((path) => ({ path, tokens: 0, category }));

    memoryFiles = [
      ...buildFileInfos(categorized.global, 'global'),
      ...buildFileInfos(categorized.extension, 'extension'),
      ...buildFileInfos(categorized.project, 'project'),
      ...buildFileInfos(categorized.userProject, 'userProject'),
    ];
    memoryFileCount = memoryFiles.length;
  } else {
    // No ContextManager (JIT off) — use flat path list, infer category from path
    const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const homeGemini = home ? home.replace(/\\/g, '/') + '/.gemini' : '';
    const paths = config.getGeminiMdFilePaths() || [];
    memoryFiles = paths.map((p) => {
      const norm = p.replace(/\\/g, '/').toLowerCase();
      let category: MemoryFileInfo['category'] = 'project';
      if (
        homeGemini &&
        norm.startsWith(homeGemini.toLowerCase() + '/extensions/')
      ) {
        category = 'extension';
      } else if (homeGemini && norm.startsWith(homeGemini.toLowerCase())) {
        category = 'global';
      }
      return { path: p, tokens: 0, category };
    });
    memoryFileCount = paths.length;
  }

  // MCP instructions breakdown (separate from project memory files)
  const mcpInstructions: McpInstructionInfo[] = [];
  let mcpInstructionTokens = 0;
  const mcpMgr = config.getMcpClientManager();
  if (mcpMgr) {
    for (const entry of mcpMgr.getMcpInstructionsByServer()) {
      const tokens = estimateStringTokens(entry.instructions);
      mcpInstructions.push({ serverName: entry.serverName, tokens });
      mcpInstructionTokens += tokens;
    }
  }

  // Core system prompt = total system instruction minus loaded memory
  const systemPromptTokens = Math.max(0, totalSystemTokens - memoryTokens);

  // Tool declarations
  const tools = chat.getTools();
  const toolDeclarationTokens = estimateToolDeclarationTokens(tools);
  const toolCount = tools.reduce(
    (sum, t) => sum + (t.functionDeclarations?.length ?? 0),
    0,
  );

  // Conversation history (heuristic estimate)
  const turnCount = history.length;
  let conversationHeuristic = 0;
  for (const turn of history) {
    conversationHeuristic += estimateTurnTokens(turn);
  }

  // Actual token count from last API response (if available)
  const lastPromptTokens = chat.getLastPromptTokenCount();
  const actualPromptTokens = lastPromptTokens > 0 ? lastPromptTokens : null;

  // Compression threshold
  const compressionThreshold = (await config.getCompressionThreshold()) ?? 0.5;

  // Context management state. `contextManagementEnabled` reflects the config
  // flag; `contextManagerActive` reflects whether the pipeline was actually
  // wired (initialization can return undefined even when the flag is on).
  const contextManagementEnabled = config.isContextManagementEnabled();
  const contextManager = client.getContextManager();
  const contextManagerActive = contextManager !== undefined;

  // ContextManager-derived diagnostics (T1 top consumers, type breakdown,
  // T2 last compression event). These are only meaningful when CM is on,
  // since legacy compression doesn't expose per-node provenance.
  let topConsumers: TopConsumer[] | null = null;
  let nodeTypeBreakdown: NodeTypeSummary[] | null = null;
  let lastCompression: LastCompressionEvent | null = null;
  let cmRetainedTokenBudget: number | null = null;
  let cmProfileName: string | null = null;
  if (contextManager) {
    const activeNodes = contextManager.getNodes();
    topConsumers = buildTopConsumers(activeNodes, contextManager);
    nodeTypeBreakdown = buildTypeBreakdown(activeNodes, contextManager);
    lastCompression = buildLastCompression(contextManager, activeNodes);
    cmRetainedTokenBudget = contextManager.getRetainedTokenBudget() ?? null;
    cmProfileName = contextManager.getProfileName();
  }

  // Total tokens: prefer the API count when we have it (ground truth), else
  // fall back to the heuristic sum. The conversation row gets two numbers when
  // both are available and they materially diverge.
  const staticTotal = systemPromptTokens + memoryTokens + toolDeclarationTokens;
  const totalTokens =
    actualPromptTokens !== null
      ? actualPromptTokens
      : staticTotal + conversationHeuristic;
  const totalTokensSource: 'api' | 'estimated' =
    actualPromptTokens !== null ? 'api' : 'estimated';
  const conversationResidual =
    actualPromptTokens !== null
      ? Math.max(0, actualPromptTokens - staticTotal)
      : null;
  const materiallyDivergent =
    conversationResidual !== null
      ? isMateriallyDivergent(conversationHeuristic, conversationResidual)
      : false;

  // Estimated turns remaining only meaningful with the legacy threshold AND
  // an API-confirmed total. Under ContextManager retention is continuous
  // against an absolute budget; under heuristic-only mode the denominator is
  // unreliable (multimodal over-counting), so the prediction would be junk.
  let estimatedTurnsRemaining: number | null = null;
  if (!contextManagerActive && totalTokensSource === 'api') {
    const compressionTokenLimit = compressionThreshold * limit;
    const tokensUntilCompression = Math.max(
      0,
      compressionTokenLimit - totalTokens,
    );
    const avgTokensPerTurn =
      conversationResidual !== null && turnCount > 0
        ? conversationResidual / turnCount
        : 0;
    estimatedTurnsRemaining =
      avgTokensPerTurn > 0
        ? Math.floor(tokensUntilCompression / avgTokensPerTurn)
        : null;
  }

  const item: HistoryItemContextWindow = {
    type: MessageType.CONTEXT_WINDOW,
    data: {
      model,
      tokenLimit: limit,
      totalTokens,
      totalTokensSource,
      systemPromptTokens,
      memoryTokens,
      memoryFileCount,
      memoryBreakdown,
      memoryFiles,
      mcpInstructions,
      mcpInstructionTokens,
      toolDeclarationTokens,
      toolCount,
      conversationTokens: {
        heuristic: conversationHeuristic,
        residual: conversationResidual,
        materiallyDivergent,
      },
      turnCount,
      compressionThreshold,
      estimatedTurnsRemaining,
      contextManagementEnabled,
      contextManagerActive,
      cmRetainedTokenBudget,
      cmProfileName,
      topConsumers,
      nodeTypeBreakdown,
      lastCompression,
    },
  };
  context.ui.addItem(item);
}

/**
 * Heuristic-vs-residual divergence test for the conversation row.
 * Returns true when BOTH conditions hold:
 *   |heuristic − residual| >= 10_000 tokens, AND
 *   max(heuristic, residual) / min(heuristic, residual) >= 1.5.
 * Small absolute discrepancies (<10k) and small relative ones (<1.5×) are
 * absorbed silently. Both must trip — a 6k absolute gap with a 4× ratio
 * (e.g. 8k vs 2k) isn't material; a 50k gap at 1.1× isn't either.
 */
function isMateriallyDivergent(heuristic: number, residual: number): boolean {
  const abs = Math.abs(heuristic - residual);
  if (abs < 10_000) return false;
  const hi = Math.max(heuristic, residual);
  const lo = Math.min(heuristic, residual);
  if (lo === 0) return hi >= 10_000;
  return hi / lo >= 1.5;
}

export const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Show what is in the current context window',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: contextAction,
};
