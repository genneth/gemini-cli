/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Checks if a directory is within a git repository
 * @param directory The directory to check
 * @returns true if the directory is in a git repository, false otherwise
 */
export function isGitRepository(directory: string): boolean {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      // Check if .git exists (either as directory or file for worktrees)
      if (fs.existsSync(gitDir)) {
        return true;
      }

      const parentDir = path.dirname(currentDir);

      // If we've reached the root directory, stop searching
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return false;
  } catch {
    // If any filesystem error occurs, assume not a git repo
    return false;
  }
}

/**
 * Finds the root directory of a git repository
 * @param directory Starting directory to search from
 * @returns The git repository root path, or null if not in a git repository
 */
export function findGitRoot(directory: string): string | null {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      if (fs.existsSync(gitDir)) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);

      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Filters out paths that are ignored by git.
 * Proper implementation that handles the throw from execFileAsync correctly.
 */
export async function getGitIgnoredPaths(
  paths: string[],
  cwd: string,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  if (!isGitRepository(cwd)) return new Set();

  let stdout = '';
  try {
    // Write paths to a child process stdin
    const child = execFile('git', ['check-ignore', '--stdin', '-z'], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });

    const promise = new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.on('close', (code) => {
        if (code === 0 || code === 1) {
          resolve();
        } else {
          reject(new Error(`git check-ignore exited with code ${code}`));
        }
      });
      child.on('error', reject);
    });

    child.stdin?.write(paths.join('\0'));
    child.stdin?.end();

    await promise;
  } catch {
    return new Set();
  }

  const ignored = new Set<string>();
  if (stdout) {
    const ignoredPaths = stdout.split('\0').filter((p) => p.length > 0);
    for (const p of ignoredPaths) {
      ignored.add(path.resolve(cwd, p));
    }
  }
  return ignored;
}
