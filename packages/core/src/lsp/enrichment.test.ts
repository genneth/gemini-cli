/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildLspSummary,
  enrichReadManyWithLsp,
  DEFAULT_READ_MANY_FILES_LSP_BUDGET,
} from './enrichment.js';
import { DiagnosticSeverity, type Diagnostic } from './types.js';
import type { Config } from '../config/config.js';

const mkDiag = (
  severity: DiagnosticSeverity,
  opts: { line?: number; message?: string } = {},
): Diagnostic => ({
  range: {
    start: { line: opts.line ?? 0, character: 0 },
    end: { line: opts.line ?? 0, character: 1 },
  },
  severity,
  message: opts.message ?? 'test',
});

describe('buildLspSummary', () => {
  it('returns "LSP: ✓ clean" for an empty diagnostic array', () => {
    expect(buildLspSummary([], false)).toBe('LSP: ✓ clean');
  });

  it('returns "LSP: ⚠ timed out" when timed out with no diagnostics', () => {
    expect(buildLspSummary([], true)).toBe('LSP: ⚠ timed out');
  });

  it('surfaces the first diagnostic message with error glyph and line', () => {
    expect(
      buildLspSummary(
        [
          mkDiag(DiagnosticSeverity.Error, {
            line: 4,
            message: "Type 'string' is not assignable to 'number'",
          }),
        ],
        false,
      ),
    ).toBe(
      "LSP: ✗ Type 'string' is not assignable to 'number' (line 5)",
    );
  });

  it('picks the highest-severity diagnostic first, tiebroken by line', () => {
    const summary = buildLspSummary(
      [
        mkDiag(DiagnosticSeverity.Warning, { line: 0, message: 'warn A' }),
        mkDiag(DiagnosticSeverity.Error, { line: 10, message: 'err later' }),
        mkDiag(DiagnosticSeverity.Error, { line: 2, message: 'err early' }),
      ],
      false,
    );
    // Two errors, one warning: error on line 3 is the earliest error.
    expect(summary).toBe('LSP: ✗ err early (line 3) (+2 more)');
  });

  it('adds a "+N more" suffix when there are additional diagnostics', () => {
    const summary = buildLspSummary(
      [
        mkDiag(DiagnosticSeverity.Error, { line: 0, message: 'first' }),
        mkDiag(DiagnosticSeverity.Error, { line: 1, message: 'second' }),
        mkDiag(DiagnosticSeverity.Error, { line: 2, message: 'third' }),
      ],
      false,
    );
    expect(summary).toBe('LSP: ✗ first (line 1) (+2 more)');
  });

  it('uses the warning glyph when only warnings/infos are present', () => {
    expect(
      buildLspSummary(
        [
          mkDiag(DiagnosticSeverity.Warning, { message: 'unused var' }),
          mkDiag(DiagnosticSeverity.Hint, { message: 'style hint' }),
        ],
        false,
      ),
    ).toBe('LSP: ⚠ unused var (line 1) (+1 more)');
  });

  it('prefers diagnostics over timed-out flag when both are set', () => {
    // If the server returned something before the timer fired, we still
    // want to surface the diagnostics, not the "timed out" message.
    expect(
      buildLspSummary(
        [mkDiag(DiagnosticSeverity.Error, { message: 'boom' })],
        true,
      ),
    ).toBe('LSP: ✗ boom (line 1)');
  });

  it('takes only the first line of a multi-line diagnostic message', () => {
    expect(
      buildLspSummary(
        [
          mkDiag(DiagnosticSeverity.Error, {
            message: "Type 'string' is not assignable\n  Details: ...",
          }),
        ],
        false,
      ),
    ).toBe("LSP: ✗ Type 'string' is not assignable (line 1)");
  });
});

describe('enrichReadManyWithLsp', () => {
  const mkDisabledConfig = (): Config =>
    ({
      isLspEnabled: () => false,
    }) as unknown as Config;

  it('returns an empty appendix when LSP is disabled', async () => {
    const result = await enrichReadManyWithLsp(mkDisabledConfig(), [
      '/a.ts',
      '/b.ts',
    ]);
    expect(result.llmAppendix).toBe('');
    expect(result.lspSummary).toBeNull();
  });

  it('returns an empty appendix when getLspManager resolves undefined', async () => {
    const config = {
      isLspEnabled: () => true,
      getLspManager: async () => undefined,
    } as unknown as Config;
    const result = await enrichReadManyWithLsp(config, ['/a.ts']);
    expect(result.llmAppendix).toBe('');
    expect(result.lspSummary).toBeNull();
  });

  it('uses the documented default budget', () => {
    // Guard against an accidental change to the exported constant. Other
    // callers (docs, tests) depend on the value.
    expect(DEFAULT_READ_MANY_FILES_LSP_BUDGET).toBe(10);
  });
});
