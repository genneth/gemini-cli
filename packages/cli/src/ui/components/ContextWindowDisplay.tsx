/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../semantic-colors.js';
import type { ContextWindowData, MemoryFileInfo } from '../types.js';

const MIN_BAR_WIDTH = 30;
const MAX_BAR_WIDTH = 80;

/** Format a token count compactly: 1,200 -> "1.2k", 48,446 -> "48k" */
function fmtCompact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.floor(n).toString();
}

/** Format a number with thousands separators. */
function fmtNum(n: number): string {
  return Math.floor(n).toLocaleString();
}

/** Shorten a file path relative to HOME or CWD for display. */
function shortenPath(filePath: string): string {
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
  const cwd = process.cwd();
  // Normalize to forward slashes for consistent comparison
  const norm = filePath.replace(/\\/g, '/');

  // Case-insensitive prefix matching (Windows returns lowercase paths)
  const cwdNorm = cwd.replace(/\\/g, '/');
  if (cwdNorm && norm.toLowerCase().startsWith(cwdNorm.toLowerCase())) {
    return './' + norm.slice(cwdNorm.length).replace(/^\//, '');
  }
  const homeNorm = home.replace(/\\/g, '/');
  if (homeNorm && norm.toLowerCase().startsWith(homeNorm.toLowerCase())) {
    return '~/' + norm.slice(homeNorm.length).replace(/^\//, '');
  }
  return norm;
}

const CATEGORY_LABELS: Record<MemoryFileInfo['category'], string> = {
  global: 'global',
  project: 'project',
  extension: 'extension',
  userProject: 'user',
};

/**
 * Color mapping for each context category.
 * Blue, purple, yellow, cyan avoid the red-green confusion axis.
 */
const categoryColors = {
  get system() {
    return theme.text.link;
  },
  get memory() {
    return theme.status.warning;
  },
  get tools() {
    return theme.text.accent;
  },
  get conversation() {
    return theme.ui.symbol;
  },
  get free() {
    return theme.ui.dark;
  },
  get marker() {
    return theme.text.primary;
  },
};

// ---------------------------------------------------------------------------
// Layout primitives matching StatsDisplay conventions
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 28;

const StatRow: React.FC<{
  label: string;
  color?: string;
  children: React.ReactNode;
}> = ({ label, color, children }) => (
  <Box>
    <Box width={LABEL_WIDTH}>
      <Text color={color ?? theme.text.link}>{label}</Text>
    </Box>
    {children}
  </Box>
);

const Section: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color={theme.text.primary}>
      {title}
    </Text>
    {children}
  </Box>
);

// ---------------------------------------------------------------------------
// Segmented bar (responsive)
// ---------------------------------------------------------------------------

const SegmentedBar: React.FC<{
  data: ContextWindowData;
  barWidth: number;
}> = ({ data, barWidth }) => {
  const total = data.tokenLimit;
  if (total <= 0) return null;

  const segments = [
    { tokens: data.systemPromptTokens, color: categoryColors.system },
    { tokens: data.memoryTokens, color: categoryColors.memory },
    { tokens: data.toolDeclarationTokens, color: categoryColors.tools },
    { tokens: data.conversationTokens, color: categoryColors.conversation },
  ];

  const usedChars = segments.map((s) => {
    const fraction = s.tokens / total;
    return Math.max(fraction > 0 ? 1 : 0, Math.round(fraction * barWidth));
  });

  let totalUsedChars = usedChars.reduce((a, b) => a + b, 0);
  while (totalUsedChars > barWidth) {
    const maxIdx = usedChars.indexOf(Math.max(...usedChars));
    usedChars[maxIdx]--;
    totalUsedChars--;
  }

  const freeChars = barWidth - totalUsedChars;
  const markerPos = Math.round(data.compressionThreshold * barWidth);

  // Build bar entries
  const bar: Array<{ char: string; color: string }> = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = 0; j < usedChars[i]; j++) {
      bar.push({ char: '\u2588', color: segments[i].color });
    }
  }
  for (let i = 0; i < freeChars; i++) {
    bar.push({ char: '\u2591', color: categoryColors.free });
  }
  if (markerPos > 0 && markerPos < barWidth) {
    bar[markerPos] = { char: '\u2502', color: categoryColors.marker };
  }

  // Group consecutive same-color chars
  const groups: Array<{ text: string; color: string }> = [];
  for (const entry of bar) {
    const last = groups[groups.length - 1];
    if (last && last.color === entry.color) {
      last.text += entry.char;
    } else {
      groups.push({ text: entry.char, color: entry.color });
    }
  }

  // Sub-bar labels
  const pctUsedLabel = `used (${((data.tokensUsed / total) * 100).toFixed(0)}%)`;
  const compressLabel = `compress at ${(data.compressionThreshold * 100).toFixed(0)}%`;

  // Try to fit the compress label after the marker
  const markerCol = markerPos + 1;
  const rightLabel = '\u2514 ' + compressLabel;
  const lineWidth = barWidth + 2;
  let subBarLine: string;
  if (markerCol + rightLabel.length <= lineWidth) {
    const gap = Math.max(1, markerCol - pctUsedLabel.length);
    subBarLine = pctUsedLabel + ' '.repeat(gap) + rightLabel;
  } else {
    const leftArrow = compressLabel + ' \u2518';
    const arrowStart = markerCol - leftArrow.length + 1;
    const gap = Math.max(1, arrowStart - pctUsedLabel.length);
    subBarLine = pctUsedLabel + ' '.repeat(gap) + leftArrow;
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={categoryColors.free}>{'\u2590'}</Text>
        {groups.map((g, i) => (
          <Text key={i} color={g.color}>
            {g.text}
          </Text>
        ))}
        <Text color={categoryColors.free}>{'\u258C'}</Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary}>{subBarLine}</Text>
      </Box>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Main display
