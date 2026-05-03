/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { ContextWindowDisplay } from './ContextWindowDisplay.js';
import type { ContextWindowData } from '../types.js';

// Base fixture with no memory files, no MCP, no CM diagnostics — low usage.
// totalTokensSource defaults to 'api' (confirmed total). Individual tests
// override for the estimated-only and divergent cases.
const baseData: ContextWindowData = {
  model: 'gemini-3-pro-preview',
  tokenLimit: 1_000_000,
  totalTokens: 120_000,
  totalTokensSource: 'api',
  systemPromptTokens: 8_000,
  memoryTokens: 12_000,
  memoryFileCount: 0,
  memoryBreakdown: null,
  memoryFiles: [],
  mcpInstructions: [],
  mcpInstructionTokens: 0,
  toolDeclarationTokens: 20_000,
  toolCount: 14,
  conversationTokens: {
    heuristic: 80_000,
    residual: 80_000,
    materiallyDivergent: false,
  },
  turnCount: 6,
  compressionThreshold: 0.85,
  estimatedTurnsRemaining: 28,
  contextManagementEnabled: false,
  contextManagerActive: false,
  cmRetainedTokenBudget: null,
  cmProfileName: null,
  topConsumers: null,
  nodeTypeBreakdown: null,
  lastCompression: null,
};

