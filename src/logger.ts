import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('Course Author');
  }
  return _channel;
}

export function log(message: string): void {
  channel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? '');
  channel().appendLine(
    `[${new Date().toISOString()}] ERROR: ${message}${detail ? ': ' + detail : ''}`,
  );
}
