import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { ValidatorTestResult } from './types';
import { logError } from './logger';

const TIMEOUT_MS = 15_000;

export class ValidatorTester {
  constructor(private readonly _courseDir: vscode.Uri) {}

  async run(validatorRelPath: string): Promise<ValidatorTestResult> {
    const start = Date.now();
    const absPath = path.join(this._courseDir.fsPath, validatorRelPath);

    if (!fs.existsSync(absPath)) {
      return { status: 'error', message: `Validator file not found: ${validatorRelPath}`, duration: 0 };
    }

    if (validatorRelPath.endsWith('.sh')) {
      return this._runShell(absPath, start);
    }

    return this._runJs(absPath, start);
  }

  private async _runJs(absPath: string, start: number): Promise<ValidatorTestResult> {
    const workspaceDir =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this._courseDir.fsPath;

    let terminalNote: string | undefined;
    let lastCommand = '';
    let lastOutput = '';
    const runCommand = (
      command: string,
      options: childProcess.ExecOptions = {},
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      lastCommand = command;
      return new Promise((resolve) => {
        childProcess.exec(
          command,
          {
            cwd: workspaceDir,
            timeout: 10_000,
            ...options,
          },
          (err, stdout, stderr) => {
            const stdoutText = String(stdout ?? '');
            const stderrText = String(stderr ?? '');
            lastOutput = `${stdoutText}${stderrText}`;
            const code = err && typeof err === 'object' && 'code' in err
              ? Number((err as { code?: number | string }).code ?? 1)
              : 0;
            resolve({
              stdout: stdoutText,
              stderr: stderrText,
              exitCode: Number.isFinite(code) ? code : 1,
            });
          },
        );
      });
    };

    const context = {
      files: {
        async exists(p: string): Promise<boolean> {
          return fs.existsSync(path.join(workspaceDir, p));
        },
        async read(p: string): Promise<string> {
          try { return fs.readFileSync(path.join(workspaceDir, p), 'utf8'); } catch { return ''; }
        },
        async matches(p: string, pattern: RegExp): Promise<boolean> {
          try {
            return pattern.test(fs.readFileSync(path.join(workspaceDir, p), 'utf8'));
          } catch { return false; }
        },
        async list(dir: string): Promise<string[]> {
          try { return fs.readdirSync(path.join(workspaceDir, dir)); } catch { return []; }
        },
      },
      terminal: {
        async lastCommand(): Promise<string> {
          if (!lastCommand && !terminalNote) {
            terminalNote = 'terminal.lastCommand() can only see commands run through context.terminal.run() in author test mode';
          }
          return lastCommand;
        },
        async outputContains(text: string): Promise<boolean> {
          if (!lastOutput && !terminalNote) {
            terminalNote = 'terminal.outputContains() can only inspect output from context.terminal.run() in author test mode';
          }
          return lastOutput.includes(text);
        },
        async run(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
          return runCommand(command);
        },
        async runShell(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
          return runCommand(command, {
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          });
        },
      },
      env: {
        get(name: string): string | undefined { return process.env[name]; },
      },
      workspace: {
        async getConfig(key: string): Promise<unknown> {
          const [section, ...rest] = key.split('.');
          if (!section || rest.length === 0) {
            return vscode.workspace.getConfiguration().get(key);
          }
          return vscode.workspace.getConfiguration(section).get(rest.join('.'));
        },
      },
      pass(message: string) { return { status: 'pass' as const, message }; },
      fail(message: string) { return { status: 'fail' as const, message }; },
      warn(message: string) { return { status: 'warn' as const, message }; },
    };

    try {
      // Bust the module cache so re-runs pick up saved edits
      delete require.cache[absPath];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const validateFn = require(absPath) as (
        ctx: typeof context,
      ) => Promise<{ status: string; message: string }>;

      const result = await Promise.race([
        validateFn(context),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Validator timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
        ),
      ]);

      return {
        status: result.status as ValidatorTestResult['status'],
        message: result.message,
        duration: Date.now() - start,
        terminalNote,
      };
    } catch (err) {
      logError('Validator test threw', err);
      return {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  }

  private async _runShell(absPath: string, start: number): Promise<ValidatorTestResult> {
    const workspaceDir =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this._courseDir.fsPath;

    return new Promise((resolve) => {
      childProcess.execFile(
        'bash',
        [absPath],
        {
          cwd: workspaceDir,
          timeout: TIMEOUT_MS,
          env: {
            ...process.env,
            INSTRKTR_WORKSPACE: workspaceDir,
            INSTRKTR_STEP: path.basename(path.dirname(absPath)),
          },
        },
        (err, stdout, stderr) => {
          const duration = Date.now() - start;
          if (!err) {
            resolve({ status: 'pass', message: stdout.trim() || 'Pass', duration });
          } else if (err.code === 2) {
            resolve({ status: 'warn', message: stdout.trim() || stderr.trim() || 'Warning', duration });
          } else {
            resolve({ status: 'fail', message: stdout.trim() || stderr.trim() || 'Failed', duration });
          }
        },
      );
    });
  }
}
