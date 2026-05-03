import * as vscode from 'vscode';
import * as path from 'path';
import { CourseDef, StepDef } from './types';

const DEFAULT_VALIDATOR = `module.exports = async function validate(context) {
  // TODO: implement your validator
  // See the Validator tab for available APIs and snippets.

  return context.pass('Great work!');
};
`;

export class CourseFileManager {
  constructor(public courseDir: vscode.Uri) {}

  async readCourse(): Promise<CourseDef> {
    const uri = vscode.Uri.joinPath(this.courseDir, 'course.json');
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as CourseDef;
  }

  async writeCourse(course: CourseDef): Promise<void> {
    const uri = vscode.Uri.joinPath(this.courseDir, 'course.json');
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify(course, null, 2) + '\n'),
    );
  }

  async readFile(filePath: string): Promise<string> {
    const resolved = this._resolve(filePath);
    try {
      const bytes = await vscode.workspace.fs.readFile(resolved);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return '';
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = this._resolve(filePath);
    // Ensure parent directory exists
    const parentPath = resolved.with({ path: resolved.path.replace(/\/[^/]+$/, '') });
    await vscode.workspace.fs.createDirectory(parentPath);
    await vscode.workspace.fs.writeFile(resolved, Buffer.from(content));
  }

  async createStepScaffold(
    stepIndex: number,
    step: StepDef,
  ): Promise<{ instructions: string; validator: string }> {
    const prefix = String(stepIndex + 1).padStart(2, '0');
    const dirName = `${prefix}-${step.id}`;
    const stepDir = vscode.Uri.joinPath(this.courseDir, 'steps', dirName);
    await vscode.workspace.fs.createDirectory(stepDir);

    const instructionsPath = `steps/${dirName}/instructions.md`;
    const validatorPath = `steps/${dirName}/validate.js`;

    await this.writeFile(
      instructionsPath,
      `# ${step.title}\n\nDescribe what the learner should do in this step.\n\n## Your task\n\nTODO: Add your instructions here.\n\nOnce done, click **Check Work** to continue.\n`,
    );
    await this.writeFile(validatorPath, DEFAULT_VALIDATOR);

    return { instructions: instructionsPath, validator: validatorPath };
  }

  async deleteFiles(filePaths: string[]): Promise<void> {
    for (const fp of filePaths) {
      try {
        const resolved = this._resolve(fp);
        await vscode.workspace.fs.delete(resolved, { recursive: true });
      } catch {
        // Ignore missing files
      }
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const oldUri = this._resolve(oldPath);
    const newUri = this._resolve(newPath);
    const parentPath = newUri.with({ path: newUri.path.replace(/\/[^/]+$/, '') });
    await vscode.workspace.fs.createDirectory(parentPath);
    await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: true });
  }

  private _resolve(filePath: string): vscode.Uri {
    // Prevent path traversal: normalize and check prefix
    const joined = vscode.Uri.joinPath(this.courseDir, filePath);
    const relative = path.relative(this.courseDir.fsPath, joined.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path traversal blocked: ${filePath}`);
    }
    return joined;
  }
}
