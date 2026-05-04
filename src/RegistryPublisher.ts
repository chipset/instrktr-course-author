import * as vscode from 'vscode';
import { CourseDef, PublishHistoryEntry } from './types';
import { logError } from './logger';

const MAX_HISTORY = 20;

const API = 'https://api.github.com';
const REGISTRY_GIST_FILENAME = 'instrktr-registry.json';
const REGISTRY_GIST_DESCRIPTION = 'Instrktr — personal course registry';
const REQUEST_TIMEOUT_MS = 15_000;

export interface PublishFileSnapshot {
  path: string;
  contentBase64: string;
}

interface RegistryEntry {
  id: string;
  title: string;
  description: string;
  repo: string;
  latestVersion: string;
  tags: string[];
}

export class RegistryPublisher {
  private _registryGistId: string | undefined;

  constructor(private readonly _globalState: vscode.Memento) {
    this._registryGistId = this._globalState.get<string>('authorRegistryGistId');
  }

  getHistory(): PublishHistoryEntry[] {
    return this._globalState.get<PublishHistoryEntry[]>('publishHistory', []);
  }

  async publish(
    course: CourseDef,
    repo: string,
    tags: string[],
    token: string,
    files: PublishFileSnapshot[],
    createRepo: boolean,
    registryRepo: string | undefined,
    registryPath: string | undefined,
    onProgress: (msg: string) => void,
  ): Promise<string> {
    // 1. Commit the local course snapshot, then create the release tag on that commit.
    onProgress(`Publishing ${files.length} files to ${repo}…`);
    const commitSha = await this._commitFilesToDefaultBranch(token, repo, course.version, files, createRepo, course);
    onProgress(`Ensuring git tag v${course.version} points at published files…`);
    await this._ensureTag(token, repo, course.version, commitSha);
    onProgress(`Creating release v${course.version} on ${repo}…`);
    const releaseHtmlUrl = await this._createRelease(token, repo, course.version);
    onProgress(`Release: ${releaseHtmlUrl}`);

    // 2. Update personal registry Gist
    onProgress('Updating registry Gist…');
    let registryUrl = await this._upsertRegistry(token, course, repo, tags);
    if (registryRepo) {
      onProgress(`Updating registry repo ${registryRepo}…`);
      registryUrl = await this._upsertRegistryRepo(token, registryRepo, registryPath || REGISTRY_GIST_FILENAME, course, repo, tags);
    }

    // 3. Persist to history
    await this._recordHistory({ version: course.version, date: new Date().toISOString(), repo, registryUrl });

    return registryUrl;
  }

  private async _commitFilesToDefaultBranch(
    token: string,
    repo: string,
    version: string,
    files: PublishFileSnapshot[],
    createRepo: boolean,
    course: CourseDef,
  ): Promise<string> {
    if (files.length === 0) {
      throw new Error('No course files found to publish.');
    }

    const repoInfo = await this._ensureRepo(token, repo, createRepo, course) as { default_branch: string };
    const defaultBranch = repoInfo.default_branch;

    let headSha: string | undefined;
    let baseTreeSha: string | undefined;
    try {
      const head = await this._request(
        'GET',
        `/repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
        token,
      ) as { object: { sha: string } };
      headSha = head.object.sha;
      const baseCommit = await this._request(
        'GET',
        `/repos/${repo}/git/commits/${headSha}`,
        token,
      ) as { tree: { sha: string } };
      baseTreeSha = baseCommit.tree.sha;
    } catch (err) {
      if (!this._isNotFound(err)) throw err;
    }

    const tree = [];
    for (const file of files) {
      const blob = await this._request('POST', `/repos/${repo}/git/blobs`, token, {
        content: file.contentBase64,
        encoding: 'base64',
      }) as { sha: string };
      tree.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }

    const createdTree = await this._request('POST', `/repos/${repo}/git/trees`, token, {
      tree,
    }) as { sha: string };

    if (headSha && createdTree.sha === baseTreeSha) {
      return headSha;
    }

    const commitBody: { message: string; tree: string; parents?: string[] } = {
      message: `Publish course v${version}`,
      tree: createdTree.sha,
    };
    if (headSha) commitBody.parents = [headSha];
    const commit = await this._request('POST', `/repos/${repo}/git/commits`, token, commitBody) as { sha: string };

    if (headSha) {
      await this._request('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(defaultBranch)}`, token, {
        sha: commit.sha,
        force: false,
      });
    } else {
      await this._request('POST', `/repos/${repo}/git/refs`, token, {
        ref: `refs/heads/${defaultBranch}`,
        sha: commit.sha,
      });
    }

    return commit.sha;
  }

