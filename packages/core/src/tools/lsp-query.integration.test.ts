/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LspQueryTool } from './lsp-query.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';
import type { Config } from '../config/config.js';
import os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

describe('LspQueryTool Integration', () => {
  const bus = createMockMessageBus();
  let tempRootDir: string;
  let mockConfig: Record<string, unknown>;
  let mockLspManager: Record<string, unknown>;

  beforeEach(() => {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-query-test-'));

    mockLspManager = {
      hasServerFor: vi.fn().mockReturnValue(true),
      getHover: vi.fn(),
      getDefinition: vi.fn(),
      getImplementation: vi.fn(),
      getReferences: vi.fn(),
      getDocumentSymbols: vi.fn(),
      getWorkspaceSymbols: vi.fn(),
      prepareCallHierarchy: vi.fn(),
      getIncomingCalls: vi.fn(),
      getOutgoingCalls: vi.fn(),
      getDiagnostics: vi.fn(),
    };

    mockConfig = {
      isLspEnabled: vi.fn().mockReturnValue(true),
      getLspManager: vi.fn().mockResolvedValue(mockLspManager),
      getTargetDir: () => tempRootDir,
      validatePathAccess: vi.fn().mockReturnValue(null),
    };

    // Reset env
    delete process.env['ENABLE_LSP_TOOLS'];
  });

  afterEach(() => {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    delete process.env['ENABLE_LSP_TOOLS'];
  });

  it('should support the new advanced operations', async () => {
    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);
    const testFile = path.join(tempRootDir, 'test.ts');
    fs.writeFileSync(testFile, 'class A {}');

    // Test Implementation
    mockLspManager.getImplementation.mockResolvedValue([
      {
        uri: `file://${testFile}`,
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 7 },
        },
      },
    ]);
    const implInvocation = tool.build({
      operation: 'implementation',
      file_path: 'test.ts',
      line: 1,
      character: 7,
    });
    const implResult = await implInvocation.execute({
      abortSignal: new AbortController().signal,
    });
    expect(implResult.llmContent).toContain('Implementation (1 location(s))');
    expect(implResult.llmContent).toContain('test.ts:1:7');

    // Test Call Hierarchy
    const mockItem = {
      name: 'myFunc',
      uri: `file://${testFile}`,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    };
    mockLspManager.prepareCallHierarchy.mockResolvedValue([mockItem]);
    mockLspManager.getIncomingCalls.mockResolvedValue([
      { from: mockItem, fromRanges: [] },
    ]);

    const incomingInvocation = tool.build({
      operation: 'incoming_calls',
      file_path: 'test.ts',
      line: 1,
      character: 1,
    });
    const incomingResult = await incomingInvocation.execute({
      abortSignal: new AbortController().signal,
    });
    expect(incomingResult.llmContent).toContain('Incoming Calls (1 call(s))');
    expect(incomingResult.llmContent).toContain('from myFunc');
  });

  it('should respect Git-ignore filtering to reduce noise', async () => {
    // Setup a real git repo in temp dir
    execSync('git init', { cwd: tempRootDir });
    fs.writeFileSync(path.join(tempRootDir, '.gitignore'), 'node_modules/');
    fs.mkdirSync(path.join(tempRootDir, 'node_modules'));
    const ignoredFile = path.join(tempRootDir, 'node_modules', 'lib.ts');
    fs.writeFileSync(ignoredFile, 'export const x = 1;');
    const sourceFile = path.join(tempRootDir, 'src.ts');
    fs.writeFileSync(sourceFile, 'import {x} from "./node_modules/lib";');

    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);

    // Mock workspace symbols returning both a source file and an ignored file
    mockLspManager.getWorkspaceSymbols.mockResolvedValue([
      {
        name: 'x',
        location: {
          uri: `file://${sourceFile}`,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
      },
      {
        name: 'x',
        location: {
          uri: `file://${ignoredFile}`,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
      },
    ]);

    const invocation = tool.build({
      operation: 'workspace_symbols',
      query: 'x',
      file_path: 'src.ts',
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });

    // Should only contain 1 symbol because the other is ignored
    expect(result.llmContent).toContain('Found 1 symbol(s)');
    expect(result.llmContent).toContain('src.ts:1');
    expect(result.llmContent).not.toContain('node_modules');
  });

  it('should be toggled by ENABLE_LSP_TOOLS environment variable', async () => {
    // We mock config.getLspManager to return undefined when disabled
    mockConfig.getLspManager.mockResolvedValue(undefined);

    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);
    const invocation = tool.build({
      operation: 'hover',
      file_path: 'test.ts',
      line: 1,
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });

    expect(result.llmContent).toContain('LSP is not enabled');
    expect(result.returnDisplay).toBe('LSP not enabled.');
  });

  it('should fail gracefully when no server is configured for the file type', async () => {
    mockLspManager.hasServerFor.mockReturnValue(false);
    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);
    const invocation = tool.build({
      operation: 'hover',
      file_path: 'unsupported.txt',
      line: 1,
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });

    expect(result.llmContent).toContain('No language server is configured');
    expect(result.returnDisplay).toBe('No LSP server for this file type.');
  });

  it('should handle empty results from LSP server', async () => {
    mockLspManager.getDefinition.mockResolvedValue([]);
    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);
    const invocation = tool.build({
      operation: 'definition',
      file_path: 'test.ts',
      line: 1,
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });

    expect(result.llmContent).toBe('No definition found at this position.');
    expect(result.returnDisplay).toBe('No definition found.');
  });

  it('should handle LSP server timeouts', async () => {
    const { LspTimeoutError } = await import('../lsp/client.js');
    mockLspManager.getHover.mockRejectedValue(
      new LspTimeoutError('Timeout', 5000),
    );

    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);
    const invocation = tool.build({
      operation: 'hover',
      file_path: 'test.ts',
      line: 1,
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });

    expect(result.llmContent).toContain('LSP server timed out');
    expect(result.returnDisplay).toBe('LSP timed out.');
  });

  it('should handle generic LSP server errors', async () => {
    mockLspManager.getHover.mockRejectedValue(
      new Error('Internal Server Error'),
    );

    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);
    const invocation = tool.build({
      operation: 'hover',
      file_path: 'test.ts',
      line: 1,
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });

    expect(result.llmContent).toContain(
      'LSP query failed: Internal Server Error',
    );
    expect(result.returnDisplay).toBe('LSP error: Internal Server Error');
  });

  it('should provide hover information correctly', async () => {
    mockLspManager.getHover.mockResolvedValue({
      contents: {
        kind: 'markdown',
        value: '```typescript\nfunction test(): void\n```',
      },
    });

    const tool = new LspQueryTool(mockConfig as unknown as Config, bus);
    const invocation = tool.build({
      operation: 'hover',
      file_path: 'test.ts',
      line: 1,
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });

    expect(result.llmContent).toContain('function test()');
    expect(result.returnDisplay).toBe('Hover info retrieved.');
  });
});
