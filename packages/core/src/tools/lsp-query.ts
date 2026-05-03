/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { LSP_QUERY_TOOL_NAME } from './tool-names.js';
import { LSP_QUERY_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { formatDiagnostics, formatSymbolSummary } from '../lsp/enrichment.js';
import { LspTimeoutError } from '../lsp/client.js';
import { getGitIgnoredPaths, findGitRoot } from '../utils/gitUtils.js';
import { fileURLToPath } from 'node:url';
import { ideContextStore } from '../ide/ideContext.js';
import type {
  Hover,
  Location,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  SymbolInformation,
} from '../lsp/types.js';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface LspQueryParams {
  operation:
    | 'diagnostics'
    | 'hover'
    | 'definition'
    | 'implementation'
    | 'references'
    | 'document_symbols'
    | 'workspace_symbols'
    | 'prepare_call_hierarchy'
    | 'incoming_calls'
    | 'outgoing_calls';
  file_path: string;
  line?: number;
  character?: number;
  query?: string;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class LspQueryInvocation extends BaseToolInvocation<
  LspQueryParams,
  ToolResult
> {
  private readonly resolvedPath: string;

  constructor(
    private readonly config: Config,
    params: LspQueryParams,
    messageBus: MessageBus,
  ) {
    super(params, messageBus, LSP_QUERY_TOOL_NAME, 'LSP Query');
    this.resolvedPath = path.resolve(config.getTargetDir(), params.file_path);
  }

  /**
   * Convert 1-based line/character from the model to 0-based for LSP.
   * If line/character is omitted, attempts to read them from the active IDE
   * cursor context (if the queried file matches the active IDE file).
   * Falls back to the first non-whitespace character on that line.
   */
  private async getPosition(): Promise<{ line: number; character: number }> {
    const ideContext = ideContextStore.get();
    const activeFile = ideContext?.workspaceState?.openFiles?.find(
      (f) => f.isActive,
    );

    // If the file being queried is the currently active file in the IDE
    const isActiveFile =
      activeFile && path.resolve(activeFile.path) === this.resolvedPath;

    let lineParam = this.params.line;
    let charParam = this.params.character;

    if (isActiveFile && activeFile.cursor) {
      if (lineParam === undefined) {
        lineParam = activeFile.cursor.line;
      }
      if (charParam === undefined && this.params.line === undefined) {
        // Only inherit character if line was also omitted (or both omitted)
        // to avoid mixing a model-provided line with an unrelated IDE character offset.
        charParam = activeFile.cursor.character;
      }
    }

    const line = Math.max(0, (lineParam ?? 1) - 1);

    if (charParam !== undefined) {
      return { line, character: Math.max(0, charParam - 1) };
    }

    // Default to first non-whitespace character on the line.
    try {
      const content = await fs.readFile(this.resolvedPath, 'utf-8');
      const lines = content.split('\n');
      if (line < lines.length) {
        const lineText = lines[line];
        const match = lineText.match(/\S/);
        if (match?.index !== undefined) {
          return { line, character: match.index };
        }
      }
    } catch {
      // Fall through to default.
    }
    return { line, character: 0 };
  }

  getDescription(): string {
    const op = this.params.operation;
    const file = path.basename(this.resolvedPath);
    if (op === 'hover' || op === 'definition' || op === 'references') {
      return `lsp_query ${op} at ${file}:${this.params.line}:${this.params.character ?? '?'}`;
    }
    if (op === 'workspace_symbols') {
      return `lsp_query workspace_symbols "${this.params.query}"`;
    }
    return `lsp_query ${op} on ${file}`;
  }

  async execute({ abortSignal: signal }: ExecuteOptions): Promise<ToolResult> {
    const lspMgr = await this.config.getLspManager();
    if (!lspMgr) {
      return {
        llmContent:
          'LSP is not enabled. Enable it in settings with { "tools": { "lsp": { "enabled": true } } } and restart.',
        returnDisplay: 'LSP not enabled.',
        error: {
          message: 'LSP not enabled',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    if (!lspMgr.hasServerFor(this.resolvedPath)) {
      return {
        llmContent: `No language server is configured for ${path.basename(this.resolvedPath)}. LSP supports TypeScript and Python.`,
        returnDisplay: 'No LSP server for this file type.',
        error: {
          message: 'No server for file type',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    try {
      switch (this.params.operation) {
        case 'diagnostics':
          return await this.runDiagnostics(signal);
        case 'hover':
          return await this.runHover(signal);
        case 'definition':
          return await this.runDefinition(signal);
        case 'implementation':
          return await this.runImplementation(signal);
        case 'references':
          return await this.runReferences(signal);
        case 'document_symbols':
          return await this.runDocumentSymbols(signal);
        case 'workspace_symbols':
          return await this.runWorkspaceSymbols(signal);
        case 'prepare_call_hierarchy':
          return await this.runPrepareCallHierarchy(signal);
        case 'incoming_calls':
          return await this.runIncomingCalls(signal);
        case 'outgoing_calls':
          return await this.runOutgoingCalls(signal);
        default:
          return {
            llmContent: `Unknown operation: ${this.params.operation}`,
            returnDisplay: 'Unknown LSP operation.',
            error: {
              message: `Unknown operation: ${this.params.operation}`,
              type: ToolErrorType.INVALID_TOOL_PARAMS,
            },
          };
      }
    } catch (e) {
      if (e instanceof LspTimeoutError) {
        return {
          llmContent:
            'LSP server timed out processing this request. The server may be busy indexing or the file may be very large. Try again shortly.',
          returnDisplay: 'LSP timed out.',
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return {
        llmContent: `LSP query failed: ${msg}`,
        returnDisplay: `LSP error: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }

  private async runDiagnostics(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const content = await fs.readFile(this.resolvedPath, 'utf-8');
    const result = await lspMgr.getDiagnostics(
      this.resolvedPath,
      content,
      signal,
    );

    if (result.timedOut) {
      return {
        llmContent:
          'LSP server timed out. It may still be starting up. Try again shortly.',
        returnDisplay: 'LSP timed out.',
      };
    }

    if (result.diagnostics.length === 0) {
      return {
        llmContent: `No diagnostics for ${path.basename(this.resolvedPath)}.`,
        returnDisplay: 'No diagnostics.',
      };
    }

    return {
      llmContent: formatDiagnostics(result.diagnostics, this.resolvedPath),
      returnDisplay: `${result.diagnostics.length} diagnostic(s).`,
    };
  }

  private async runHover(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const pos = await this.getPosition();
    const hover = await lspMgr.getHover(
      this.resolvedPath,
      pos.line,
      pos.character,
      signal,
    );

    if (!hover) {
      return {
        llmContent: 'No hover information available at this position.',
        returnDisplay: 'No hover info.',
      };
    }

    const text = formatHoverContent(hover);
    return { llmContent: text, returnDisplay: 'Hover info retrieved.' };
  }

  private async runDefinition(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const pos = await this.getPosition();
    const locations = await lspMgr.getDefinition(
      this.resolvedPath,
      pos.line,
      pos.character,
      signal,
    );

    if (locations.length === 0) {
      return {
        llmContent: 'No definition found at this position.',
        returnDisplay: 'No definition found.',
      };
    }

    const text = formatLocations(locations, 'Definition');
    return {
      llmContent: text,
      returnDisplay: `${locations.length} definition(s) found.`,
    };
  }

  private async filterIgnoredLocations(
    locations: Location[],
  ): Promise<Location[]> {
    if (locations.length === 0) return locations;
    const gitRoot = findGitRoot(this.config.getTargetDir());
    if (!gitRoot) return locations;

    const uniquePaths = new Set<string>();
    for (const loc of locations) {
      try {
        uniquePaths.add(fileURLToPath(loc.uri));
      } catch {
        // Ignore invalid URIs
      }
    }

    const ignored = await getGitIgnoredPaths(Array.from(uniquePaths), gitRoot);
    if (ignored.size === 0) return locations;

    return locations.filter((loc) => {
      try {
        const filePath = fileURLToPath(loc.uri);
        return !ignored.has(filePath);
      } catch {
        return true;
      }
    });
  }

  private async runReferences(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const pos = await this.getPosition();
    const rawLocations = await lspMgr.getReferences(
      this.resolvedPath,
      pos.line,
      pos.character,
      signal,
    );

    const locations = await this.filterIgnoredLocations(rawLocations);

    if (locations.length === 0) {
      return {
        llmContent: 'No references found at this position.',
        returnDisplay: 'No references found.',
      };
    }

    const text = formatLocations(locations, 'References');
    return {
      llmContent: text,
      returnDisplay: `${locations.length} reference(s) found.`,
    };
  }

  private async runImplementation(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const pos = await this.getPosition();
    const rawLocations = await lspMgr.getImplementation(
      this.resolvedPath,
      pos.line,
      pos.character,
      signal,
    );

    const locations = await this.filterIgnoredLocations(rawLocations);

    if (locations.length === 0) {
      return {
        llmContent: 'No implementation found at this position.',
        returnDisplay: 'No implementation found.',
      };
    }

    const text = formatLocations(locations, 'Implementation');
    return {
      llmContent: text,
      returnDisplay: `${locations.length} implementation(s) found.`,
    };
  }

  private async runPrepareCallHierarchy(
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const pos = await this.getPosition();
    const items = await lspMgr.prepareCallHierarchy(
      this.resolvedPath,
      pos.line,
      pos.character,
      signal,
    );

    if (items.length === 0) {
      return {
        llmContent: 'No call hierarchy available at this position.',
        returnDisplay: 'No call hierarchy info.',
      };
    }

    const text = formatCallHierarchyItems(items);
    return {
      llmContent: text,
      returnDisplay: `${items.length} call hierarchy item(s) found.`,
    };
  }

  private async runIncomingCalls(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const pos = await this.getPosition();
    const items = await lspMgr.prepareCallHierarchy(
      this.resolvedPath,
      pos.line,
      pos.character,
      signal,
    );

    if (items.length === 0) {
      return {
        llmContent: 'No call hierarchy available at this position.',
        returnDisplay: 'No call hierarchy info.',
      };
    }

    const calls = await lspMgr.getIncomingCalls(
      this.resolvedPath,
      items[0],
      signal,
    );

    if (calls.length === 0) {
      return {
        llmContent: 'No incoming calls found.',
        returnDisplay: 'No incoming calls.',
      };
    }

    const text = formatIncomingCalls(calls);
    return {
      llmContent: text,
      returnDisplay: `${calls.length} incoming call(s) found.`,
    };
  }

  private async runOutgoingCalls(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const pos = await this.getPosition();
    const items = await lspMgr.prepareCallHierarchy(
      this.resolvedPath,
      pos.line,
      pos.character,
      signal,
    );

    if (items.length === 0) {
      return {
        llmContent: 'No call hierarchy available at this position.',
        returnDisplay: 'No call hierarchy info.',
      };
    }

    const calls = await lspMgr.getOutgoingCalls(
      this.resolvedPath,
      items[0],
      signal,
    );

    if (calls.length === 0) {
      return {
        llmContent: 'No outgoing calls found.',
        returnDisplay: 'No outgoing calls.',
      };
    }

    const text = formatOutgoingCalls(calls);
    return {
      llmContent: text,
      returnDisplay: `${calls.length} outgoing call(s) found.`,
    };
  }

  private async runDocumentSymbols(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const symbols = await lspMgr.getDocumentSymbols(this.resolvedPath, signal);

    if (symbols.length === 0) {
      return {
        llmContent: 'No symbols found in this file.',
        returnDisplay: 'No symbols.',
      };
    }

    const text = formatSymbolSummary(symbols, this.resolvedPath);
    return {
      llmContent: text,
      returnDisplay: `${symbols.length} symbol(s) found.`,
    };
  }

  private async filterIgnoredSymbols(
    symbols: SymbolInformation[],
  ): Promise<SymbolInformation[]> {
    if (symbols.length === 0) return symbols;
    const gitRoot = findGitRoot(this.config.getTargetDir());
    if (!gitRoot) return symbols;

    const uniquePaths = new Set<string>();
    for (const sym of symbols) {
      try {
        uniquePaths.add(fileURLToPath(sym.location.uri));
      } catch {
        // Ignore invalid URIs
      }
    }

    const ignored = await getGitIgnoredPaths(Array.from(uniquePaths), gitRoot);
    if (ignored.size === 0) return symbols;

    return symbols.filter((sym) => {
      try {
        const filePath = fileURLToPath(sym.location.uri);
        return !ignored.has(filePath);
      } catch {
        return true;
      }
    });
  }

  private async runWorkspaceSymbols(signal: AbortSignal): Promise<ToolResult> {
    const lspMgr = (await this.config.getLspManager())!;
    const query = this.params.query ?? '';
    const rawSymbols = await lspMgr.getWorkspaceSymbols(
      query,
      this.resolvedPath,
      signal,
    );

    const symbols = await this.filterIgnoredSymbols(rawSymbols);

    if (symbols.length === 0) {
      return {
        llmContent: `No workspace symbols found matching "${query}".`,
        returnDisplay: 'No symbols found.',
      };
    }

    const lines = symbols.slice(0, 50).map((s) => {
      const loc = uriToRelativePath(s.location.uri);
      const line = s.location.range.start.line + 1;
      const container = s.containerName ? ` (in ${s.containerName})` : '';
      return `${s.name}${container} — ${loc}:${line}`;
    });

    const truncated =
      symbols.length > 50 ? `\n(${symbols.length - 50} more omitted)` : '';
    const text = `Found ${symbols.length} symbol(s) matching "${query}":\n\n${lines.join('\n')}${truncated}`;

    return {
      llmContent: text,
      returnDisplay: `${symbols.length} symbol(s) found.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatHoverContent(hover: Hover): string {
  const contents = hover.contents;
  if (typeof contents === 'string') return contents;
  return contents.value;
}

function formatLocations(locations: Location[], label: string): string {
  const lines = locations.slice(0, 50).map((loc) => {
    const file = uriToRelativePath(loc.uri);
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    return `${file}:${line}:${col}`;
  });

  const truncated =
    locations.length > 50 ? `\n(${locations.length - 50} more omitted)` : '';
  return `${label} (${locations.length} location(s)):\n\n${lines.join('\n')}${truncated}`;
}

function uriToRelativePath(uri: string): string {
  try {
    const filePath = new URL(uri).pathname;
    // Remove leading slash on Windows (e.g., /C:/...)
    const normalized =
      process.platform === 'win32' && filePath.startsWith('/')
        ? filePath.substring(1)
        : filePath;
    return decodeURIComponent(normalized);
  } catch {
    return uri;
  }
}

function formatCallHierarchyItems(items: CallHierarchyItem[]): string {
  const lines = items.slice(0, 50).map((item) => {
    const file = uriToRelativePath(item.uri);
    const line = item.range.start.line + 1;
    const col = item.range.start.character + 1;
    return `${item.name} (${file}:${line}:${col})`;
  });

  const truncated =
    items.length > 50 ? `\n(${items.length - 50} more omitted)` : '';
  return `Call Hierarchy (${items.length} item(s)):\n\n${lines.join('\n')}${truncated}`;
}

function formatIncomingCalls(calls: CallHierarchyIncomingCall[]): string {
  const lines = calls.slice(0, 50).map((call) => {
    const item = call.from;
    const file = uriToRelativePath(item.uri);
    const line = item.range.start.line + 1;
    const col = item.range.start.character + 1;
    return `from ${item.name} (${file}:${line}:${col})`;
  });

  const truncated =
    calls.length > 50 ? `\n(${calls.length - 50} more omitted)` : '';
  return `Incoming Calls (${calls.length} call(s)):\n\n${lines.join('\n')}${truncated}`;
}

function formatOutgoingCalls(calls: CallHierarchyOutgoingCall[]): string {
  const lines = calls.slice(0, 50).map((call) => {
    const item = call.to;
    const file = uriToRelativePath(item.uri);
    const line = item.range.start.line + 1;
    const col = item.range.start.character + 1;
    return `to ${item.name} (${file}:${line}:${col})`;
  });

  const truncated =
    calls.length > 50 ? `\n(${calls.length - 50} more omitted)` : '';
  return `Outgoing Calls (${calls.length} call(s)):\n\n${lines.join('\n')}${truncated}`;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

const POSITION_OPERATIONS = new Set([
  'hover',
  'definition',
  'implementation',
  'references',
  'prepare_call_hierarchy',
  'incoming_calls',
  'outgoing_calls',
]);

export class LspQueryTool extends BaseDeclarativeTool<
  LspQueryParams,
  ToolResult
> {
  static readonly Name = LSP_QUERY_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      LspQueryTool.Name,
      'LSP Query',
      LSP_QUERY_DEFINITION.base.description!,
      Kind.Search,
      LSP_QUERY_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true, // canUpdateOutput
      false, // isHidden
    );
  }

  protected override validateToolParamValues(
    params: LspQueryParams,
  ): string | null {
    if (!params.operation) {
      return 'Missing required parameter: operation';
    }
    if (!params.file_path) {
      return 'Missing required parameter: file_path';
    }

    if (POSITION_OPERATIONS.has(params.operation)) {
      if (params.line === undefined) {
        const ideContext = ideContextStore.get();
        const activeFile = ideContext?.workspaceState?.openFiles?.find(
          (f) => f.isActive,
        );
        const resolvedPath = path.resolve(
          this.config.getTargetDir(),
          params.file_path,
        );
        const isActiveFile =
          activeFile && path.resolve(activeFile.path) === resolvedPath;

        if (!isActiveFile || !activeFile.cursor) {
          return `Operation "${params.operation}" requires a line parameter. (No active IDE cursor found for this file to fallback to).`;
        }
      }
    }

    if (
      params.operation === 'workspace_symbols' &&
      (!params.query || params.query.trim() === '')
    ) {
      return 'Operation "workspace_symbols" requires a non-empty query parameter.';
    }

    const resolvedPath = path.resolve(
      this.config.getTargetDir(),
      params.file_path,
    );
    const validationError = this.config.validatePathAccess(resolvedPath);
    if (validationError) {
      return validationError;
    }

    return null;
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(LSP_QUERY_DEFINITION, modelId);
  }

  protected override createInvocation(
    params: LspQueryParams,
    messageBus: MessageBus,
  ): LspQueryInvocation {
    return new LspQueryInvocation(this.config, params, messageBus);
  }
}
