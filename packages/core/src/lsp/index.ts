/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export { LspManager, type LspServerStatus } from './manager.js';
export { LspTimeoutError } from './client.js';
export { LspServerRegistry } from './server-registry.js';
export {
  collectDiagnosticsForOutput,
  formatDiagnostics,
  appendLspDiagnostics,
  formatSymbolSummary,
  buildLspSummary,
  enrichToolResultWithLsp,
  enrichReadWithLsp,
  enrichReadManyWithLsp,
  DEFAULT_READ_MANY_FILES_LSP_BUDGET,
} from './enrichment.js';
export type {
  CollectedDiagnostics,
  LspEnrichmentResult,
  LspBatchEnrichmentResult,
} from './enrichment.js';
export type {
  LspSettings,
  LspServerUserConfig,
  LspServerDefinition,
  Diagnostic,
  DocumentSymbol,
  SymbolInformation,
  Hover,
  Location,
  Position,
  Range,
} from './types.js';
export { DiagnosticSeverity, DEFAULT_LSP_SETTINGS } from './types.js';
