/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ReadFileTool } from './read-file.js';
import { GrepTool } from './grep.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';
import type { Config } from '../config/config.js';
import os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('LSP Steering and Fallback Integration', () => {
  const bus = createMockMessageBus();
  let tempRootDir: string;
  let mockConfig: Record<string, unknown>;
  let mockLspManager: Record<string, unknown>;

  beforeEach(() => {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-steering-test-'));

    mockLspManager = {
      hasServerFor: vi.fn().mockReturnValue(true),
      getDiagnostics: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], timedOut: false }),
      getDocumentSymbols: vi.fn().mockResolvedValue([]),
    };

    mockConfig = {
      isLspEnabled: vi.fn().mockReturnValue(true),
      getLspManager: vi.fn().mockResolvedValue(mockLspManager),
      getTargetDir: () => tempRootDir,
      validatePathAccess: vi.fn().mockReturnValue(null),
      getFileFilteringOptions: () => ({}),
      getFileExclusions: () => ({
        getGlobExcludes: () => [],
      }),
      getFileSystemService: () => undefined,
      getSessionId: () => 'test-session',
      getUsageStatisticsEnabled: () => false,
      getWorkspaceContext: () => ({
        getDirectories: () => [tempRootDir],
      }),
    };
  });

  afterEach(() => {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
  });

  describe('read_file fallback', () => {
    it('should include LSP data when LSP is enabled and working', async () => {
      const testFile = path.join(tempRootDir, 'test.ts');
      fs.writeFileSync(testFile, 'const x = 1;');

      mockLspManager.getDiagnostics.mockResolvedValue({
        diagnostics: [
          {
            message: 'Typo',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            severity: 1,
          },
        ],
        timedOut: false,
      });
      mockLspManager.getDocumentSymbols.mockResolvedValue([
        {
          name: 'x',
          kind: 13,
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 7 },
          },
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 7 },
          },
        },
      ]);

      const tool = new ReadFileTool(mockConfig as unknown as Config, bus);
      const invocation = tool.build({ file_path: 'test.ts' });
      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });

      expect(result.llmContent).toContain('const x = 1;');
      expect(result.llmContent).toContain('<lsp_symbols');
      expect(result.llmContent).toContain('<lsp_diagnostics');
      expect(result.displayFooter?.text).toContain('LSP: Typo');
    });

    it('should fall back to plain file content if LSP manager is missing', async () => {
      const testFile = path.join(tempRootDir, 'test.ts');
      fs.writeFileSync(testFile, 'const x = 1;');

      mockConfig.getLspManager.mockResolvedValue(undefined);

      const tool = new ReadFileTool(mockConfig as unknown as Config, bus);
      const invocation = tool.build({ file_path: 'test.ts' });
      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });

      expect(result.llmContent).toBe('const x = 1;');
      expect(result.llmContent).not.toContain('<lsp_');
      expect(result.displayFooter).toBeUndefined();
    });

    it('should fall back to plain file content if LSP call throws', async () => {
      const testFile = path.join(tempRootDir, 'test.ts');
      fs.writeFileSync(testFile, 'const x = 1;');

      mockLspManager.getDiagnostics.mockRejectedValue(new Error('LSP Crash'));

      const tool = new ReadFileTool(mockConfig as unknown as Config, bus);
      const invocation = tool.build({ file_path: 'test.ts' });
      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });

      expect(result.llmContent).toBe('const x = 1;');
      expect(result.llmContent).not.toContain('<lsp_');
      expect(result.displayFooter).toBeUndefined();
    });
  });

  describe('grep fallback', () => {
    it('should work normally regardless of LSP state (as it does not enrich)', async () => {
      const testFile = path.join(tempRootDir, 'test.ts');
      fs.writeFileSync(testFile, 'const target = 1;');

      const tool = new GrepTool(mockConfig as unknown as Config, bus);
      const invocation = tool.build({ pattern: 'target' });
      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });

      expect(result.llmContent).toContain('const target = 1;');
    });
  });
});
