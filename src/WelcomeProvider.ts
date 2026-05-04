import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Welcome sidebar view — shown when no course editor is open.
 * Provides quick actions: open course folder, create new course.
 */
export class WelcomeProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'instrktrAuthor.welcome';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
    };
    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      if (msg.command === 'openCourse') {
        vscode.commands.executeCommand('instrktrAuthor.openCourse');
      } else if (msg.command === 'openGitCourse') {
        vscode.commands.executeCommand('instrktrAuthor.openGitCourse');
      } else if (msg.command === 'newCourse') {
        vscode.commands.executeCommand('instrktrAuthor.newCourse');
      } else if (msg.command === 'openWorkspace') {
        vscode.commands.executeCommand('instrktrAuthor.openCurrentWorkspace');
      }
    });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${csp} 'unsafe-inline';
             script-src 'nonce-${nonce}';">
  <style>
    body {
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
    }
    h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 12px; margin: 0 0 12px; opacity: 0.8; line-height: 1.5; }
    .btn {
      display: block;
      width: 100%;
      padding: 6px 10px;
      margin-bottom: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      text-align: left;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  </style>
</head>
<body>
  <h2>Course Author</h2>
  <p>Create and edit Instrktr courses with a visual editor.</p>
  <button class="btn" id="btn-workspace">Edit Course in Workspace</button>
  <button class="btn secondary" id="btn-open">Open Course…</button>
  <button class="btn secondary" id="btn-open-git">Clone Git Course…</button>
  <hr class="divider">
  <button class="btn secondary" id="btn-new">New Course…</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(command) { vscode.postMessage({ command }); }
    document.getElementById('btn-workspace').addEventListener('click', function() { send('openWorkspace'); });
    document.getElementById('btn-open').addEventListener('click', function() { send('openCourse'); });
    document.getElementById('btn-open-git').addEventListener('click', function() { send('openGitCourse'); });
    document.getElementById('btn-new').addEventListener('click', function() { send('newCourse'); });
  </script>
</body>
</html>`;
  }
}
