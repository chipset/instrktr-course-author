import * as vscode from 'vscode';
import { CourseAuthorPanel } from './CourseAuthorPanel';
import { WelcomeProvider } from './WelcomeProvider';
import { CourseFileManager } from './CourseFileManager';
import { CourseImporter } from './CourseImporter';
import { logError } from './logger';

export function activate(context: vscode.ExtensionContext): void {
  const { extensionUri, globalState } = context;

  // Register the sidebar welcome view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WelcomeProvider.viewId,
      new WelcomeProvider(extensionUri),
    ),
  );

  // Open a course folder chosen via file picker
  context.subscriptions.push(
    vscode.commands.registerCommand('instrktrAuthor.openCourse', async () => {
      const source = await vscode.window.showQuickPick(
        [
          { label: 'Open local folder', description: 'Choose a course folder already on disk', sourceType: 'local' as const },
          { label: 'Clone from Git repo', description: 'Download from GitHub and keep git history connected', sourceType: 'git' as const },
        ],
        {
          placeHolder: 'Open a local course or clone a git-connected course',
          title: 'Open Course',
        },
      );
      if (!source) return;

      if (source.sourceType === 'git') {
        await openCourseFromGit(extensionUri, globalState);
        return;
      }

      const courseDir = await pickLocalCourseFolder();
      if (!courseDir) return;
      await openCourse(courseDir, extensionUri, globalState);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('instrktrAuthor.openGitCourse', async () => {
      await openCourseFromGit(extensionUri, globalState);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('instrktrAuthor.openLocalCourse', async () => {
      const courseDir = await pickLocalCourseFolder();
      if (!courseDir) return;
      await openCourse(courseDir, extensionUri, globalState);
    }),
  );

  async function pickLocalCourseFolder(): Promise<vscode.Uri | undefined> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: 'Select a course folder (containing course.json)',
      openLabel: 'Open Course',
    });
    return uris?.[0];
  }

  async function openCourseFromGit(
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
  ): Promise<void> {
    const url = await vscode.window.showInputBox({
      prompt: 'GitHub repository URL',
      placeHolder: 'https://github.com/owner/course-repo',
      validateInput: (v) => (v.trim() ? undefined : 'Enter a GitHub repository URL'),
    });
    if (!url) return;

    const importer = new CourseImporter();
    try {
      const courseDir = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Cloning course repository',
        cancellable: false,
      }, async (progress) => importer.importFromUrl(
        url,
        (message) => progress.report({ message }),
        { preserveGit: true },
      ));
      if (!courseDir) return;
      await openCourse(courseDir, extensionUri, globalState);
      const openFolder = await vscode.window.showInformationMessage(
        `Course cloned with git history at ${courseDir.fsPath}`,
        'Open Folder',
      );
      if (openFolder === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder', courseDir, { forceNewWindow: false });
      }
    } catch (err) {
      logError('Open git course failed', err);
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  // Open the course in the currently-open workspace folder
  context.subscriptions.push(
    vscode.commands.registerCommand('instrktrAuthor.openCurrentWorkspace', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(
          'No workspace folder open. Open a course folder in VS Code first.',
        );
        return;
      }
      // If multiple workspace folders, let user pick
      let courseDir: vscode.Uri;
      if (folders.length === 1) {
        courseDir = folders[0].uri;
      } else {
        const picks = folders.map((f) => ({ label: f.name, uri: f.uri }));
        const pick = await vscode.window.showQuickPick(picks, {
          placeHolder: 'Select workspace folder containing course.json',
        });
        if (!pick) return;
        courseDir = pick.uri;
      }
      await openCourse(courseDir, extensionUri, globalState);
    }),
  );

  // Create a new course scaffold
  context.subscriptions.push(
    vscode.commands.registerCommand('instrktrAuthor.newCourse', async () => {
      const title = await vscode.window.showInputBox({
        prompt: 'Course title',
        placeHolder: 'My Awesome Course',
        validateInput: (v) => (v.trim() ? undefined : 'Title cannot be empty'),
      });
      if (!title) return;

      const suggestedId = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const id = await vscode.window.showInputBox({
        prompt: 'Course ID (used as directory name and registry key)',
        value: suggestedId,
        validateInput: (v) =>
          /^[a-z0-9][a-z0-9-]*$/.test(v)
            ? undefined
            : 'Use lowercase letters, numbers, and hyphens only',
      });
      if (!id) return;

      const description = await vscode.window.showInputBox({
        prompt: 'Course description (optional)',
        placeHolder: 'A short description shown in the registry',
      });

      const parentUris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: 'Choose parent directory for the new course',
        openLabel: 'Create Here',
      });
      if (!parentUris || parentUris.length === 0) return;

      const courseDir = vscode.Uri.joinPath(parentUris[0], id);

      await createCourseScaffold(courseDir, id, title, description ?? '');

      const answer = await vscode.window.showInformationMessage(
        `Course "${title}" created at ${courseDir.fsPath}`,
        'Open in Editor',
        'Open Folder',
      );

      if (answer === 'Open in Editor') {
        await openCourse(courseDir, extensionUri, globalState);
      } else if (answer === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder', courseDir, {
          forceNewWindow: false,
        });
      }
    }),
  );
}

