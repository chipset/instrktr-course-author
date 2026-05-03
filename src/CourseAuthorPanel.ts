import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CourseDef, WebviewMessage, ExtensionMessage, AuthState, FileWrite, CustomSnippet, AuthorSettings } from './types';
import * as path from 'path';
import { CourseFileManager } from './CourseFileManager';
import { RegistryPublisher } from './RegistryPublisher';
import { ValidatorTester } from './ValidatorTester';
import { AssetManager } from './AssetManager';
import { CourseImporter } from './CourseImporter';
import { logError } from './logger';

export class CourseAuthorPanel {
  static currentPanel: CourseAuthorPanel | undefined;
  static readonly viewType = 'instrktrAuthor.editor';

  private readonly _panel: vscode.WebviewPanel;
  private _fileManager: CourseFileManager;
  private readonly _publisher: RegistryPublisher;
  private readonly _importer: CourseImporter;
  private readonly _globalState: vscode.Memento;
  private readonly _disposables: vscode.Disposable[] = [];

  static async createOrShow(
    extensionUri: vscode.Uri,
    courseDir: vscode.Uri,
    globalState: vscode.Memento,
  ): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (CourseAuthorPanel.currentPanel) {
      CourseAuthorPanel.currentPanel._panel.reveal(column);
      await CourseAuthorPanel.currentPanel._setCourseDir(courseDir);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CourseAuthorPanel.viewType,
      'Course Author',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'media'),
          courseDir,
        ],
        retainContextWhenHidden: true,
      },
    );

    CourseAuthorPanel.currentPanel = new CourseAuthorPanel(
      panel,
      extensionUri,
      courseDir,
      globalState,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    courseDir: vscode.Uri,
    globalState: vscode.Memento,
  ) {
    this._panel = panel;
    this._fileManager = new CourseFileManager(courseDir);
    this._globalState = globalState;
    this._publisher = new RegistryPublisher(globalState);
    this._importer = new CourseImporter();

    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleMessage(msg),
      null,
      this._disposables,
    );
  }

  private async _setCourseDir(courseDir: vscode.Uri): Promise<void> {
    this._fileManager = new CourseFileManager(courseDir);
    this._panel.webview.options = {
      ...this._panel.webview.options,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist'),
        vscode.Uri.joinPath(this._extensionUri, 'media'),
        courseDir,
      ],
    };
    await this._sendCourse();
    await this._sendAssets();
  }

  private async _sendCourse(): Promise<void> {
    try {
      const course = await this._fileManager.readCourse();
      this._send({ command: 'setCourse', course });
      this._updateTitle(course.title);
    } catch (err) {
      logError('Failed to read course.json', err);
      this._send({
        command: 'error',
        message: `Could not load course.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private _updateTitle(courseTitle: string): void {
    this._panel.title = `Course Author — ${courseTitle}`;
  }

  private async _handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.command) {
      case 'ready': {
        await this._sendCourse();
        await this._sendAuth();
        await this._sendAssets();
        this._send({ command: 'setPublishHistory', history: this._publisher.getHistory() });
        this._send({ command: 'setCustomSnippets', snippets: this._loadCustomSnippets() });
        this._send({ command: 'setSettings', settings: this._loadSettings() });
        break;
      }

      case 'saveCourse': {
        try {
          await this._saveCourseSnapshot(msg.course, msg.fileWrites, msg.fileDeletes);
          this._updateTitle(msg.course.title);
          this._send({ command: 'saveResult', success: true });
        } catch (err) {
          logError('Failed to save course.json', err);
          const message = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
          this._send({ command: 'saveResult', success: false, message });
          this._send({ command: 'error', message });
        }
        break;
      }

      case 'readFile': {
        try {
          const content = await this._fileManager.readFile(msg.filePath);
          this._send({ command: 'fileContent', requestId: msg.requestId, filePath: msg.filePath, content });
        } catch (err) {
          logError(`Failed to read file: ${msg.filePath}`, err);
          this._send({ command: 'fileContent', requestId: msg.requestId, filePath: msg.filePath, content: '' });
        }
        break;
      }

      case 'writeFile': {
        try {
          await this._fileManager.writeFile(msg.filePath, msg.content);
        } catch (err) {
          logError(`Failed to write file: ${msg.filePath}`, err);
          this._send({ command: 'error', message: `Write failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }

      case 'renameFile': {
        try {
          await this._fileManager.renameFile(msg.oldPath, msg.newPath);
          this._send({
            command: 'renameResult',
            requestId: msg.requestId,
            oldPath: msg.oldPath,
            newPath: msg.newPath,
            success: true,
          });
          await this._sendAssets();
        } catch (err) {
          logError(`Failed to rename file: ${msg.oldPath}`, err);
          this._send({
            command: 'renameResult',
            requestId: msg.requestId,
            oldPath: msg.oldPath,
            newPath: msg.newPath,
            success: false,
            message: `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break;
      }

      case 'createStepScaffold': {
        try {
          const { instructions, validator } = await this._fileManager.createStepScaffold(msg.stepIndex, msg.step);
          this._send({ command: 'scaffoldResult', stepIndex: msg.stepIndex, instructions, validator });
        } catch (err) {
          logError('Failed to scaffold step', err);
          this._send({ command: 'error', message: `Scaffold failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }

      case 'deleteFiles': {
        try {
          await this._fileManager.deleteFiles(msg.filePaths);
        } catch (err) {
          logError('Failed to delete files', err);
        }
        break;
      }

      case 'publishCourse': {
        await this._handlePublish(
          msg.repo,
          msg.tags,
          msg.bumpType,
          msg.course,
          msg.fileWrites,
          msg.fileDeletes,
        );
        break;
      }

      // ── Feature 1: validator testing ─────────────────────────────────────
      case 'runValidator': {
        await this._handleRunValidator(msg.stepIndex, msg.course, msg.fileWrites);
        break;
      }

      // ── Feature 4: asset management ───────────────────────────────────────
      case 'listAssets': {
        await this._sendAssets();
        break;
      }

      case 'importAsset': {
        try {
          const mgr = new AssetManager(this._fileManager.courseDir);
          const asset = await mgr.import();
          if (asset) {
            this._send({ command: 'assetImported', asset });
            await this._sendAssets();
          }
        } catch (err) {
          logError('Asset import failed', err);
          this._send({ command: 'error', message: `Asset import failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }

      // ── Feature 5: course import ──────────────────────────────────────────
      case 'importCourseFromUrl': {
        await this._handleImportFromUrl(msg.url);
        break;
      }

      case 'importCourseFromLocal': {
        await this._handleImportFromLocal();
        break;
      }

      case 'signIn': {
        try {
          await vscode.authentication.getSession('github', ['repo', 'gist'], { createIfNone: true });
          await this._sendAuth();
        } catch (err) {
          logError('Sign-in failed', err);
          this._send({ command: 'error', message: 'Sign in failed. Please try again.' });
        }
        break;
      }

      case 'listRepos': {
        await this._sendRepos();
        break;
      }

      case 'listWorkspaceCourses': {
        await this._sendWorkspaceCourses();
        break;
      }

      case 'openWorkspaceCourse': {
        await this._setCourseDir(vscode.Uri.file(msg.courseDir));
        break;
      }

      case 'saveCustomSnippets': {
        await this._globalState.update('customSnippets', msg.snippets);
        this._send({ command: 'setCustomSnippets', snippets: msg.snippets });
        break;
      }

      case 'signOut': {
        await vscode.window.showInformationMessage(
          'To sign out of GitHub, use the Accounts menu in the VS Code status bar.',
        );
        break;
      }
    }
  }

  private _loadCustomSnippets(): CustomSnippet[] {
    return this._globalState.get<CustomSnippet[]>('customSnippets', []);
  }

  private _loadSettings(): AuthorSettings {
    const cfg = vscode.workspace.getConfiguration('instrktrAuthor');
    return {
      syntaxStatus: cfg.get<AuthorSettings['syntaxStatus']>('syntaxStatus', 'always'),
      syntaxHighlighting: cfg.get<boolean>('syntaxHighlighting', true),
    };
  }

  private async _sendRepos(): Promise<void> {
    const session = await this._getSession();
    if (!session) {
      this._send({ command: 'setRepos', repos: [] });
      this._send({ command: 'error', message: 'Sign in with GitHub before loading repositories.' });
      return;
    }
    try {
      const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub repos request failed (${res.status})`);
      const repos = await res.json() as { full_name: string }[];
      this._send({ command: 'setRepos', repos: repos.map((r) => r.full_name).sort() });
    } catch (err) {
      this._send({ command: 'error', message: `Could not load repos: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async _sendWorkspaceCourses(): Promise<void> {
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const courses: string[] = [];
    for (const root of roots) {
      await this._findCourses(root, courses, 0);
    }
    this._send({ command: 'setWorkspaceCourses', courses });
  }

  private async _findCourses(dir: string, found: string[], depth: number): Promise<void> {
    if (depth > 4 || found.length > 50) return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }
    if (entries.some(([name]) => name === 'course.json')) {
      found.push(dir);
      return;
    }
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory && !['node_modules', '.git', 'dist', 'out'].includes(name)) {
        await this._findCourses(path.join(dir, name), found, depth + 1);
      }
    }
  }

  private async _saveCourseSnapshot(
    course: CourseDef,
    fileWrites: FileWrite[] = [],
    fileDeletes: string[] = [],
  ): Promise<void> {
    for (const write of fileWrites) {
      await this._fileManager.writeFile(write.filePath, write.content);
    }
    await this._fileManager.writeCourse(course);
    if (fileDeletes.length > 0) {
      await this._fileManager.deleteFiles(fileDeletes);
    }
  }

  private async _writeFiles(fileWrites: FileWrite[] = []): Promise<void> {
    for (const write of fileWrites) {
      await this._fileManager.writeFile(write.filePath, write.content);
    }
  }

  private async _handleRunValidator(
    stepIndex: number,
    courseSnapshot?: CourseDef,
    fileWrites?: FileWrite[],
  ): Promise<void> {
    let course: CourseDef;
    try {
      await this._writeFiles(fileWrites);
      course = courseSnapshot ?? await this._fileManager.readCourse();
    } catch (err) {
      this._send({
        command: 'validatorResult',
        result: { status: 'error', message: `Could not read course.json: ${err instanceof Error ? err.message : String(err)}`, duration: 0 },
      });
      return;
    }

    const step = course.steps[stepIndex];
    if (!step?.validator) {
      this._send({
        command: 'validatorResult',
        result: { status: 'error', message: 'This step has no validator file.', duration: 0 },
      });
      return;
    }

    const tester = new ValidatorTester(this._fileManager.courseDir);
    const result = await tester.run(step.validator);
    this._send({ command: 'validatorResult', result });
  }

  private async _handlePublish(
    repo: string,
    tags: string[],
    bumpType: 'major' | 'minor' | 'patch' | 'none',
    courseSnapshot?: CourseDef,
    fileWrites?: FileWrite[],
    fileDeletes?: string[],
  ): Promise<void> {
    const session = await this._getSession();
    if (!session) {
      this._send({ command: 'publishProgress', status: 'error', message: 'Not signed in. Click "Sign in with GitHub" first.' });
      return;
    }

    let course: CourseDef;
    try {
      course = courseSnapshot ?? await this._fileManager.readCourse();
    } catch (err) {
      this._send({ command: 'publishProgress', status: 'error', message: `Could not read course.json: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    if (bumpType !== 'none') {
      course.version = bumpVersion(course.version, bumpType);
    }

    try {
      await this._saveCourseSnapshot(course, fileWrites, fileDeletes);
      this._send({ command: 'setCourse', course });
      this._send({ command: 'saveResult', success: true });
    } catch (err) {
      this._send({ command: 'saveResult', success: false, message: err instanceof Error ? err.message : String(err) });
      this._send({ command: 'publishProgress', status: 'error', message: `Could not save before publish: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    this._send({ command: 'publishProgress', status: 'progress', message: 'Starting publish…' });

    try {
      const registryUrl = await this._publisher.publish(
        course, repo, tags, session.accessToken,
        (msg) => this._send({ command: 'publishProgress', status: 'progress', message: msg }),
      );

      this._send({ command: 'publishProgress', status: 'success', message: 'Course published!', registryUrl });
      this._send({ command: 'setPublishHistory', history: this._publisher.getHistory() });
    } catch (err) {
      logError('Publish failed', err);
      this._send({ command: 'publishProgress', status: 'error', message: `Publish failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async _handleImportFromUrl(url: string): Promise<void> {
    this._send({ command: 'importProgress', status: 'progress', message: 'Starting import…' });
    try {
      const courseUri = await this._importer.importFromUrl(
        url,
        (msg) => this._send({ command: 'importProgress', status: 'progress', message: msg }),
      );
      if (!courseUri) {
        this._send({ command: 'importProgress', status: 'error', message: 'Import cancelled.' });
        return;
      }
      this._send({ command: 'importProgress', status: 'success', message: 'Import complete.' });
      this._send({ command: 'importComplete', courseDir: courseUri.fsPath });

      const answer = await vscode.window.showInformationMessage(
        `Course cloned to ${courseUri.fsPath}`,
        'Open in Editor',
      );
      if (answer === 'Open in Editor') {
        await this._setCourseDir(courseUri);
      }
    } catch (err) {
      this._send({ command: 'importProgress', status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async _handleImportFromLocal(): Promise<void> {
    try {
      const courseUri = await this._importer.importFromLocal();
      if (!courseUri) return;

      await this._setCourseDir(courseUri);
      this._send({ command: 'importProgress', status: 'success', message: 'Course loaded.' });
      this._send({ command: 'importComplete', courseDir: courseUri.fsPath });
    } catch (err) {
      this._send({ command: 'importProgress', status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async _sendAssets(): Promise<void> {
    const mgr = new AssetManager(this._fileManager.courseDir);
    const assets = (await mgr.list()).map((asset) => ({
      ...asset,
      webviewUri: this._panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this._fileManager.courseDir, asset.relativePath),
      ).toString(),
    }));
    this._send({ command: 'assetList', assets });
  }

  private async _sendAuth(): Promise<void> {
    this._send({ command: 'setAuth', auth: await this._loadAuth() });
  }

  private async _loadAuth(): Promise<AuthState> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo', 'gist'], { silent: true });
      if (session) return { signedIn: true, username: session.account.label };
    } catch { /* no session */ }
    return { signedIn: false };
  }

  private async _getSession(): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession('github', ['repo', 'gist'], { silent: true });
    } catch {
      return undefined;
    }
  }

  private _send(msg: ExtensionMessage): void {
    this._panel.webview.postMessage(msg);
  }

  private _buildHtml(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'styles.css'));
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${csp} 'unsafe-inline';
             img-src ${csp} data: https:;
             script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesUri}">
  <title>Course Author</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    CourseAuthorPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) d.dispose();
    this._disposables.length = 0;
  }
}

function bumpVersion(version: string, type: 'major' | 'minor' | 'patch'): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
