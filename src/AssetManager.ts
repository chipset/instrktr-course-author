import * as vscode from 'vscode';
import * as path from 'path';
import { AssetInfo } from './types';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif']);
const ASSETS_DIR = 'assets';

export class AssetManager {
  constructor(private readonly _courseDir: vscode.Uri) {}

  async list(): Promise<AssetInfo[]> {
    const assetsDir = vscode.Uri.joinPath(this._courseDir, ASSETS_DIR);
    try {
      const entries = await vscode.workspace.fs.readDirectory(assetsDir);
      const assets: AssetInfo[] = [];
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) continue;
        const uri = vscode.Uri.joinPath(assetsDir, name);
        const stat = await vscode.workspace.fs.stat(uri);
        const ext = path.extname(name).toLowerCase();
        assets.push({
          filename: name,
          relativePath: `${ASSETS_DIR}/${name}`,
          size: stat.size,
          isImage: IMAGE_EXTS.has(ext),
        });
      }
      return assets.sort((a, b) => a.filename.localeCompare(b.filename));
    } catch {
      return [];
    }
  }

  async import(): Promise<AssetInfo | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Select a file to add to course assets',
      filters: {
        'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico'],
        'All Files': ['*'],
      },
    });
    if (!uris || uris.length === 0) return null;

    const sourceUri = uris[0];
    const filename = path.basename(sourceUri.fsPath);
    const assetsDir = vscode.Uri.joinPath(this._courseDir, ASSETS_DIR);

    await vscode.workspace.fs.createDirectory(assetsDir);

    const destUri = vscode.Uri.joinPath(assetsDir, filename);

    // Ask before overwriting
    try {
      await vscode.workspace.fs.stat(destUri);
      const choice = await vscode.window.showWarningMessage(
        `"${filename}" already exists in assets/. Overwrite?`,
        { modal: true },
        'Overwrite',
      );
      if (choice !== 'Overwrite') return null;
    } catch {
      // File doesn't exist, proceed
    }

    await vscode.workspace.fs.copy(sourceUri, destUri, { overwrite: true });

    const stat = await vscode.workspace.fs.stat(destUri);
    const ext = path.extname(filename).toLowerCase();

    return {
      filename,
      relativePath: `${ASSETS_DIR}/${filename}`,
      size: stat.size,
      isImage: IMAGE_EXTS.has(ext),
    };
  }
}
