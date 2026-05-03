/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../semantic-colors.js';
import type {
  ContextWindowData,
  LastCompressionEvent,
  MemoryFileInfo,
  NodeTypeSummary,
  TopConsumer,
} from '../types.js';

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

/**
 * Conversation breakdown row. Single number when heuristic and API-attributed
 * residual agree (or no API count exists). When they materially diverge
 * (≥10k abs AND ≥1.5× ratio) we show the API-attributed number primary and
 * the heuristic in parentheses — the heuristic is what the model would see if
 * we hadn't trimmed multimodal upper-bounds, and the gap signals where the
 * estimator is being conservative.
 */
const ConversationStatRow: React.FC<{ data: ContextWindowData }> = ({
  data,
}) => {
  const label = data.contextManagerActive
    ? 'Conversation (rendered)'
    : 'Conversation';
  const conv = data.conversationTokens;
  const primary = conv.residual ?? conv.heuristic;
  const pct =
    data.tokenLimit > 0
      ? ((primary / data.tokenLimit) * 100).toFixed(1)
      : '0.0';
  return (
    <StatRow label={label} color={categoryColors.conversation}>
      <Text>{fmtNum(primary)}</Text>
      {conv.materiallyDivergent && (
        <Text color={theme.text.secondary}>
          {' '}
          ({fmtCompact(conv.heuristic)} est)
        </Text>
      )}
      <Text color={theme.text.secondary}>
        {'  '}
        {pct}%{'  '}
        {data.turnCount} turn{data.turnCount !== 1 ? 's' : ''}
      </Text>
    </StatRow>
  );
};

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

/**
 * Determine where to draw the threshold marker on the bar.
 *  - CM on with a budget: at `retainedTokenBudget / tokenLimit` (absolute trigger).
 *  - CM off: at `compressionThreshold` (legacy %-of-limit).
 *  - Otherwise: hidden.
 * Returns the marker position (0..barWidth) and a label, or null to suppress.
 */
function resolveMarker(
  data: ContextWindowData,
  barWidth: number,
): { pos: number; label: string } | null {
  if (data.contextManagerActive) {
    if (
      data.cmRetainedTokenBudget !== null &&
      data.cmRetainedTokenBudget > 0 &&
      data.tokenLimit > 0
    ) {
      const fraction = Math.min(
        1,
        data.cmRetainedTokenBudget / data.tokenLimit,
      );
      return {
        pos: Math.round(fraction * barWidth),
        label: `retain ${(fraction * 100).toFixed(0)}%`,
      };
    }
    return null;
  }
  return {
    pos: Math.round(data.compressionThreshold * barWidth),
    label: `compress at ${(data.compressionThreshold * 100).toFixed(0)}%`,
  };
}

