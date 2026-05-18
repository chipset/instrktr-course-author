import * as vscode from 'vscode';
import * as path from 'path';
import { CourseDef, PublishHistoryEntry } from './types';
import { logError } from './logger';

const MAX_HISTORY = 20;

const API = 'https://api.github.com';
const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/chipset/instrktr-registry/refs/heads/main/registry.json';
const REQUEST_TIMEOUT_MS = 15_000;

export class RegistryPublisher {
  constructor(private readonly _globalState: vscode.Memento) {}

  getHistory(): PublishHistoryEntry[] {
    return this._globalState.get<PublishHistoryEntry[]>('publishHistory', []);
  }

  async publish(
    course: CourseDef,
    repo: string,
    tags: string[],
    token: string,
    courseDir: vscode.Uri,
    onProgress: (msg: string) => void,
  ): Promise<string> {
    // 1. Sync course files, ensure Git tag exists, then create GitHub release
    onProgress(`Uploading course files to ${repo}…`);
    await this._syncCourseFiles(token, repo, courseDir, course.version, onProgress);
    onProgress(`Ensuring git tag v${course.version} exists on ${repo}…`);
    await this._ensureTag(token, repo, course.version);
    onProgress(`Creating release v${course.version} on ${repo}…`);
    const releaseHtmlUrl = await this._createRelease(token, repo, course.version);
    onProgress(`Release: ${releaseHtmlUrl}`);

    // 2. Update personal registry
    onProgress('Updating registry…');
    const registryUrl = await this._upsertRegistry(token, course, repo, tags);

    // 3. Persist to history
    await this._recordHistory({ version: course.version, date: new Date().toISOString(), repo, registryUrl });

    return registryUrl;
  }

  async repositoryExists(token: string, repo: string): Promise<boolean> {
    try {
      await this._request('GET', `/repos/${repo}`, token);
      return true;
    } catch (err) {
      if (this._isNotFound(err)) return false;
      throw err;
    }
  }

  async createRepository(
    token: string,
    repo: string,
    course: CourseDef,
  ): Promise<void> {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error('Repository must use owner/repo-name format.');
    }

    const user = await this._request('GET', '/user', token) as { login: string };
    const path = owner.toLowerCase() === user.login.toLowerCase()
      ? '/user/repos'
      : `/orgs/${encodeURIComponent(owner)}/repos`;

