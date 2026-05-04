import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { logError } from './logger';

const GITHUB_URL_RE =
  /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+))?(?:[/?#].*)?$/;

export class CourseImporter {
  /**
   * Clone a GitHub repo into a user-chosen directory and return the new course Uri.
   * Throws with a user-friendly message on failure.
   */
  async importFromUrl(
    rawUrl: string,
    onProgress: (msg: string) => void,
    options: { preserveGit?: boolean } = {},
  ): Promise<vscode.Uri | null> {
    const match = rawUrl.match(GITHUB_URL_RE);
    if (!match) {
      throw new Error(
        `Unrecognised GitHub URL: "${rawUrl}"\nExpected: https://github.com/owner/repo`,
      );
    }
    const [, owner, repo, branch = 'main'] = match;

    // Verify git is available before showing the folder picker
    await this._requireGit();

    const parentUris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: `Choose where to clone "${owner}/${repo}"`,
      openLabel: 'Clone Here',
    });
    if (!parentUris || parentUris.length === 0) return null;

    const destDir = path.join(parentUris[0].fsPath, repo);

    if (fs.existsSync(destDir)) {
      const answer = await vscode.window.showWarningMessage(
        `Directory "${destDir}" already exists.`,
        { modal: true },
        'Use Anyway',
      );
      if (answer !== 'Use Anyway') return null;
    }

    onProgress(`Cloning ${owner}/${repo}@${branch}…`);
    await this._gitClone(owner, repo, branch, destDir, onProgress, options);

    return vscode.Uri.file(destDir);
  }

  /** Open a folder picker and return its Uri without any copying. */
  async importFromLocal(): Promise<vscode.Uri | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: 'Select course folder (must contain course.json)',
      openLabel: 'Open Course',
    });
    return uris?.[0] ?? null;
  }

  private async _requireGit(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      childProcess.execFile('git', ['--version'], (err) => {
        if (err) {
          reject(
            new Error('Git is not installed or not on PATH. Install git to import from GitHub.'),
          );
        } else {
          resolve();
        }
      });
    });
  }

  private async _gitClone(
    owner: string,
    repo: string,
    branch: string,
    destDir: string,
    onProgress: (msg: string) => void,
    options: { preserveGit?: boolean } = {},
  ): Promise<void> {
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    const cloneArgs = options.preserveGit
      ? ['clone', '--branch', branch, cloneUrl, destDir]
      : ['clone', '--depth', '1', '--branch', branch, cloneUrl, destDir];

    await new Promise<void>((resolve, reject) => {
      const proc = childProcess.spawn(
        'git',
        cloneArgs,
        { stdio: 'pipe' },
      );

      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          stderr += line + '\n';
          // git clone writes progress to stderr
          const progressMatch = line.match(/Receiving objects:\s+(\d+)%/);
          if (progressMatch) {
            onProgress(`Cloning… ${progressMatch[1]}%`);
          }
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          logError('git clone failed', stderr);
          // Try main branch if the specified one fails
          if (branch !== 'main') {
            reject(new Error(`git clone failed (exit ${code}). Branch "${branch}" not found?`));
          } else {
            // Retry with "master"
            onProgress('Branch "main" not found, retrying with "master"…');
            const retryArgs = options.preserveGit
              ? ['clone', '--branch', 'master', cloneUrl, destDir]
              : ['clone', '--depth', '1', '--branch', 'master', cloneUrl, destDir];
            const retry = childProcess.spawn(
              'git',
              retryArgs,
              { stdio: 'pipe' },
            );
            retry.stderr?.on('data', (chunk: Buffer) => {
              const line = chunk.toString().trim();
              const progressMatch = line.match(/Receiving objects:\s+(\d+)%/);
              if (progressMatch) onProgress(`Cloning… ${progressMatch[1]}%`);
            });
            retry.on('close', (code2) => {
              if (code2 === 0) resolve();
              else reject(new Error(`git clone failed (exit ${code2}): ${stderr}`));
            });
          }
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run git: ${err.message}`));
      });
    });

    if (!options.preserveGit) {
      onProgress('Removing .git metadata…');
      try {
        fs.rmSync(path.join(destDir, '.git'), { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }
  }
}