const SegmentedBar: React.FC<{
  data: ContextWindowData;
  barWidth: number;
}> = ({ data, barWidth }) => {
  const total = data.tokenLimit;
  if (total <= 0) return null;

  // Conversation segment uses the residual (API − static) when available,
  // since the per-PDF heuristic upper-bounds (25.8k each) can over-count by
  // 10× on typical documents. When no API count is available, fall back to
  // the heuristic with the same caveat.
  const conversationBarTokens =
    data.conversationTokens.residual ?? data.conversationTokens.heuristic;
  const segments = [
    { tokens: data.systemPromptTokens, color: categoryColors.system },
    { tokens: data.memoryTokens, color: categoryColors.memory },
    { tokens: data.toolDeclarationTokens, color: categoryColors.tools },
    { tokens: conversationBarTokens, color: categoryColors.conversation },
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
  const marker = resolveMarker(data, barWidth);

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
  if (marker && marker.pos > 0 && marker.pos < barWidth) {
    bar[marker.pos] = { char: '\u2502', color: categoryColors.marker };
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

  // Sub-bar labels. The source suffix ties the visual claim to its provenance:
  // "API" = ground truth from the last API response; "est" = heuristic estimate
  // (multimodal upper-bounds can over-count significantly).
  const sourceSuffix = data.totalTokensSource === 'api' ? ' · API' : ' · est';
  const pctUsedLabel = `used (${((data.totalTokens / total) * 100).toFixed(0)}%)${sourceSuffix}`;
  let subBarLine = pctUsedLabel;
  if (marker) {
    const markerCol = marker.pos + 1;
    const rightLabel = '\u2514 ' + marker.label;
    const lineWidth = barWidth + 2;
    if (markerCol + rightLabel.length <= lineWidth) {
      const gap = Math.max(1, markerCol - pctUsedLabel.length);
      subBarLine = pctUsedLabel + ' '.repeat(gap) + rightLabel;
    } else {
      const leftArrow = marker.label + ' \u2518';
      const arrowStart = markerCol - leftArrow.length + 1;
      const gap = Math.max(1, arrowStart - pctUsedLabel.length);
      subBarLine = pctUsedLabel + ' '.repeat(gap) + leftArrow;
    }
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
// ContextManager diagnostics sections
// ---------------------------------------------------------------------------

const NODE_TYPE_LABELS: Record<string, string> = {
  USER_PROMPT: 'user',
  AGENT_THOUGHT: 'thought',
  AGENT_YIELD: 'reply',
  TOOL_EXECUTION: 'tool',
  MASKED_TOOL: 'tool (masked)',
  SYSTEM_EVENT: 'system',
  SNAPSHOT: 'snapshot',
  ROLLING_SUMMARY: 'summary',
};

function nodeTypeLabel(t: string): string {
  return NODE_TYPE_LABELS[t] ?? t.toLowerCase();
}

const NodeTypeBreakdown: React.FC<{ entries: NodeTypeSummary[] }> = ({
  entries,
}) => (
  <Section title="Conversation breakdown">
    {entries.map((e) => (
      <Box key={e.nodeType} paddingLeft={2}>
        <Box width={18} flexShrink={0}>
          <Text color={theme.text.secondary}>{nodeTypeLabel(e.nodeType)}</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text>{fmtNum(e.tokens)}</Text>
        </Box>
        <Text color={theme.text.secondary}>
          {e.count} node{e.count !== 1 ? 's' : ''}
        </Text>
      </Box>
    ))}
  </Section>
);

const TopConsumersTable: React.FC<{ entries: TopConsumer[] }> = ({
  entries,
}) => (
  <Section title="Top consumers">
    {entries.map((e, i) => (
      <Box key={i} paddingLeft={2}>
        <Box width={14} flexShrink={0}>
          <Text color={theme.text.secondary}>{nodeTypeLabel(e.nodeType)}</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text>{fmtNum(e.tokens)}</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text color={theme.text.secondary}>
            {e.ageTurns === 0
              ? 'now'
              : `-${e.ageTurns} turn${e.ageTurns !== 1 ? 's' : ''}`}
          </Text>
        </Box>
        <Text color={theme.text.secondary} wrap="truncate-end">
          {e.label || '\u2014'}
        </Text>
      </Box>
    ))}
  </Section>
);

function formatRelativeTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

const LastCompressionLine: React.FC<{ event: LastCompressionEvent }> = ({
  event,
}) => {
  const when =
    event.turnsAgo !== null && event.turnsAgo > 0
      ? `${event.turnsAgo} turn${event.turnsAgo !== 1 ? 's' : ''} ago`
      : `${formatRelativeTime(event.secondsAgo)} ago`;
  const replacement = `${event.removedCount} \u2192 ${event.addedCount} nodes`;
  const savings =
    event.tokensSaved !== null
      ? `, saved ${fmtCompact(Math.max(0, event.tokensSaved))} tok`
      : '';
  return (
    <Box marginBottom={1}>
      <Text color={theme.text.secondary}>
        Last compression: {when} {'\u2014'} {event.processorId} ({replacement}
        {savings})
      </Text>
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

  const pctUsed = data.tokenLimit > 0 ? data.totalTokens / data.tokenLimit : 0;
  const remaining = Math.max(0, data.tokenLimit - data.totalTokens);

  const turnsNote =
    data.estimatedTurnsRemaining !== null
      ? ` \u00B7 \u2248 ${fmtNum(data.estimatedTurnsRemaining)} turns at current rate`
      : '';

  // Context features summary. When CM is wired, surface the active profile
  // name (e.g. "ContextManager: Generalist (Default)") so the user can see
  // which retention policy is driving compression.
  const features: string[] = [];
  if (data.contextManagerActive) {
    features.push(
      data.cmProfileName
        ? `ContextManager: ${data.cmProfileName}`
        : 'context manager',
    );
  } else if (data.contextManagementEnabled) {
    features.push('auto-distillation');
  }
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
              <Box width={11} flexShrink={0}>
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
              <Box width={11} flexShrink={0}>
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

        <ConversationStatRow data={data} />
      </Section>

      {/* ContextManager diagnostics — only meaningful when CM is wired */}
      {data.lastCompression && (
        <LastCompressionLine event={data.lastCompression} />
      )}
      {data.nodeTypeBreakdown && data.nodeTypeBreakdown.length > 0 && (
        <NodeTypeBreakdown entries={data.nodeTypeBreakdown} />
      )}
      {data.topConsumers && data.topConsumers.length > 0 && (
        <TopConsumersTable entries={data.topConsumers} />
      )}

      {/* Footer */}
      <Box>
        <Text color={theme.text.secondary}>
          Context strategy: {strategyNote}
        </Text>
      </Box>
    </Box>
  );
};
