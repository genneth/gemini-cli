/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Diagnostic, DocumentSymbol, SymbolInformation } from './types.js';
import { DiagnosticSeverity, SymbolKind } from './types.js';
import type { LspManager } from './manager.js';
import type { Config } from '../config/config.js';

const MAX_DIAGNOSTICS = 20;
const MAX_SYMBOLS = 50;

const SEVERITY_LABELS: Record<number, string> = {
  [DiagnosticSeverity.Error]: 'ERROR',
  [DiagnosticSeverity.Warning]: 'WARN',
  [DiagnosticSeverity.Information]: 'INFO',
  [DiagnosticSeverity.Hint]: 'HINT',
};

/**
 * Result from collecting diagnostics, including whether we timed out.
 */
export interface CollectedDiagnostics {
  /** Formatted XML string for llmContent (empty if no diagnostics). */
  llmOutput: string;
  /** Whether the server timed out before responding. */
  timedOut: boolean;
  /** Whether LSP was applicable for this file type at all. */
  applicable: boolean;
  /** The raw diagnostics returned by the server. */
  diagnostics: Diagnostic[];
}

/**
 * Collect LSP diagnostics for a file and format them for inclusion in tool
 * output. All severity levels are included — the agent benefits from seeing
 * warnings and hints, not just errors.
 */
