/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MessageType,
  type HistoryItemContextWindow,
  type MemoryBreakdown,
  type MemoryFileInfo,
  type McpInstructionInfo,
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
} from '@google/gemini-cli-core';
import type { Content, Tool } from '@google/genai';

function estimateStringTokens(text: string): number {
  if (!text) return 0;
  return estimateTokenCountSync([{ text }]);
}

function estimateTurnTokens(content: Content): number {
  return estimateTokenCountSync(content.parts || []);
}

function estimateToolDeclarationTokens(tools: readonly Tool[]): number {
  if (!tools || tools.length === 0) return 0;
  return Math.floor(JSON.stringify(tools).length / 4);
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
    // No ContextManager (JIT off) — use flat path list without categories
    const paths = config.getGeminiMdFilePaths() || [];
    memoryFiles = paths.map((p) => ({
      path: p,
      tokens: 0,
      category: 'project',
    }));
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

  // Conversation history
  const turnCount = history.length;
  let conversationTokens = 0;
  for (const turn of history) {
    conversationTokens += estimateTurnTokens(turn);
  }

  // Actual token count from last API response (if available)
  const lastPromptTokens = chat.getLastPromptTokenCount();
  const actualPromptTokens = lastPromptTokens > 0 ? lastPromptTokens : null;

  // Compression threshold
  const compressionThreshold = (await config.getCompressionThreshold()) ?? 0.5;

  // Context management state
  const contextManagementEnabled = config.isAutoDistillationEnabled();
  const jitContextEnabled = config.isJitContextEnabled();

  // Estimated turns remaining before compression
  const tokensUsed =
    systemPromptTokens +
    memoryTokens +
    toolDeclarationTokens +
    conversationTokens;
  const compressionTokenLimit = compressionThreshold * limit;
  const tokensUntilCompression = Math.max(
    0,
    compressionTokenLimit - tokensUsed,
  );
  const avgTokensPerTurn = turnCount > 0 ? conversationTokens / turnCount : 0;
  const estimatedTurnsRemaining =
    avgTokensPerTurn > 0
      ? Math.floor(tokensUntilCompression / avgTokensPerTurn)
      : null;

  const item: HistoryItemContextWindow = {
    type: MessageType.CONTEXT_WINDOW,
    data: {
      model,
      tokenLimit: limit,
      tokensUsed,
      actualPromptTokens,
      systemPromptTokens,
      memoryTokens,
      memoryFileCount,
      memoryBreakdown,
      memoryFiles,
      mcpInstructions,
      mcpInstructionTokens,
      toolDeclarationTokens,
      toolCount,
      conversationTokens,
      turnCount,
      compressionThreshold,
      estimatedTurnsRemaining,
      contextManagementEnabled,
      jitContextEnabled,
    },
  };
  context.ui.addItem(item);
}

export const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Show what is in the current context window',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: contextAction,
};
