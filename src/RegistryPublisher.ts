import * as vscode from 'vscode';
import { CourseDef, PublishHistoryEntry } from './types';
import { logError } from './logger';

const MAX_HISTORY = 20;

const API = 'https://api.github.com';
const REGISTRY_GIST_FILENAME = 'instrktr-registry.json';
const REGISTRY_GIST_DESCRIPTION = 'Instrktr — personal course registry';
const REQUEST_TIMEOUT_MS = 15_000;

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
    onProgress: (msg: string) => void,
  ): Promise<string> {
    // 1. Ensure Git tag exists, then create GitHub release
    onProgress(`Ensuring git tag v${course.version} exists on ${repo}…`);
    await this._ensureTag(token, repo, course.version);
    onProgress(`Creating release v${course.version} on ${repo}…`);
    const releaseHtmlUrl = await this._createRelease(token, repo, course.version);
    onProgress(`Release: ${releaseHtmlUrl}`);

    // 2. Update personal registry Gist
    onProgress('Updating registry Gist…');
    const registryUrl = await this._upsertRegistry(token, course, repo, tags);

    // 3. Persist to history
    await this._recordHistory({ version: course.version, date: new Date().toISOString(), repo, registryUrl });

    return registryUrl;
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
  ): Promise<void> {
    const tagName = `v${version}`;

    try {
      await this._request('GET', `/repos/${repo}/git/ref/tags/${tagName}`, token);
      return;
    } catch (err) {
      if (!this._isNotFound(err)) throw err;
    }

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

    // Load existing registry from Gist (if any)
    const gistId = await this._resolveRegistryGistId(token);
    let current: { courses: typeof entry[] } = { courses: [] };

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