export async function collectDiagnosticsForOutput(
  lspManager: LspManager,
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<CollectedDiagnostics> {
  if (!lspManager.hasServerFor(filePath)) {
    return {
      llmOutput: '',
      timedOut: false,
      applicable: false,
      diagnostics: [],
    };
  }

  const result = await lspManager.getDiagnostics(filePath, content, signal);

  if (result.diagnostics.length === 0) {
    return {
      llmOutput: '',
      timedOut: result.timedOut,
      applicable: true,
      diagnostics: [],
    };
  }

  return {
    llmOutput: formatDiagnostics(result.diagnostics, filePath),
    timedOut: false,
    applicable: true,
    diagnostics: result.diagnostics,
  };
}

/**
 * Format a list of diagnostics into the XML-tagged output format.
 * All severity levels are included.
 */
export function formatDiagnostics(
  diagnostics: Diagnostic[],
  filePath: string,
): string {
  if (diagnostics.length === 0) return '';

  // Sort by severity (errors first), then by line number.
  const sorted = [...diagnostics].sort((a, b) => {
    const sevDiff =
      (a.severity ?? DiagnosticSeverity.Error) -
      (b.severity ?? DiagnosticSeverity.Error);
    if (sevDiff !== 0) return sevDiff;
    return a.range.start.line - b.range.start.line;
  });

  const truncated = sorted.length > MAX_DIAGNOSTICS;
  const shown = truncated ? sorted.slice(0, MAX_DIAGNOSTICS) : sorted;

  const fileName = path.basename(filePath);
  const lines = shown.map((d) => {
    const sev =
      SEVERITY_LABELS[d.severity ?? DiagnosticSeverity.Error] ?? 'ERROR';
    // LSP lines are 0-based; display as 1-based.
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    return `${sev.padEnd(5)} line ${line}:${col}: ${d.message}`;
  });

  let body = `Compiler feedback for ${fileName}:\n\n${lines.join('\n')}`;
  if (truncated) {
    body += `\n\n(${sorted.length - MAX_DIAGNOSTICS} more diagnostics omitted)`;
  }

  return `\n\n<lsp_diagnostics file="${filePath}">\n${body}\n</lsp_diagnostics>`;
}

/**
 * Append LSP diagnostic output to existing llmContent.
 */
export function appendLspDiagnostics(
  llmContent: string,
  lspOutput: string,
): string {
  if (!lspOutput) return llmContent;
  return `${llmContent}${lspOutput}`;
}

// Severity glyphs prefixed to the LSP summary text. Severity is encoded in
// the words themselves and in these glyphs — upstream's `resultSummary` slot
// is plain text with a single theme color, so we can't rely on coloured
// severity. The glyphs let a human spot state at a glance:
//   ✗  errors present
//   ⚠  warnings only, or timed out (LSP couldn't verify)
//   ✓  clean
const GLYPH_ERROR = '✗';
const GLYPH_WARNING = '⚠';
const GLYPH_CLEAN = '✓';

/**
 * Build the one-line LSP summary appended to the tool's resultSummary.
 *
 * Philosophy: the summary is a one-liner the human glances at. For issues
 * we surface the FIRST diagnostic (most actionable) plus a "+N more"
 * suffix; the model still sees the full list in llmContent. Severity is
 * encoded in the leading glyph + the words themselves.
 */
export function buildLspSummary(
  diagnostics: Diagnostic[],
  timedOut: boolean,
): string | null {
  if (timedOut && diagnostics.length === 0) {
    return `LSP: ${GLYPH_WARNING} timed out`;
  }

  if (diagnostics.length === 0) {
    return `LSP: ${GLYPH_CLEAN} clean`;
  }

  // Pick the most actionable diagnostic: highest severity (= lowest numeric),
  // tiebroken by earliest line.
  const sorted = [...diagnostics].sort((a, b) => {
    const sevDiff =
      (a.severity ?? DiagnosticSeverity.Error) -
      (b.severity ?? DiagnosticSeverity.Error);
    if (sevDiff !== 0) return sevDiff;
    return a.range.start.line - b.range.start.line;
  });

  const first = sorted[0];
  const firstMessage = first.message.split('\n')[0].trim();
  const firstLine = first.range.start.line + 1;
  const remaining = diagnostics.length - 1;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : '';

  const hasErrors = diagnostics.some(
    (d) =>
      (d.severity ?? DiagnosticSeverity.Error) === DiagnosticSeverity.Error,
  );
  const glyph = hasErrors ? GLYPH_ERROR : GLYPH_WARNING;

  return `LSP: ${glyph} ${firstMessage} (line ${firstLine})${suffix}`;
}

/** Result of enriching a tool output with LSP data. */
export interface LspEnrichmentResult {
  /** The tool's llmContent with XML-tagged LSP sections appended (if any). */
  enrichedLlmContent: string;
  /** Short text appended to the tool's resultSummary (null = no summary). */
  lspSummary: string | null;
}

/**
 * Enrich a write/edit tool result with LSP diagnostics.
 *
 * Appends `<lsp_diagnostics>` blocks to llmContent for the model and returns a
 * status footer for the user. No-ops silently (returning the original
 * llmContent and no footer) when LSP is disabled, no server covers the file,
 * or the LSP call throws. LSP is supplementary — tool calls never fail
 * because of it.
 */
export async function enrichToolResultWithLsp(
  config: Config,
  filePath: string,
  fileContent: string,
  llmContent: string,
  signal?: AbortSignal,
): Promise<LspEnrichmentResult> {
  if (!config.isLspEnabled?.()) {
    return { enrichedLlmContent: llmContent, lspSummary: null };
  }

  try {
    const lspMgr = await config.getLspManager();
    if (!lspMgr) return { enrichedLlmContent: llmContent, lspSummary: null };

    const collected = await collectDiagnosticsForOutput(
      lspMgr,
      filePath,
      fileContent,
      signal,
    );

    if (!collected.applicable) {
      return { enrichedLlmContent: llmContent, lspSummary: null };
    }

    return {
      enrichedLlmContent: appendLspDiagnostics(llmContent, collected.llmOutput),
      lspSummary: buildLspSummary(collected.diagnostics, collected.timedOut),
    };
  } catch {
    return { enrichedLlmContent: llmContent, lspSummary: null };
  }
}

/** Result of batch-enriching a read_many_files tool output. */
export interface LspBatchEnrichmentResult {
  /** XML-tagged symbol + diagnostic blocks appended per file. */
  llmAppendix: string;
  /** Aggregated summary across all enriched files (null = no summary). */
  lspSummary: string | null;
}

/** Default per-invocation cap on how many files read_many_files enriches. */
export const DEFAULT_READ_MANY_FILES_LSP_BUDGET = 10;

/**
 * Enrich a read_many_files tool result with LSP data. For each file the
 * server covers (up to `budget`), append symbol index + diagnostic blocks
 * to llmAppendix and tally counts into an aggregated footer. Files past
 * the budget are marked with an `<lsp_truncated>` sentinel so the model
 * knows absence-of-issues is not clean-by-absence.
 *
 * Files without a configured language server are excluded from both the
 * budget and the footer — LSP can't say anything about them.
 */
export async function enrichReadManyWithLsp(
  config: Config,
  filePaths: string[],
  signal?: AbortSignal,
  budget: number = DEFAULT_READ_MANY_FILES_LSP_BUDGET,
): Promise<LspBatchEnrichmentResult> {
  if (!config.isLspEnabled?.()) {
    return { llmAppendix: '', lspSummary: null };
  }

  try {
    const lspMgr = await config.getLspManager();
    if (!lspMgr) return { llmAppendix: '', lspSummary: null };

    const coveredFiles = filePaths.filter((f) => lspMgr.hasServerFor(f));
    if (coveredFiles.length === 0) {
      return { llmAppendix: '', lspSummary: null };
    }

    const toEnrich = coveredFiles.slice(0, budget);
    const skippedCount = coveredFiles.length - toEnrich.length;

    const perFileResults = await Promise.all(
      toEnrich.map(async (filePath) => {
        try {
          const fullContent = await fs.readFile(filePath, 'utf-8');
          const diagResult = await lspMgr.getDiagnostics(
            filePath,
            fullContent,
            signal,
          );
          const symbols = await lspMgr.getDocumentSymbols(filePath);
          return {
            filePath,
            diagnostics: diagResult.diagnostics,
            timedOut: diagResult.timedOut,
            symbols,
          };
        } catch {
          return {
            filePath,
            diagnostics: [] as Diagnostic[],
            timedOut: false,
            symbols: [] as DocumentSymbol[] | SymbolInformation[],
          };
        }
      }),
    );

    let llmAppendix = '';
    let totalErrors = 0;
    let totalWarnings = 0;
    let totalInfos = 0;
    let timeoutCount = 0;
    const filesWithIssues = new Set<string>();

    for (const r of perFileResults) {
      if (r.symbols.length > 0) {
        llmAppendix += formatSymbolSummary(r.symbols, r.filePath);
      }
      if (r.diagnostics.length > 0) {
        llmAppendix += formatDiagnostics(r.diagnostics, r.filePath);
        filesWithIssues.add(r.filePath);
      }
      for (const d of r.diagnostics) {
        const sev = d.severity ?? DiagnosticSeverity.Error;
        if (sev === DiagnosticSeverity.Error) totalErrors++;
        else if (sev === DiagnosticSeverity.Warning) totalWarnings++;
        else totalInfos++;
      }
      if (r.timedOut && r.diagnostics.length === 0) timeoutCount++;
    }

    if (skippedCount > 0) {
      llmAppendix += `\n\n<lsp_truncated reason="budget" count="${skippedCount}"/>`;
    }

    return {
      llmAppendix,
      lspSummary: buildBatchSummary({
        totalErrors,
        totalWarnings,
        totalInfos,
        timeoutCount,
        filesWithIssuesCount: filesWithIssues.size,
      }),
    };
  } catch {
    return { llmAppendix: '', lspSummary: null };
  }
}

function buildBatchSummary(stats: {
  totalErrors: number;
  totalWarnings: number;
  totalInfos: number;
  timeoutCount: number;
  filesWithIssuesCount: number;
}): string | null {
  const { totalErrors, totalWarnings, totalInfos, timeoutCount } = stats;
  const diagParts: string[] = [];
  if (totalErrors > 0)
    diagParts.push(`${totalErrors} error${totalErrors !== 1 ? 's' : ''}`);
  if (totalWarnings > 0)
    diagParts.push(`${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''}`);
  if (totalInfos > 0) diagParts.push(`${totalInfos} info`);

  if (diagParts.length === 0) {
    if (timeoutCount > 0) {
      return `LSP: ${GLYPH_WARNING} ${timeoutCount} server${timeoutCount !== 1 ? 's' : ''} timed out`;
    }
    return `LSP: ${GLYPH_CLEAN} no issues found`;
  }

  const filesCount = stats.filesWithIssuesCount;
  const across =
    filesCount > 0
      ? ` across ${filesCount} file${filesCount !== 1 ? 's' : ''}`
      : '';
  const timeoutSuffix =
    timeoutCount > 0
      ? `, ${timeoutCount} server${timeoutCount !== 1 ? 's' : ''} timed out`
      : '';
  const glyph = totalErrors > 0 ? GLYPH_ERROR : GLYPH_WARNING;
  return `LSP: ${glyph} ${diagParts.join(', ')}${across}${timeoutSuffix}`;
}

/**
 * Enrich a read_file tool result with LSP data: document symbols and
 * pre-existing diagnostics.
 *
 * Always sends the full on-disk file content to the LSP server, never the
 * possibly-truncated snippet a caller might pass — sending a snippet would
 * make the server believe the snippet is the whole file, producing wrong
 * diagnostics and broken symbol coordinates.
 */
export async function enrichReadWithLsp(
  config: Config,
  filePath: string,
  llmContent: string,
  signal?: AbortSignal,
): Promise<LspEnrichmentResult> {
  if (!config.isLspEnabled?.()) {
    return { enrichedLlmContent: llmContent, lspSummary: null };
  }

  try {
    const lspMgr = await config.getLspManager();
    if (!lspMgr || !lspMgr.hasServerFor(filePath)) {
      return { enrichedLlmContent: llmContent, lspSummary: null };
    }

    const fullContent = await fs.readFile(filePath, 'utf-8');
    const diagResult = await lspMgr.getDiagnostics(
      filePath,
      fullContent,
      signal,
    );

    let enriched = llmContent;

    const symbols = await lspMgr.getDocumentSymbols(filePath);
    if (symbols.length > 0) {
      enriched += formatSymbolSummary(symbols, filePath);
    }

    if (diagResult.diagnostics.length > 0) {
      enriched += formatDiagnostics(diagResult.diagnostics, filePath);
    }

    return {
      enrichedLlmContent: enriched,
      lspSummary: buildLspSummary(
        diagResult.diagnostics,
        diagResult.timedOut,
      ),
    };
  } catch {
    return { enrichedLlmContent: llmContent, lspSummary: null };
  }
}

// -----------------------------------------------------------------------
// Symbol formatting
// -----------------------------------------------------------------------

const SYMBOL_KIND_LABELS: Partial<Record<SymbolKind, string>> = {
  [SymbolKind.Class]: 'class',
  [SymbolKind.Interface]: 'interface',
  [SymbolKind.Function]: 'function',
  [SymbolKind.Method]: 'method',
  [SymbolKind.Property]: 'property',
  [SymbolKind.Field]: 'field',
  [SymbolKind.Variable]: 'variable',
  [SymbolKind.Constant]: 'constant',
  [SymbolKind.Enum]: 'enum',
  [SymbolKind.EnumMember]: 'member',
  [SymbolKind.Constructor]: 'constructor',
  [SymbolKind.Module]: 'module',
  [SymbolKind.Namespace]: 'namespace',
  [SymbolKind.TypeParameter]: 'type param',
  [SymbolKind.Struct]: 'struct',
};

/**
 * Check if a symbol array contains hierarchical DocumentSymbol objects
 * (with children) vs flat SymbolInformation objects.
 */
function isDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[],
): symbols is DocumentSymbol[] {
  return (
    symbols.length > 0 &&
    'range' in symbols[0] &&
    'selectionRange' in symbols[0]
  );
}