async function openCourse(
  courseDir: vscode.Uri,
  extensionUri: vscode.Uri,
  globalState: vscode.Memento,
): Promise<void> {
  // Validate that course.json exists
  const mgr = new CourseFileManager(courseDir);
  try {
    await mgr.readCourse();
  } catch {
    const answer = await vscode.window.showErrorMessage(
      `No course.json found in ${courseDir.fsPath}. This doesn't look like an Instrktr course folder.`,
      'Pick Another Folder',
    );
    if (answer === 'Pick Another Folder') {
      vscode.commands.executeCommand('instrktrAuthor.openCourse');
    }
    return;
  }

  await CourseAuthorPanel.createOrShow(extensionUri, courseDir, globalState);
}

async function createCourseScaffold(
  courseDir: vscode.Uri,
  id: string,
  title: string,
  description: string,
): Promise<void> {
  await vscode.workspace.fs.createDirectory(courseDir);

  const write = async (relPath: string, content: string) => {
    const uri = vscode.Uri.joinPath(courseDir, relPath);
    const parent = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
  };

  const course = {
    id,
    title,
    version: '1.0.0',
    engineVersion: '>=0.1.0',
    description,
    steps: [
      {
        id: 'first-step',
        title: 'First Step',
        instructions: 'steps/01-first-step/instructions.md',
        hints: [],
        validator: 'steps/01-first-step/validate.js',
      },
    ],
  };

  await write('course.json', JSON.stringify(course, null, 2) + '\n');

  await write(
    'steps/01-first-step/instructions.md',
    `# First Step\n\nDescribe what the learner should do in this step.\n\n## Your task\n\nTODO: Add your instructions here.\n\nOnce done, click **Check Work** to continue.\n`,
  );

  await write(
    'steps/01-first-step/validate.js',
    `module.exports = async function validate(context) {\n  // TODO: implement your validator\n\n  return context.pass('Great work!');\n};\n`,
  );

  await write(
    '.github/workflows/release.yml',
    `name: Release\n\non:\n  push:\n    branches: [main]\n\njobs:\n  release:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - uses: actions/checkout@v4\n      - name: Read version\n        id: version\n        run: echo "version=$(node -p \\"require('./course.json').version\\")" >> $GITHUB_OUTPUT\n      - name: Create tag\n        env:\n          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n        run: |\n          TAG="v\${{ steps.version.outputs.version }}"\n          git tag \$TAG 2>/dev/null || echo "Tag \$TAG already exists"\n          git push origin \$TAG 2>/dev/null || echo "Tag \$TAG already pushed"\n`,
  );

  await write('.gitignore', 'node_modules/\n*.vsix\n');
}

export function deactivate(): void {}