    await this._request('POST', path, token, {
      name,
      description: course.description || course.title,
      private: false,
      auto_init: true,
    });
  }

  private async _recordHistory(entry: PublishHistoryEntry): Promise<void> {
    const history = this.getHistory();
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await this._globalState.update('publishHistory', history);
  }

  private async _createRelease(
    token: string,
    repo: string,
    version: string,
  ): Promise<string> {
    const tagName = `v${version}`;

    // If a release already exists for this tag, return it
    try {
      const existing = await this._request(
        'GET',
        `/repos/${repo}/releases/tags/${tagName}`,
        token,
      ) as { html_url: string };
      return existing.html_url;
    } catch (err) {
      if (!this._isNotFound(err)) throw err;
    }

    const created = await this._request('POST', `/repos/${repo}/releases`, token, {
      tag_name: tagName,
      name: `v${version}`,
      body: `Course release v${version}`,
      draft: false,
      prerelease: false,
    }) as { html_url: string };

    return created.html_url;
  }

  private async _syncCourseFiles(
    token: string,
    repo: string,
    courseDir: vscode.Uri,
    version: string,
    onProgress: (msg: string) => void,
  ): Promise<void> {
    const files = await this._listCourseFiles(courseDir);
    if (!files.some((file) => file.relativePath === 'course.json')) {
      throw new Error(`No course.json found in ${courseDir.fsPath}.`);
    }

    let uploaded = 0;
    for (const file of files) {
      await this._putRepositoryFile(
        token,
        repo,
        file.relativePath,
        file.content,
        `Publish course files for v${version}`,
      );
      uploaded += 1;
      if (uploaded === files.length || uploaded % 5 === 0) {
        onProgress(`Uploaded ${uploaded}/${files.length} course files…`);
      }
    }
  }

  private async _putRepositoryFile(
    token: string,
    repo: string,
    filePath: string,
    content: Uint8Array,
    message: string,
  ): Promise<void> {
    const repoInfo = await this._request('GET', `/repos/${repo}`, token) as { default_branch: string };
    const branch = repoInfo.default_branch;
    let sha: string | undefined;

    try {
      const existing = await this._request(
        'GET',
        `/repos/${repo}/contents/${encodeURIComponentPath(filePath)}?ref=${encodeURIComponent(branch)}`,
        token,
      ) as { sha: string };
      sha = existing.sha;
    } catch (err) {
      if (!this._isNotFound(err)) throw err;
    }

    await this._request('PUT', `/repos/${repo}/contents/${encodeURIComponentPath(filePath)}`, token, {
      message,
      branch,
      content: Buffer.from(content).toString('base64'),
      ...(sha ? { sha } : {}),
    });
  }

  private async _listCourseFiles(courseDir: vscode.Uri): Promise<{ relativePath: string; content: Uint8Array }[]> {
    const files: { relativePath: string; content: Uint8Array }[] = [];
    await this._collectCourseFiles(courseDir, courseDir, files);
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private async _collectCourseFiles(
    courseDir: vscode.Uri,
    dir: vscode.Uri,
    files: { relativePath: string; content: Uint8Array }[],
  ): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      if (this._shouldSkipCourseFile(name)) continue;

      const uri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        await this._collectCourseFiles(courseDir, uri, files);
      } else if (type === vscode.FileType.File) {
        files.push({
          relativePath: path.relative(courseDir.fsPath, uri.fsPath).split(path.sep).join('/'),
          content: await vscode.workspace.fs.readFile(uri),
        });
      }
    }
  }

  private _shouldSkipCourseFile(name: string): boolean {
    return ['.git', '.DS_Store', 'node_modules', 'dist', 'out'].includes(name);
  }

  private async _ensureTag(
    token: string,
    repo: string,
    version: string,
  ): Promise<void> {
    const tagName = `v${version}`;

    const repoInfo = await this._request(
      'GET',
      `/repos/${repo}`,
      token,
    ) as { default_branch: string };
    const defaultBranch = repoInfo.default_branch;

    const head = await this._request(
      'GET',
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      token,
    ) as { object: { sha: string } };

    try {
      await this._request('PATCH', `/repos/${repo}/git/refs/tags/${tagName}`, token, {
        sha: head.object.sha,
        force: true,
      });
      return;
    } catch (err) {
      if (this._isEmptyRepository(err)) {
        throw new Error(
          `Repository ${repo} is empty. Add an initial commit or let Instrktr create the repository before publishing.`,
        );
      }
      if (!this._isNotFound(err)) throw err;
    }

    try {
      await this._request('POST', `/repos/${repo}/git/refs`, token, {
        ref: `refs/tags/${tagName}`,
        sha: head.object.sha,
      });
    } catch (err) {
      // If another publish created the tag between our GET and POST, treat that as success.
      if (err instanceof GitHubApiError && err.status === 422) {
        await this._request('GET', `/repos/${repo}/git/ref/tags/${tagName}`, token);
        return;
      }
      throw err;
    }
  }

  private async _upsertRegistry(
    token: string,
    course: CourseDef,
    repo: string,
    tags: string[],
  ): Promise<string> {
    const entry = {
      id: course.id,
      title: course.title,
      description: course.description ?? '',
      repo,
      latestVersion: course.version,
      tags,
    };

    const registry = this._getRegistryTarget();
    let current: { courses: typeof entry[] } = { courses: [] };
    let sha: string | undefined;

    try {
      const existing = await this._request(
        'GET',
        `/repos/${registry.repo}/contents/${encodeURIComponentPath(registry.path)}?ref=${encodeURIComponent(registry.branch)}`,
        token,
      ) as { content?: string; encoding?: string; sha: string };
      sha = existing.sha;
      if (existing.content && existing.encoding === 'base64') {
        current = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
      }
    } catch (err) {
      if (!this._isNotFound(err)) throw err;
    }

    // Upsert the course entry
    const idx = current.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) {
      current.courses[idx] = entry;
    } else {
      current.courses.push(entry);
    }

    const content = JSON.stringify(current, null, 2);

    await this._request('PUT', `/repos/${registry.repo}/contents/${encodeURIComponentPath(registry.path)}`, token, {
      message: `Publish ${course.id} v${course.version}`,
      branch: registry.branch,
      content: Buffer.from(`${content}\n`, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    });

    return registry.rawUrl;
  }

  private _getRegistryTarget(): RegistryTarget {
    const rawUrl = vscode.workspace
      .getConfiguration('instrktrAuthor')
      .get<string>('registryUrl', DEFAULT_REGISTRY_URL)
      .trim() || DEFAULT_REGISTRY_URL;
    return parseRegistryUrl(rawUrl);
  }

  private _isNotFound(err: unknown): boolean {
    return err instanceof GitHubApiError && err.status === 404;
  }

  private _isEmptyRepository(err: unknown): boolean {
    return err instanceof GitHubApiError && err.status === 409;
  }

  private async _request(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new GitHubApiError(res.status, method, path);
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(`GitHub API ${method} ${path} → ${status}`);
  }
}

interface RegistryTarget {
  rawUrl: string;
  repo: string;
  branch: string;
  path: string;
}

function parseRegistryUrl(rawUrl: string): RegistryTarget {
  const url = new URL(rawUrl);

  if (url.hostname === 'raw.githubusercontent.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const [owner, repo] = parts;
    if (!owner || !repo) throw new Error(`Unsupported registry URL: ${rawUrl}`);

    if (parts[2] === 'refs' && parts[3] === 'heads') {
      const branch = parts[4];
      const path = parts.slice(5).join('/');
      if (!branch || !path) throw new Error(`Unsupported registry URL: ${rawUrl}`);
      return { rawUrl, repo: `${owner}/${repo}`, branch, path };
    }

    const branch = parts[2];
    const path = parts.slice(3).join('/');
    if (!branch || !path) throw new Error(`Unsupported registry URL: ${rawUrl}`);
    return { rawUrl, repo: `${owner}/${repo}`, branch, path };
  }

  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const [owner, repo, blob, branch] = parts;
    const path = parts.slice(4).join('/');
    if (!owner || !repo || blob !== 'blob' || !branch || !path) {
      throw new Error(`Unsupported registry URL: ${rawUrl}`);
    }
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${branch}/${path}`,
      repo: `${owner}/${repo}`,
      branch,
      path,
    };
  }

  throw new Error(`Unsupported registry URL: ${rawUrl}`);
}

function encodeURIComponentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