  private async _ensureRepo(
    token: string,
    repo: string,
    createRepo: boolean,
    course: CourseDef,
  ): Promise<unknown> {
    try {
      return await this._request('GET', `/repos/${repo}`, token);
    } catch (err) {
      if (!this._isNotFound(err) || !createRepo) throw err;
    }

    const [owner, name] = repo.split('/');
    const username = await this._getUsername(token);
    const body = {
      name,
      description: course.description || course.title,
      private: false,
      auto_init: false,
    };

    if (owner.toLowerCase() === username.toLowerCase()) {
      return this._request('POST', '/user/repos', token, body);
    }

    return this._request('POST', `/orgs/${owner}/repos`, token, body);
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

  private async _ensureTag(
    token: string,
    repo: string,
    version: string,
    targetSha: string,
  ): Promise<void> {
    const tagName = `v${version}`;

    try {
      const existing = await this._request('GET', `/repos/${repo}/git/ref/tags/${encodeURIComponent(tagName)}`, token) as { object: { sha: string } };
      if (existing.object.sha !== targetSha) {
        throw new Error(`Tag ${tagName} already exists but does not point at the published course files. Bump the course version before publishing again.`);
      }
      return;
    } catch (err) {
      if (!this._isNotFound(err)) throw err;
    }

    try {
      await this._request('POST', `/repos/${repo}/git/refs`, token, {
        ref: `refs/tags/${tagName}`,
        sha: targetSha,
      });
    } catch (err) {
      // If another publish created the tag between our GET and POST, treat that as success.
      if (err instanceof GitHubApiError && err.status === 422) {
        const existing = await this._request('GET', `/repos/${repo}/git/ref/tags/${encodeURIComponent(tagName)}`, token) as { object: { sha: string } };
        if (existing.object.sha === targetSha) return;
        throw new Error(`Tag ${tagName} was created but does not point at the published course files. Bump the course version before publishing again.`);
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
    const entry = this._buildRegistryEntry(course, repo, tags);

    // Load existing registry from Gist (if any)
    const gistId = await this._resolveRegistryGistId(token);
    let current: { courses: RegistryEntry[] } = { courses: [] };

    if (gistId) {
      try {
        const gist = await this._request(
          'GET',
          `/gists/${gistId}`,
          token,
        ) as { files: Record<string, { content?: string }>; html_url: string };
        const content = gist.files[REGISTRY_GIST_FILENAME]?.content;
        if (content) {
          current = JSON.parse(content);
        }
      } catch (err) {
        if (this._isNotFound(err)) {
          await this._clearRegistryGistId();
        } else {
          throw err;
        }
      }
    }

    // Upsert the course entry
    const idx = current.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) {
      current.courses[idx] = entry;
    } else {
      current.courses.push(entry);
    }

    const content = JSON.stringify(current, null, 2);

    if (this._registryGistId) {
      await this._request('PATCH', `/gists/${this._registryGistId}`, token, {
        files: { [REGISTRY_GIST_FILENAME]: { content } },
      });
    } else {
      const created = await this._request('POST', '/gists', token, {
        description: REGISTRY_GIST_DESCRIPTION,
        public: true,
        files: { [REGISTRY_GIST_FILENAME]: { content } },
      }) as { id: string };
      this._registryGistId = created.id;
      await this._globalState.update('authorRegistryGistId', this._registryGistId);
    }

    const username = await this._getUsername(token);
    // Canonical raw URL without a commit SHA — always returns latest revision
    return `https://gist.githubusercontent.com/${username}/${this._registryGistId}/raw/${REGISTRY_GIST_FILENAME}`;
  }

  private async _upsertRegistryRepo(
    token: string,
    registryRepo: string,
    registryPath: string,
    course: CourseDef,
    courseRepo: string,
    tags: string[],
  ): Promise<string> {
    const repo = normalizeGitHubRepo(registryRepo);
    if (!repo) throw new Error(`Invalid registry repo: ${registryRepo}`);
    const path = normalizeRegistryPath(registryPath);
    if (!path) throw new Error(`Invalid registry file path: ${registryPath}`);

    const repoInfo = await this._request('GET', `/repos/${repo}`, token) as { default_branch: string };
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    let current: { courses: RegistryEntry[] } = { courses: [] };
    let sha: string | undefined;

    try {
      const existing = await this._request(
        'GET',
        `/repos/${repo}/contents/${encodedPath}`,
        token,
      ) as { content?: string; encoding?: string; sha: string };
      sha = existing.sha;
      if (existing.content && existing.encoding === 'base64') {
        current = JSON.parse(Buffer.from(existing.content.replace(/\s/g, ''), 'base64').toString('utf8'));
      }
    } catch (err) {
      if (!this._isNotFound(err)) throw err;
    }

    const entry = this._buildRegistryEntry(course, courseRepo, tags);
    const idx = current.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) current.courses[idx] = entry;
    else current.courses.push(entry);

    const content = Buffer.from(JSON.stringify(current, null, 2)).toString('base64');
    await this._request('PUT', `/repos/${repo}/contents/${encodedPath}`, token, {
      message: `Update registry for ${course.id} v${course.version}`,
      content,
      ...(sha ? { sha } : {}),
    });

    return `https://raw.githubusercontent.com/${repo}/${repoInfo.default_branch}/${path}`;
  }

  private _buildRegistryEntry(course: CourseDef, repo: string, tags: string[]): RegistryEntry {
    return {
      id: course.id,
      title: course.title,
      description: course.description ?? '',
      repo,
      latestVersion: course.version,
      tags,
    };
  }

  private async _getUsername(token: string): Promise<string> {
    const user = await this._request('GET', '/user', token) as { login: string };
    return user.login;
  }

  private async _resolveRegistryGistId(token: string): Promise<string | undefined> {
    if (this._registryGistId) return this._registryGistId;

    type GistItem = { id: string; files: Record<string, unknown> };
    for (let page = 1; ; page++) {
      const gists = await this._request(
        'GET',
        `/gists?per_page=100&page=${page}`,
        token,
      ) as unknown[];
      if (!Array.isArray(gists) || gists.length === 0) break;

      const found = (gists as GistItem[]).find(
        (g) => REGISTRY_GIST_FILENAME in g.files,
      );
      if (found) {
        this._registryGistId = found.id;
        await this._globalState.update('authorRegistryGistId', this._registryGistId);
        return this._registryGistId;
      }

      if (gists.length < 100) break;
    }
    return undefined;
  }

  private async _clearRegistryGistId(): Promise<void> {
    this._registryGistId = undefined;
    await this._globalState.update('authorRegistryGistId', undefined);
  }

  private _isNotFound(err: unknown): boolean {
    return err instanceof GitHubApiError && err.status === 404;
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

function normalizeGitHubRepo(value: string): string | undefined {
  const trimmed = value.trim();
  const short = trimmed.match(/^([\w.\-]+)\/([\w.\-]+)$/);
  if (short) return `${short[1]}/${short[2]}`;
  const url = trimmed.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return url ? `${url[1]}/${url[2]}` : undefined;
}

function normalizeRegistryPath(value: string): string | undefined {
  const parts = value.trim().split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return undefined;
  return parts.join('/');
}