/**
 * Format document symbols into a condensed text summary for llmContent.
 * Shows top-level symbols + one nesting level (e.g., class methods).
 */
export function formatSymbolSummary(
  symbols: DocumentSymbol[] | SymbolInformation[],
  filePath: string,
): string {
  if (symbols.length === 0) return '';

  const fileName = path.basename(filePath);
  const lines: string[] = [];
  let count = 0;

  if (isDocumentSymbols(symbols)) {
    for (const sym of symbols) {
      if (count >= MAX_SYMBOLS) break;
      const kind = SYMBOL_KIND_LABELS[sym.kind] ?? 'symbol';
      const detail = sym.detail ? ` ${sym.detail}` : '';
      const line = sym.range.start.line + 1;
      lines.push(`${kind.padEnd(12)} ${sym.name}${detail} (line ${line})`);
      count++;

      // One nesting level: show children (methods, properties, etc.)
      if (sym.children) {
        for (const child of sym.children) {
          if (count >= MAX_SYMBOLS) break;
          const childKind = SYMBOL_KIND_LABELS[child.kind] ?? 'symbol';
          const childDetail = child.detail ? ` ${child.detail}` : '';
          lines.push(`  ${childKind.padEnd(12)} ${child.name}${childDetail}`);
          count++;
        }
      }
    }
  } else {
    // Flat SymbolInformation — no hierarchy
    for (const sym of symbols) {
      if (count >= MAX_SYMBOLS) break;
      const kind = SYMBOL_KIND_LABELS[sym.kind] ?? 'symbol';
      const line = sym.location.range.start.line + 1;
      const container = sym.containerName ? ` (in ${sym.containerName})` : '';
      lines.push(`${kind.padEnd(12)} ${sym.name}${container} (line ${line})`);
      count++;
    }
  }

  const truncated =
    count >= MAX_SYMBOLS
      ? `\n(${symbols.length - MAX_SYMBOLS} more symbols omitted)`
      : '';

  return `\n\n<lsp_symbols file="${filePath}">\nSymbol index for ${fileName}:\n\n${lines.join('\n')}${truncated}\n</lsp_symbols>`;
}