// ---------------------------------------------------------------------------

export const ContextWindowDisplay: React.FC<{ data: ContextWindowData }> = ({
  data,
}) => {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  // Reserve space for borders (2) + padding (4)
  const barWidth = Math.max(
    MIN_BAR_WIDTH,
    Math.min(MAX_BAR_WIDTH, termWidth - 6),
  );

  const pctUsed = data.tokenLimit > 0 ? data.tokensUsed / data.tokenLimit : 0;
  const remaining = Math.max(0, data.tokenLimit - data.tokensUsed);

  const turnsNote =
    data.estimatedTurnsRemaining !== null
      ? ` \u00B7 \u2248 ${fmtNum(data.estimatedTurnsRemaining)} turns at current rate`
      : '';

  const actualNote =
    data.actualPromptTokens !== null
      ? `  (API: ${fmtCompact(data.actualPromptTokens)})`
      : '';

  // Context features summary
  const features: string[] = [];
  if (data.contextManagementEnabled) features.push('auto-distillation');
  if (data.jitContextEnabled) features.push('JIT context');
  const strategyNote =
    features.length > 0 ? features.join(', ') : 'compression only';

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingTop={1}
      paddingX={2}
      width="100%"
      overflow="hidden"
    >
      {/* Header */}
      <Box flexDirection="row" marginBottom={1}>
        <Text bold color={theme.text.accent}>
          Context
        </Text>
        <Text color={theme.text.secondary}>
          {' \u00B7 '}
          {data.model}
        </Text>
      </Box>

      {/* Token headline */}
      <Box marginBottom={1}>
        <Text
          bold
          color={
            pctUsed >= 0.9
              ? theme.status.error
              : pctUsed >= 0.6
                ? theme.status.warning
                : theme.text.primary
          }
        >
          {fmtCompact(remaining)} tokens remaining
        </Text>
        <Text color={theme.text.secondary}>
          {' '}
          of {fmtCompact(data.tokenLimit)}
          {actualNote}
          {turnsNote}
        </Text>
      </Box>

      {/* Segmented bar */}
      <SegmentedBar data={data} barWidth={barWidth} />

      <Box height={1} />

      {/* Breakdown */}
      <Section title="Breakdown">
        <StatRow label="System prompt" color={categoryColors.system}>
          <Text>{fmtNum(data.systemPromptTokens)}</Text>
          <Text color={theme.text.secondary}>
            {'  '}
            {data.tokenLimit > 0
              ? ((data.systemPromptTokens / data.tokenLimit) * 100).toFixed(1)
              : '0.0'}
            %
          </Text>
        </StatRow>

        <StatRow label="Memory files" color={categoryColors.memory}>
          <Text>{fmtNum(data.memoryTokens)}</Text>
          <Text color={theme.text.secondary}>
            {'  '}
            {data.tokenLimit > 0
              ? ((data.memoryTokens / data.tokenLimit) * 100).toFixed(1)
              : '0.0'}
            %{'  '}
            {data.memoryFileCount} file{data.memoryFileCount !== 1 ? 's' : ''}
          </Text>
        </StatRow>

        {/* Per-file memory breakdown */}
        {data.memoryFiles.length > 0 &&
          data.memoryFiles.map((f, i) => (
            <Box key={i} paddingLeft={4}>
              <Box width={10} flexShrink={0}>
                <Text dimColor>{CATEGORY_LABELS[f.category]}</Text>
              </Box>
              <Text color={theme.text.secondary} wrap="truncate-end">
                {shortenPath(f.path)}
              </Text>
            </Box>
          ))}

        {/* MCP instructions (included in project memory tokens) */}
        {data.mcpInstructions.length > 0 &&
          data.mcpInstructions.map((mcp, i) => (
            <Box key={`mcp-${i}`} paddingLeft={4}>
              <Box width={10} flexShrink={0}>
                <Text dimColor>mcp</Text>
              </Box>
              <Text color={theme.text.secondary} wrap="truncate-end">
                {mcp.serverName}
                {'  '}
                {fmtNum(mcp.tokens)} tokens
              </Text>
            </Box>
          ))}

        <StatRow label="Tool schemas" color={categoryColors.tools}>
          <Text>{fmtNum(data.toolDeclarationTokens)}</Text>
          <Text color={theme.text.secondary}>
            {'  '}
            {data.tokenLimit > 0
              ? ((data.toolDeclarationTokens / data.tokenLimit) * 100).toFixed(
                  1,
                )
              : '0.0'}
            %{'  '}
            {data.toolCount} tool{data.toolCount !== 1 ? 's' : ''}
          </Text>
        </StatRow>

        <StatRow label="Conversation" color={categoryColors.conversation}>
          <Text>{fmtNum(data.conversationTokens)}</Text>
          <Text color={theme.text.secondary}>
            {'  '}
            {data.tokenLimit > 0
              ? ((data.conversationTokens / data.tokenLimit) * 100).toFixed(1)
              : '0.0'}
            %{'  '}
            {data.turnCount} turn{data.turnCount !== 1 ? 's' : ''}
          </Text>
        </StatRow>
      </Section>

      {/* Footer */}
      <Box>
        <Text color={theme.text.secondary}>
          Context strategy: {strategyNote}
        </Text>
      </Box>
    </Box>
  );
};