describe('<ContextWindowDisplay />', () => {
  describe('Visual regression', () => {
    it('renders API-confirmed CM-off case with turns estimate', async () => {
      const renderResult = await renderWithProviders(
        <ContextWindowDisplay data={baseData} />,
      );
      const output = renderResult.lastFrame();
      expect(output).toContain('Context');
      expect(output).toContain('880k tokens remaining');
      expect(output).toContain('compress at 85%');
      expect(output).toContain('28 turns at current rate');
      expect(output).toContain('· API');
      await expect(renderResult).toMatchSvgSnapshot();
    });

    it('renders estimate-only CM-off case (no API count, turns suppressed)', async () => {
      const renderResult = await renderWithProviders(
        <ContextWindowDisplay
          data={{
            ...baseData,
            totalTokensSource: 'estimated',
            conversationTokens: {
              heuristic: 80_000,
              residual: null,
              materiallyDivergent: false,
            },
            estimatedTurnsRemaining: null,
          }}
        />,
      );
      const output = renderResult.lastFrame();
      expect(output).toContain('880k tokens remaining');
      expect(output).not.toContain('turns at current rate');
      expect(output).toContain('· est');
      await expect(renderResult).toMatchSvgSnapshot();
    });

    it('renders materially-divergent conversation row (PDF over-count case)', async () => {
      // Simulates the live debug session: API reports 79k total, but the
      // heuristic estimator over-counts PDFs to 834k. The conversation row
      // shows both the API-attributed residual (primary) and the heuristic
      // (parenthetical "est"), so the user can see where the gap lives.
      const renderResult = await renderWithProviders(
        <ContextWindowDisplay
          data={{
            ...baseData,
            totalTokens: 79_000,
            totalTokensSource: 'api',
            systemPromptTokens: 1_790,
            memoryTokens: 6_964,
            memoryFileCount: 3,
            toolDeclarationTokens: 20_126,
            toolCount: 76,
            conversationTokens: {
              heuristic: 834_160,
              residual: 50_120,
              materiallyDivergent: true,
            },
            turnCount: 159,
            estimatedTurnsRemaining: 1322,
          }}
        />,
      );
      const output = renderResult.lastFrame();
      // Headline reflects the API count, not the heuristic.
      expect(output).toContain('921k tokens remaining');
      expect(output).toContain('· API');
      // Conversation row shows both numbers due to material divergence.
      expect(output).toContain('50,120');
      expect(output).toContain('834k est');
      await expect(renderResult).toMatchSvgSnapshot();
    });

    it('renders near-threshold CM-off case (warning color on headline)', async () => {
      const renderResult = await renderWithProviders(
        <ContextWindowDisplay
          data={{
            ...baseData,
            totalTokens: 800_000,
            conversationTokens: {
              heuristic: 760_000,
              residual: 760_000,
              materiallyDivergent: false,
            },
            turnCount: 42,
            estimatedTurnsRemaining: 3,
          }}
        />,
      );
      const output = renderResult.lastFrame();
      expect(output).toContain('200k tokens remaining');
      expect(output).toContain('compress at 85%');
      await expect(renderResult).toMatchSvgSnapshot();
    });

    it('renders CM-on case with profile name and retain marker', async () => {
      const renderResult = await renderWithProviders(
        <ContextWindowDisplay
          data={{
            ...baseData,
            totalTokens: 250_000,
            conversationTokens: {
              heuristic: 210_000,
              residual: 210_000,
              materiallyDivergent: false,
            },
            contextManagementEnabled: true,
            contextManagerActive: true,
            cmRetainedTokenBudget: 500_000,
            cmProfileName: 'Generalist (Default)',
            estimatedTurnsRemaining: null,
          }}
        />,
      );
      const output = renderResult.lastFrame();
      expect(output).toContain('retain 50%');
      expect(output).not.toContain('turns at current rate');
      expect(output).toContain('ContextManager: Generalist (Default)');
      await expect(renderResult).toMatchSvgSnapshot();
    });

    it('renders CM-on case with all diagnostics (top consumers, breakdown, last compression)', async () => {
      const renderResult = await renderWithProviders(
        <ContextWindowDisplay
          data={{
            ...baseData,
            totalTokens: 248_500,
            conversationTokens: {
              heuristic: 210_000,
              residual: 208_374,
              materiallyDivergent: false,
            },
            contextManagementEnabled: true,
            contextManagerActive: true,
            cmRetainedTokenBudget: 500_000,
            cmProfileName: 'Generalist (Default)',
            estimatedTurnsRemaining: null,
            topConsumers: [
              {
                nodeType: 'TOOL_EXECUTION',
                label: 'read_many_files',
                tokens: 45_000,
                ageTurns: 1,
              },
              {
                nodeType: 'USER_PROMPT',
                label: 'Refactor the authentication flow…',
                tokens: 8_200,
                ageTurns: 0,
              },
              {
                nodeType: 'ROLLING_SUMMARY',
                label: 'Earlier discussion about config schema',
                tokens: 6_500,
                ageTurns: 4,
              },
            ],
            nodeTypeBreakdown: [
              { nodeType: 'TOOL_EXECUTION', count: 12, tokens: 120_000 },
              { nodeType: 'USER_PROMPT', count: 7, tokens: 14_500 },
              { nodeType: 'AGENT_YIELD', count: 6, tokens: 28_000 },
              { nodeType: 'ROLLING_SUMMARY', count: 2, tokens: 13_000 },
            ],
            lastCompression: {
              processorId: 'rolling-summary',
              secondsAgo: 47,
              turnsAgo: 3,
              removedCount: 8,
              addedCount: 1,
              tokensSaved: 32_400,
            },
          }}
        />,
      );
      const output = renderResult.lastFrame();
      expect(output).toContain('Top consumers');
      expect(output).toContain('Conversation breakdown');
      expect(output).toContain('Last compression');
      expect(output).toContain('read_many_files');
      expect(output).toContain('saved 32k tok');
      await expect(renderResult).toMatchSvgSnapshot();
    });

    it('renders per-file memory breakdown and MCP instructions', async () => {
      const renderResult = await renderWithProviders(
        <ContextWindowDisplay
          data={{
            ...baseData,
            memoryTokens: 18_500,
            memoryFileCount: 3,
            memoryBreakdown: {
              global: 4_000,
              project: 9_500,
              extension: 0,
              userProject: 5_000,
            },
            memoryFiles: [
              {
                path: '/home/user/.gemini/GEMINI.md',
                tokens: 4_000,
                category: 'global',
              },
              {
                path: '/work/project/GEMINI.md',
                tokens: 9_500,
                category: 'project',
              },
              {
                path: '/work/project/.gemini/GEMINI.md',
                tokens: 5_000,
                category: 'userProject',
              },
            ],
            mcpInstructions: [
              { serverName: 'filesystem', tokens: 1_200 },
              { serverName: 'github', tokens: 2_400 },
            ],
            mcpInstructionTokens: 3_600,
          }}
        />,
      );
      const output = renderResult.lastFrame();
      expect(output).toContain('3 files');
      expect(output).toContain('GEMINI.md');
      expect(output).toContain('filesystem');
      expect(output).toContain('github');
      await expect(renderResult).toMatchSvgSnapshot();
    });
  });
});
