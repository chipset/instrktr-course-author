import type {
  CourseDef, StepDef, AuthState, AssetInfo, PublishHistoryEntry,
  ValidatorTestResult, WebviewMessage, ExtensionMessage, FileWrite, CustomSnippet, AuthorSettings,
} from '../src/types';
import { SNIPPET_LIBRARY, SnippetCategory, LibrarySnippet } from './snippetLibrary';
import { STEP_TEMPLATES, StepTemplate } from './stepTemplates';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): AppState | undefined;
  setState(state: AppState): void;
};

// ─── Persisted state ────────────────────────────────────────────────────────

interface AppState {
  course: CourseDef | null;
  selectedStep: number;
  activeTab: 'instructions' | 'validator' | 'starter' | 'solution' | 'meta';
  auth: AuthState;
  isDirty: boolean;
  assets: AssetInfo[];
  publishHistory: PublishHistoryEntry[];
  customSnippets: CustomSnippet[];
}

// ─── Transient (non-persisted) UI state ─────────────────────────────────────

let validatorRunning = false;
let validatorResult: ValidatorTestResult | null = null;
let showLibrary = false;
let libraryCategory = SNIPPET_LIBRARY[0]?.id ?? '';
let librarySearch = '';
let showImport = false;
let courseSearch = '';
let publishRepoSuggestion = '';
const pendingDeletedSteps: StepDef[] = [];
const undoStack: CourseDef[] = [];
const previewProgress: Record<string, ValidatorTestResult['status']> = {};
let authorSettings: AuthorSettings = {
  syntaxStatus: 'always',
  syntaxHighlighting: true,
  defaultRegistryRepo: '',
  defaultRegistryPath: 'instrktr-registry.json',
};
let publishPanelVisible = false;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const vscode = acquireVsCodeApi();

let state: AppState = vscode.getState() ?? {
  course: null,
  selectedStep: -1,
  activeTab: 'instructions',
  auth: { signedIn: false },
  isDirty: false,
  assets: [],
  publishHistory: [],
  customSnippets: [],
};

const fileCache: Record<string, string> = {};
const pendingFileRequests = new Map<string, (content: string) => void>();
const pendingFileWrites = new Map<string, string>();
const pendingDeletedFilePaths = new Set<string>();
const pendingRenames = new Map<string, {
  oldPath: string;
  newPath: string;
  kind: 'asset' | 'step-file';
  stepIndex?: number;
  fileKind?: 'starter' | 'solution';
  oldContent?: string;
}>();
let requestCounter = 0;
let dragSourceIndex = -1;
const renderedSnippetCode = new Map<string, string>();

// ─── Message bus: extension → webview ────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ExtensionMessage;
  switch (msg.command) {
    case 'setCourse':
      state = { ...state, course: msg.course, isDirty: false };
      pendingDeletedFilePaths.clear();
      pendingDeletedSteps.length = 0;
      if (state.selectedStep >= msg.course.steps.length) state.selectedStep = msg.course.steps.length - 1;
      if (state.selectedStep < 0 && msg.course.steps.length > 0) state.selectedStep = 0;
      saveState();
      render();
      break;

    case 'saveResult':
      if (msg.success) {
        pendingFileWrites.clear();
        pendingDeletedFilePaths.clear();
        pendingDeletedSteps.length = 0;
        state.isDirty = false;
        saveState();
        const saveBtn = document.getElementById('save-btn') as HTMLButtonElement | null;
        if (saveBtn) saveBtn.disabled = true;
        document.querySelector('.dirty-badge')?.remove();
      } else {
        state.isDirty = true;
        saveState();
        const saveBtn = document.getElementById('save-btn') as HTMLButtonElement | null;
        if (saveBtn) saveBtn.disabled = false;
        if (msg.message) showError(msg.message);
      }
      break;

    case 'fileContent': {
      fileCache[msg.filePath] = msg.content;
      const resolve = pendingFileRequests.get(msg.requestId);
      if (resolve) { pendingFileRequests.delete(msg.requestId); resolve(msg.content); }
      break;
    }

    case 'renameResult':
      handleRenameResult(msg);
      break;

    case 'scaffoldResult': {
      if (!state.course) break;
      const step = state.course.steps[msg.stepIndex];
      if (step) { step.instructions = msg.instructions; step.validator = msg.validator; }
      state.isDirty = true;
      saveState();
      render();
      break;
    }

    case 'setAuth':
      state = { ...state, auth: msg.auth };
      saveState();
      renderAuthBar();
      break;

    case 'setPublishRepo': {
      publishRepoSuggestion = msg.repo;
      const repoInput = document.getElementById('pub-repo') as HTMLInputElement | null;
      if (repoInput && !repoInput.value.trim()) repoInput.value = msg.repo;
      break;
    }

    case 'publishProgress':
      handlePublishProgressMsg(msg.status, msg.message, msg.registryUrl);
      break;

    case 'setPublishHistory':
      state.publishHistory = msg.history;
      saveState();
      refreshPublishHistory();
      break;

    case 'setRepos':
      void fillRepoPicker(msg.repos);
      break;

    case 'setWorkspaceCourses':
      void showCourseSwitcher(msg.courses);
      break;

    case 'setCustomSnippets':
      state.customSnippets = msg.snippets;
      saveState();
      if (showLibrary) render();
      break;

    case 'setSettings':
      authorSettings = msg.settings;
      updateSettingsFields();
      updateSyntaxStatus('validator');
      updateSyntaxStatus('starter');
      updateSyntaxStatus('solution');
      break;

    // Feature 1 – validator testing
    case 'validatorResult':
      validatorRunning = false;
      validatorResult = msg.result;
      refreshValidatorResult();
      break;

    // Feature 4 – assets
    case 'assetList':
      state.assets = msg.assets;
      saveState();
      refreshAssetList();
      break;

    case 'assetImported':
      // assetList will be sent right after by the extension
      break;

    // Feature 5 – import
    case 'importProgress':
      handleImportProgressMsg(msg.status, msg.message);
      break;

    case 'importComplete':
      showImport = false;
      setTimeout(() => validateCourse(), 300);
      break;

    case 'error':
      showError(msg.message);
      break;
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(msg: WebviewMessage): void { vscode.postMessage(msg); }
function saveState(): void { vscode.setState(state); }

function readFile(filePath: string): Promise<string> {
  if (fileCache[filePath] !== undefined) return Promise.resolve(fileCache[filePath]);
  return new Promise((resolve) => {
    const requestId = String(requestCounter++);
    pendingFileRequests.set(requestId, resolve);
    post({ command: 'readFile', requestId, filePath });
  });
}

function queueFileWrite(filePath: string, content: string): void {
  fileCache[filePath] = content;
  pendingFileWrites.set(filePath, content);
}

function collectPendingFileWrites(currentTabWrites: FileWrite[] = []): FileWrite[] {
  const merged = new Map<string, string>(pendingFileWrites);
  for (const write of currentTabWrites) merged.set(write.filePath, write.content);
  return [...merged.entries()].map(([filePath, content]) => ({ filePath, content }));
}

function loadFileIntoTextarea(
  filePath: string,
  textarea: HTMLTextAreaElement,
  transform: (content: string) => string = (content) => content,
  onLoaded?: () => void,
): void {
  const valueAtRequest = textarea.value;
  readFile(filePath).then((content) => {
    if (!document.contains(textarea) || textarea.value !== valueAtRequest) return;
    textarea.value = transform(content);
    onLoaded?.();
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const elem = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') elem.className = v;
    else elem.setAttribute(k, v);
  }
  for (const child of children) elem.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return elem;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolvePreviewAssetUri(src: string): string {
  const unescaped = src.replace(/&amp;/g, '&');
  if (/^(?:https?:|data:|vscode-resource:|vscode-webview-resource:)/i.test(unescaped)) {
    return src;
  }
  const normalized = unescaped.replace(/^\.\//, '');
  const asset = state.assets.find((a) => a.relativePath === normalized);
  return asset?.webviewUri ? escapeHtml(asset.webviewUri) : src;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

function markDirty(): void {
  if (!state.isDirty) {
    state.isDirty = true;
    saveState();
    const saveBtn = document.getElementById('save-btn') as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = false;
    const left = document.querySelector('.toolbar-left');
    if (left && !left.querySelector('.dirty-badge')) {
      left.appendChild(el('span', { class: 'dirty-badge' }, 'Unsaved'));
    }
  }
}

function pushUndo(): void {
  if (state.course) undoStack.push(JSON.parse(JSON.stringify(state.course)) as CourseDef);
  if (undoStack.length > 20) undoStack.shift();
}

function showError(message: string): void {
  document.getElementById('error-bar')?.remove();
  const bar = el('div', { class: 'error-bar', id: 'error-bar' });
  bar.appendChild(el('span', {}, message));
  const dismiss = el('button', { class: 'btn btn-ghost btn-sm' }, 'Dismiss');
  dismiss.onclick = () => bar.remove();
  bar.appendChild(dismiss);
  document.getElementById('root')?.prepend(bar);
  setTimeout(() => bar.remove(), 8_000);
}

function postRenameFile(
  oldPath: string,
  newPath: string,
  pending: Omit<NonNullable<ReturnType<typeof pendingRenames.get>>, 'oldPath' | 'newPath'>,
): void {
  const requestId = `rename-${requestCounter++}`;
  pendingRenames.set(requestId, { ...pending, oldPath, newPath });
  post({ command: 'renameFile', requestId, oldPath, newPath });
}

function handleRenameResult(msg: Extract<ExtensionMessage, { command: 'renameResult' }>): void {
  const pending = msg.requestId ? pendingRenames.get(msg.requestId) : undefined;
  if (msg.requestId) pendingRenames.delete(msg.requestId);
  if (msg.success) return;

  const rollback = pending ?? { oldPath: msg.oldPath, newPath: msg.newPath, kind: 'step-file' as const };
  if (rollback.kind === 'asset') {
    const asset = state.assets.find((a) => a.relativePath === rollback.newPath);
    if (asset) {
      asset.relativePath = rollback.oldPath;
      asset.filename = rollback.oldPath.split('/').pop() ?? rollback.oldPath;
    }
    refreshAssetList();
  } else if (state.course && rollback.stepIndex !== undefined && rollback.fileKind) {
    const step = state.course.steps[rollback.stepIndex];
    if (step?.[rollback.fileKind] === rollback.newPath) {
      step[rollback.fileKind] = rollback.oldPath;
      if (rollback.oldContent !== undefined) fileCache[rollback.oldPath] = rollback.oldContent;
      delete fileCache[rollback.newPath];
      render();
    }
  }
  showError(msg.message ?? `Rename failed: ${rollback.oldPath}`);
}

// ─── Markdown renderer ───────────────────────────────────────────────────────

function renderMarkdown(md: string): string {
  let html = escapeHtml(md);
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
  html = html.replace(/((?:\|.+\|\n)+\|(?:\s*:?-+:?\s*\|)+\n(?:\|.+\|\n?)+)/g, (table) => {
    const rows = table.trim().split('\n').filter((_, i) => i !== 1).map((row) =>
      `<tr>${row.split('|').slice(1, -1).map((cell) => `<td>${cell.trim()}</td>`).join('')}</tr>`);
    return `<table>${rows.join('')}</table>`;
  });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^######\s(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s(.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
    `<img src="${resolvePreviewAssetUri(src)}" alt="${alt}" class="markdown-image">`,
  );
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  html = html.replace(/^(?:(?:[-*]\s(?:\[(?: |x)]\s)?|\d+\.\s).+(?:\n|$))+/gmi, renderMarkdownListBlock);
  html = html.split(/\n\n+/).map((p) =>
    p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<ol') || p.startsWith('<pre') || p.startsWith('<table') ? p
      : `<p>${p.replace(/\n/g, '<br>')}</p>`,
  ).join('\n');
  return `<div class="markdown-preview">${html}</div>`;
}

function renderMarkdownListBlock(block: string): string {
  const lines = block.trimEnd().split('\n');
  const parts: string[] = [];
  let currentTag: 'ul' | 'ol' | null = null;

  const open = (tag: 'ul' | 'ol') => {
    if (currentTag === tag) return;
    if (currentTag) parts.push(`</${currentTag}>`);
    parts.push(`<${tag}>`);
    currentTag = tag;
  };

  for (const line of lines) {
    const ordered = line.match(/^\d+\.\s(.+)$/);
    if (ordered) {
      open('ol');
      parts.push(`<li>${ordered[1]}</li>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s(?:\[( |x)]\s)?(.+)$/i);
    if (unordered) {
      open('ul');
      const checkbox = unordered[1] === undefined
        ? ''
        : `<input type="checkbox" disabled${unordered[1].toLowerCase() === 'x' ? ' checked' : ''}> `;
      parts.push(`<li>${checkbox}${unordered[2]}</li>`);
    }
  }

  if (currentTag) parts.push(`</${currentTag}>`);
  return parts.join('\n');
}

// ─── Main render ─────────────────────────────────────────────────────────────

function render(): void {
  const root = document.getElementById('root');
  if (!root) return;
  if (!state.course) { root.innerHTML = '<div class="loading">Loading course…</div>'; return; }
  root.innerHTML = '';
  root.appendChild(buildLayout());
  attachEventListeners();
  // Reset transient validator state after full re-render
  validatorRunning = false;
  validatorResult = null;
}

function buildLayout(): HTMLElement {
  const layout = el('div', { class: 'layout' });
  layout.appendChild(buildToolbar());
  const body = el('div', { class: 'body' });
  body.appendChild(buildSidebar());
  body.appendChild(buildEditorPanel());
  layout.appendChild(body);
  layout.appendChild(buildPublishPanel());
  layout.appendChild(buildImportPanel());
  return layout;
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function buildToolbar(): HTMLElement {
  const course = state.course!;
  const toolbar = el('div', { class: 'toolbar' });

  const left = el('div', { class: 'toolbar-left' });
  left.appendChild(el('span', { class: 'course-title-label' }, course.title));
  if (state.isDirty) left.appendChild(el('span', { class: 'dirty-badge' }, 'Unsaved'));
  toolbar.appendChild(left);

  const right = el('div', { class: 'toolbar-right' });
  const saveBtn = el('button', { class: 'btn btn-primary', id: 'save-btn' }, 'Save');
  if (!state.isDirty) saveBtn.setAttribute('disabled', 'true');
  right.appendChild(saveBtn);

  // Feature 2 – preview button
  right.appendChild(el('button', { class: 'btn btn-secondary', id: 'validate-btn', title: 'Validate course structure' }, 'Validate'));
  right.appendChild(el('button', { class: 'btn btn-secondary', id: 'schema-btn', title: 'Export course schema' }, 'Schema'));
  right.appendChild(el('button', { class: 'btn btn-secondary', id: 'readme-btn', title: 'Generate learner README.md' }, 'README'));
  right.appendChild(el('button', { class: 'btn btn-secondary', id: 'sample-btn', title: 'Generate sample course' }, 'Sample'));
  right.appendChild(el('button', { class: 'btn btn-secondary', id: 'renumber-btn', title: 'Renumber step folders to match order' }, 'Renumber'));
  right.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'undo-btn', title: 'Undo last structural action' }, 'Undo'));
  right.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'switch-course-btn', title: 'Switch course in workspace' }, 'Courses'));
  right.appendChild(el('button', { class: 'btn btn-secondary', id: 'preview-btn', title: 'Preview course as a learner' }, 'Preview'));
  right.appendChild(el('button', { class: 'btn btn-secondary', id: 'publish-btn' }, 'Publish…'));
  right.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'import-btn', title: 'Import a course' }, 'Import…'));

  const authArea = el('div', { class: 'auth-area', id: 'auth-area' });
  renderAuthContent(authArea);
  right.appendChild(authArea);
  toolbar.appendChild(right);
  return toolbar;
}

function renderAuthBar(): void {
  const area = document.getElementById('auth-area');
  if (area) renderAuthContent(area);
}

function renderAuthContent(container: HTMLElement): void {
  container.innerHTML = '';
  if (state.auth.signedIn) {
    container.appendChild(el('span', { class: 'auth-name' }, `@${state.auth.username ?? 'github'}`));
    const so = el('button', { class: 'btn btn-ghost btn-sm' }, 'Sign out');
    so.onclick = () => post({ command: 'signOut' });
    container.appendChild(so);
  } else {
    const si = el('button', { class: 'btn btn-secondary btn-sm' }, 'Sign in with GitHub');
    si.onclick = () => post({ command: 'signIn' });
    container.appendChild(si);
  }
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function buildSidebar(): HTMLElement {
  const sidebar = el('div', { class: 'sidebar' });
  sidebar.appendChild(buildCourseMetaSection());
  sidebar.appendChild(buildStepsSection());
  sidebar.appendChild(buildAssetsSection());
  return sidebar;
}

function buildCourseMetaSection(): HTMLElement {
  const course = state.course!;
  const section = el('div', { class: 'section course-meta-section' });
  const header = el('div', { class: 'section-header collapsible', id: 'meta-header' });
  header.appendChild(el('span', {}, 'Course Settings'));
  header.appendChild(el('span', { class: 'chevron' }, '▾'));
  section.appendChild(header);

  const body = el('div', { class: 'section-body', id: 'meta-body' });
  for (const f of [
    { label: 'Title', id: 'meta-title', value: course.title, placeholder: 'My Course' },
    { label: 'ID', id: 'meta-id', value: course.id, placeholder: 'my-course' },
    { label: 'Version', id: 'meta-version', value: course.version, placeholder: '1.0.0' },
    { label: 'Engine', id: 'meta-engine', value: course.engineVersion, placeholder: '>=0.1.0' },
    { label: 'Description', id: 'meta-description', value: course.description ?? '', placeholder: 'Short description…' },
    { label: 'Default Registry Repo', id: 'settings-default-registry-repo', value: authorSettings.defaultRegistryRepo, placeholder: 'owner/registry-repo or GitHub URL' },
    { label: 'Default Registry File', id: 'settings-default-registry-path', value: authorSettings.defaultRegistryPath, placeholder: 'instrktr-registry.json' },
  ]) {
    const row = el('div', { class: 'field-row' });
    row.appendChild(el('label', { for: f.id, class: 'field-label' }, f.label));
    if (f.id === 'meta-description') {
      const ta = el('textarea', { id: f.id, class: 'field-input', rows: '2', placeholder: f.placeholder });
      ta.value = f.value; row.appendChild(ta);
    } else {
      const input = el('input', { id: f.id, class: 'field-input', type: 'text', placeholder: f.placeholder });
      input.value = f.value; row.appendChild(input);
    }
    body.appendChild(row);
  }
  section.appendChild(body);
  return section;
}

function buildStepsSection(): HTMLElement {
  const course = state.course!;
  const section = el('div', { class: 'section steps-section' });
  const header = el('div', { class: 'section-header' });
  header.appendChild(el('span', {}, `Steps (${course.steps.length})`));
  const addBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-action': 'add-step', title: 'Add step' }, '+ Add');
  header.appendChild(addBtn);
  section.appendChild(header);

  const search = el('input', { id: 'course-search', class: 'field-input course-search', type: 'search', placeholder: 'Search course…' });
  search.value = courseSearch;
  section.appendChild(search);
  section.appendChild(el('div', { class: 'search-results hidden', id: 'search-results' }));

  const restore = el('button', { class: 'btn btn-ghost btn-sm hidden', id: 'restore-step-btn' }, 'Restore deleted step');
  section.appendChild(restore);

  const list = el('div', { class: 'steps-list', id: 'steps-list' });
  course.steps.forEach((step, i) => list.appendChild(buildStepItem(i, step)));
  section.appendChild(list);
  return section;
}

function buildStepItem(index: number, step: StepDef): HTMLElement {
  const isSelected = state.selectedStep === index;
  const item = el('div', {
    class: `step-item${isSelected ? ' selected' : ''}`,
    draggable: 'true',
    'data-index': String(index),
  });
  item.appendChild(el('span', { class: 'drag-handle', title: 'Drag to reorder' }, '⠿'));
  item.appendChild(el('span', { class: 'step-num' }, String(index + 1)));
  item.appendChild(el('span', { class: 'step-title' }, step.title || '(untitled)'));
  const actions = el('div', { class: 'step-actions' });
  actions.appendChild(el('button', {
    class: 'btn btn-ghost btn-icon',
    title: 'Delete step',
    'data-action': 'delete-step',
    'data-index': String(index),
  }, '×'));
  item.appendChild(actions);
  return item;
}

// Feature 4 – assets section in sidebar
function buildAssetsSection(): HTMLElement {
  const section = el('div', { class: 'section assets-section' });
  const header = el('div', { class: 'section-header collapsible', id: 'assets-header' });
  header.appendChild(el('span', {}, `Assets (${state.assets.length})`));
  header.appendChild(el('span', { class: 'chevron' }, '▸'));
  section.appendChild(header);

  const body = el('div', { class: 'section-body collapsed', id: 'assets-body' });
  const toolbar = el('div', { class: 'assets-toolbar' });
  const importBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-action': 'import-asset' }, '+ Import file');
  toolbar.appendChild(importBtn);
  body.appendChild(toolbar);

  const list = el('div', { class: 'assets-list', id: 'assets-list' });
  renderAssetItems(list, state.assets);
  body.appendChild(list);

  section.appendChild(body);
  return section;
}

function renderAssetItems(container: HTMLElement, assets: AssetInfo[]): void {
  container.innerHTML = '';
  if (assets.length === 0) {
    container.appendChild(el('div', { class: 'assets-empty' }, 'No assets yet.'));
    return;
  }
  for (const asset of assets) {
    const row = el('div', { class: 'asset-row', title: asset.relativePath });
    row.appendChild(el('span', { class: 'asset-icon' }, asset.isImage ? '🖼' : '📄'));
    const info = el('div', { class: 'asset-info' });
    info.appendChild(el('span', { class: 'asset-name', title: asset.relativePath }, asset.filename));
    info.appendChild(el('span', { class: 'asset-size' }, fmtBytes(asset.size)));
    row.appendChild(info);
    const copyBtn = el('button', {
      class: 'btn btn-ghost btn-sm asset-copy-btn',
      title: 'Copy markdown reference',
      'data-path': asset.relativePath,
      'data-image': String(asset.isImage),
    }, '📋');
    row.appendChild(copyBtn);
    if (asset.isImage) {
      row.appendChild(el('button', {
        class: 'btn btn-ghost btn-sm asset-preview-btn',
        title: 'Preview asset',
        'data-path': asset.relativePath,
      }, '👁'));
    }
    row.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm asset-rename-btn',
      title: 'Rename asset',
      'data-path': asset.relativePath,
    }, 'Rename'));
    row.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm asset-delete-btn',
      title: 'Delete asset on next save',
      'data-path': asset.relativePath,
    }, '×'));
    container.appendChild(row);
  }
}

function refreshAssetList(): void {
  const container = document.getElementById('assets-list');
  if (container) renderAssetItems(container, state.assets);
  // Update header count
  const header = document.querySelector('#assets-header span:first-child');
  if (header) header.textContent = `Assets (${state.assets.length})`;
}

// ─── Editor panel ─────────────────────────────────────────────────────────────

function buildEditorPanel(): HTMLElement {
  const panel = el('div', { class: 'editor-panel' });
  if (state.selectedStep === -1 || !state.course) {
    panel.appendChild(el('div', { class: 'empty-editor' }, 'Select a step to edit, or add a new step.'));
    return panel;
  }
  const step = state.course.steps[state.selectedStep];
  if (!step) { panel.appendChild(el('div', { class: 'empty-editor' }, 'Step not found.')); return panel; }

  const tabs = el('div', { class: 'tab-bar' });
  for (const tab of ['instructions', 'validator', 'starter', 'solution', 'meta'] as const) {
    const btn = el('button', {
      class: `tab-btn${state.activeTab === tab ? ' active' : ''}`,
      'data-tab': tab,
    }, tab.charAt(0).toUpperCase() + tab.slice(1));
    tabs.appendChild(btn);
  }
  panel.appendChild(tabs);

  const content = el('div', { class: 'tab-content' });
  try {
    if (state.activeTab === 'instructions') content.appendChild(buildInstructionsTab(step));
    else if (state.activeTab === 'validator') content.appendChild(buildValidatorTab(step));
    else if (state.activeTab === 'starter') content.appendChild(buildSimpleFileTab(step, 'starter'));
    else if (state.activeTab === 'solution') content.appendChild(buildSimpleFileTab(step, 'solution'));
    else content.appendChild(buildMetaTab(step));
  } catch (err) {
    content.appendChild(el('div', { class: 'empty-editor' }, `Could not render ${state.activeTab} tab: ${err instanceof Error ? err.message : String(err)}`));
  }
  panel.appendChild(content);
  return panel;
}

// Instructions tab ─────────────────────────────────────────────────────────────

let previewVisible = false;

function buildInstructionsTab(step: StepDef): HTMLElement {
  const wrapper = el('div', { class: 'instructions-tab' });

  const toolbar = el('div', { class: 'editor-toolbar' });
  toolbar.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'preview-toggle' }, 'Preview'));
  // Feature 3 – template button
  toolbar.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'template-btn', title: 'Insert a step template' }, 'Use Template…'));
  wrapper.appendChild(toolbar);

  const editorArea = el('div', { class: 'split-editor', id: 'split-editor' });
  const editorPane = el('div', { class: 'editor-pane active', id: 'editor-pane' });
  const ta = el('textarea', { id: 'instructions-editor', class: 'code-editor', spellcheck: 'true' });
  ta.value = step.instructions ? (fileCache[step.instructions] ?? '') : '';
  editorPane.appendChild(ta);
  editorArea.appendChild(editorPane);

  const previewPane = el('div', { class: 'preview-pane', id: 'preview-pane' });
  previewPane.innerHTML = '<div class="preview-placeholder">Click Preview to render markdown</div>';
  editorArea.appendChild(previewPane);
  wrapper.appendChild(editorArea);

  if (step.instructions && fileCache[step.instructions] === undefined) {
    loadFileIntoTextarea(step.instructions, ta);
  }
  return wrapper;
}

// Validator tab ────────────────────────────────────────────────────────────────

function buildValidatorTab(step: StepDef): HTMLElement {
  const wrapper = el('div', { class: 'validator-tab' });

  // Quick snippet chips + run button + library toggle
  const topBar = el('div', { class: 'validator-topbar' });
  const snippetsBar = el('div', { class: 'snippets-bar' });
  snippetsBar.appendChild(el('span', { class: 'snippets-label' }, 'Quick:'));
  QUICK_SNIPPETS.forEach((s, i) => {
    const key = `quick-${i}`;
    renderedSnippetCode.set(key, s.code);
    const chip = el('button', { class: 'snippet-chip', title: s.description, 'data-snippet-key': key }, s.label);
    snippetsBar.appendChild(chip);
  });
  topBar.appendChild(snippetsBar);

  const validatorActions = el('div', { class: 'validator-actions' });
  // Feature 6 – library toggle
  validatorActions.appendChild(
    el('button', { class: `btn btn-ghost btn-sm${showLibrary ? ' active' : ''}`, id: 'library-toggle', title: 'Browse snippet library' }, 'Library…'),
  );
  // Feature 1 – run validator button
  const runBtn = el('button', {
    class: 'btn btn-secondary btn-sm',
    id: 'run-validator-btn',
    title: 'Run this validator against the current workspace',
    ...(validatorRunning ? { disabled: 'true' } : {}),
  }, validatorRunning ? '⟳ Running…' : 'Run Validator');
  validatorActions.appendChild(runBtn);
  topBar.appendChild(validatorActions);
  wrapper.appendChild(topBar);

  // Code editor
  const editorArea = el('div', { class: `validator-editor-area${showLibrary ? ' with-library' : ''}` });
  const editorWrap = el('div', { class: 'validator-editor-wrap' });
  editorWrap.appendChild(el('div', { class: 'func-header' }, 'module.exports = async function validate(context) {'));
  const ta = el('textarea', {
    id: 'validator-editor',
    class: 'code-editor validator-code',
    spellcheck: 'false',
    autocorrect: 'off',
    autocapitalize: 'off',
  });
  const raw = step.validator ? (fileCache[step.validator] ?? '') : '';
  ta.value = extractValidatorBody(raw);
  ta.setAttribute('data-js-editor', 'validator');
  editorWrap.appendChild(ta);
  editorWrap.appendChild(el('div', { class: 'func-footer' }, '};'));
  editorArea.appendChild(editorWrap);

  // Feature 6 – library panel (inline)
  if (showLibrary) {
    editorArea.appendChild(buildLibraryPanel());
  }
  wrapper.appendChild(editorArea);

  // Feature 1 – inline result display
  const resultArea = el('div', { class: 'validator-result-area', id: 'validator-result-area' });
  if (validatorResult) renderValidatorResult(resultArea, validatorResult);
  wrapper.appendChild(resultArea);
  wrapper.appendChild(el('div', { class: 'syntax-status', id: 'validator-syntax-status' }));

  if (step.validator && fileCache[step.validator] === undefined) {
    loadFileIntoTextarea(step.validator, ta, extractValidatorBody, () => updateSyntaxStatus('validator'));
  }
  setTimeout(() => updateSyntaxStatus('validator'), 0);
  return wrapper;
}

function buildSimpleFileTab(step: StepDef, kind: 'starter' | 'solution'): HTMLElement {
  const wrapper = el('div', { class: 'instructions-tab' });
  const currentPath = step[kind];
  const toolbar = el('div', { class: 'editor-toolbar' });
  toolbar.appendChild(el('span', { class: 'field-help' }, currentPath ? `${kind}: ${currentPath}` : `No ${kind} file set.`));
  if (currentPath) {
    toolbar.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: `rename-${kind}-btn` }, 'Rename'));
    toolbar.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: `delete-${kind}-btn` }, 'Delete'));
  }
  if (!currentPath) {
    toolbar.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: `create-${kind}-btn` }, `Create ${kind}.js`));
  }
  wrapper.appendChild(toolbar);

  if (!currentPath) {
    const empty = el('div', { class: 'empty-editor empty-file-tab' });
    empty.appendChild(el('div', { class: 'empty-title' }, `No ${kind} file yet`));
    empty.appendChild(el('div', { class: 'empty-subtitle' }, `Create a ${kind}.js file or return to instructions.`));
    const actions = el('div', { class: 'empty-actions' });
    actions.appendChild(el('button', { class: 'btn btn-primary btn-sm', id: `empty-create-${kind}-btn` }, `Create ${kind}.js`));
    actions.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: `empty-back-${kind}-btn` }, 'Back to Instructions'));
    empty.appendChild(actions);
    wrapper.appendChild(empty);
    return wrapper;
  }

  const ta = el('textarea', { id: `${kind}-editor`, class: 'code-editor', spellcheck: 'false' });
  ta.setAttribute('data-file-tab', kind);
  ta.setAttribute('data-js-editor', kind);
  ta.value = fileCache[currentPath] ?? '';
  wrapper.appendChild(ta);
  wrapper.appendChild(el('div', { class: 'syntax-status', id: `${kind}-syntax-status` }));
  if (fileCache[currentPath] === undefined) {
    loadFileIntoTextarea(currentPath, ta, (c) => c, () => updateSyntaxStatus(kind));
  }
  setTimeout(() => updateSyntaxStatus(kind), 0);
  return wrapper;
}

// Feature 1 – result display helpers
function refreshValidatorResult(): void {
  const area = document.getElementById('validator-result-area');
  if (!area) return;
  area.innerHTML = '';
  if (validatorRunning) {
    area.innerHTML = '<div class="vr-running"><span class="spinner">⟳</span> Running validator…</div>';
  } else if (validatorResult) {
    renderValidatorResult(area, validatorResult);
  }
  const runBtn = document.getElementById('run-validator-btn') as HTMLButtonElement | null;
  if (runBtn) {
    runBtn.disabled = validatorRunning;
    runBtn.textContent = validatorRunning ? '⟳ Running…' : 'Run Validator';
  }
}

function renderValidatorResult(container: HTMLElement, result: ValidatorTestResult): void {
  const icon = { pass: '✓', fail: '✕', warn: '⚠', error: '⚠' }[result.status];
  const cls = result.status === 'pass' ? 'vr-pass' : result.status === 'warn' ? 'vr-warn' : 'vr-fail';
  const row = el('div', { class: `vr-row ${cls}` });
  row.appendChild(el('span', { class: 'vr-icon' }, icon));
  const body = el('div', { class: 'vr-body' });
  body.appendChild(el('span', { class: 'vr-message' }, result.message));
  body.appendChild(el('span', { class: 'vr-duration' }, `${result.duration}ms`));
  if (result.terminalNote) {
    body.appendChild(el('div', { class: 'vr-note' }, `ℹ ${result.terminalNote}`));
  }
  row.appendChild(body);
  container.appendChild(row);
}

// Feature 6 – snippet library panel
function buildLibraryPanel(): HTMLElement {
  const panel = el('div', { class: 'library-panel', id: 'library-panel' });

  const header = el('div', { class: 'library-header' });
  header.appendChild(el('span', { class: 'library-title' }, 'Snippet Library'));
  header.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'custom-snippet-add' }, '+ Custom'));
  const closeBtn = el('button', { class: 'btn btn-ghost btn-icon', id: 'library-close' }, '×');
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const search = el('input', {
    id: 'library-search',
    class: 'field-input',
    type: 'text',
    placeholder: 'Search…',
  });
  search.value = librarySearch;
  panel.appendChild(search);

  const cats = el('div', { class: 'library-cats' });
  cats.appendChild(el('button', {
    class: `lib-cat-btn${libraryCategory === 'custom' ? ' active' : ''}`,
    'data-cat': 'custom',
  }, 'Custom'));
  for (const cat of SNIPPET_LIBRARY) {
    const btn = el('button', {
      class: `lib-cat-btn${libraryCategory === cat.id ? ' active' : ''}`,
      'data-cat': cat.id,
    }, cat.label);
    cats.appendChild(btn);
  }
  panel.appendChild(cats);

  const list = el('div', { class: 'library-list', id: 'library-list' });
  renderLibrarySnippets(list);
  panel.appendChild(list);

  return panel;
}

function renderLibrarySnippets(container: HTMLElement): void {
  const filtered = getFilteredSnippets();
  container.innerHTML = '';
  if (filtered.length === 0) {
    container.appendChild(el('div', { class: 'library-empty' }, 'No snippets match your search.'));
    return;
  }
  filtered.forEach((s, i) => {
    const key = `library-${libraryCategory}-${i}-${s.id}`;
    renderedSnippetCode.set(key, s.code);
    const card = el('div', { class: 'library-card' });
    card.appendChild(el('div', { class: 'lib-label' }, s.label));
    card.appendChild(el('div', { class: 'lib-desc' }, s.description));
    const insertBtn = el('button', { class: 'btn btn-ghost btn-sm lib-insert', 'data-snippet-key': key }, 'Insert');
    card.appendChild(insertBtn);
    container.appendChild(card);
  });
}

function getFilteredSnippets(): LibrarySnippet[] {
  const custom: LibrarySnippet[] = state.customSnippets.map((s) => ({ ...s }));
  const cat = SNIPPET_LIBRARY.find((c) => c.id === libraryCategory);
  const snippets = libraryCategory === 'custom' ? custom : cat?.snippets ?? [...SNIPPET_LIBRARY.flatMap((c) => c.snippets), ...custom];
  if (!librarySearch.trim()) return snippets;
  const q = librarySearch.toLowerCase();
  return snippets.filter((s) => s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}

// Meta tab ────────────────────────────────────────────────────────────────────

function buildMetaTab(step: StepDef): HTMLElement {
  const wrapper = el('div', { class: 'meta-tab' });

  for (const f of [
    { label: 'Step ID', id: 'step-id', value: step.id, placeholder: 'my-step' },
    { label: 'Step Title', id: 'step-title', value: step.title, placeholder: 'Step Title' },
  ]) {
    const row = el('div', { class: 'field-row' });
    row.appendChild(el('label', { for: f.id, class: 'field-label' }, f.label));
    const input = el('input', { id: f.id, class: 'field-input', type: 'text', placeholder: f.placeholder });
    input.value = f.value;
    row.appendChild(input);
    wrapper.appendChild(row);
  }

  const pathsSection = el('div', { class: 'paths-section' });
  pathsSection.appendChild(el('div', { class: 'field-label' }, 'File paths'));
  const pathTable = el('div', { class: 'path-table' });
  for (const [label, value] of [
    ['Instructions', step.instructions],
    ['Validator', step.validator],
    ['Starter', step.starter],
    ['Solution', step.solution],
  ] as [string, string | undefined][]) {
    const row = el('div', { class: 'path-row' });
    row.appendChild(el('span', { class: 'path-label' }, label));
    row.appendChild(el('span', { class: `path-value${value ? '' : ' missing'}` }, value || '(not set)'));
    pathTable.appendChild(row);
  }
  pathsSection.appendChild(pathTable);
  const fileActions = el('div', { class: 'dialog-actions' });
  if (!step.starter) fileActions.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'meta-create-starter' }, '+ Starter file'));
  if (!step.solution) fileActions.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'meta-create-solution' }, '+ Solution file'));
  pathsSection.appendChild(fileActions);
  wrapper.appendChild(pathsSection);

  const hintsSection = el('div', { class: 'hints-section' });
  hintsSection.appendChild(el('div', { class: 'field-label' }, 'Hints'));
  const hintsList = el('div', { class: 'hints-list', id: 'hints-list' });
  renderHints(hintsList, step.hints);
  hintsSection.appendChild(hintsList);
  hintsSection.appendChild(el('button', { class: 'btn btn-ghost btn-sm', 'data-action': 'add-hint' }, '+ Add Hint'));
  wrapper.appendChild(hintsSection);

  return wrapper;
}

function renderHints(container: HTMLElement, hints: string[]): void {
  container.innerHTML = '';
  hints.forEach((hint, i) => {
    const row = el('div', { class: 'hint-row' });
    const input = el('input', { class: 'field-input hint-input', type: 'text', placeholder: `Hint ${i + 1}`, 'data-hint-index': String(i) });
    input.value = hint;
    row.appendChild(input);
    row.appendChild(el('button', { class: 'btn btn-ghost btn-icon', 'data-action': 'delete-hint', 'data-index': String(i), title: 'Remove hint' }, '×'));
    container.appendChild(row);
  });
}

// ─── Publish panel ───────────────────────────────────────────────────────────

function buildPublishPanel(): HTMLElement {
  const panel = el('div', { class: `publish-panel${publishPanelVisible ? '' : ' hidden'}`, id: 'publish-panel' });

  const header = el('div', { class: 'publish-header' });
  header.appendChild(el('h3', { class: 'publish-title' }, 'Publish Course'));
  header.appendChild(el('button', { class: 'btn btn-ghost btn-icon', id: 'publish-close' }, '×'));
  panel.appendChild(header);

  const body = el('div', { class: 'publish-body' });

  const repoRow = el('div', { class: 'field-row' });
  repoRow.appendChild(el('label', { for: 'pub-repo', class: 'field-label' }, 'GitHub Repo'));
  const repoInput = el('input', { id: 'pub-repo', class: 'field-input', type: 'text', placeholder: 'owner/repo-name' });
  repoInput.value = publishRepoSuggestion;
  repoRow.appendChild(repoInput);
  repoRow.appendChild(el('button', { class: 'btn btn-ghost btn-sm', id: 'load-repos-btn', type: 'button' }, 'Pick repo'));
  repoRow.appendChild(el('span', { class: 'field-help' }, 'e.g. myuser/course-my-course'));
  body.appendChild(repoRow);

  const tagsRow = el('div', { class: 'field-row' });
  tagsRow.appendChild(el('label', { for: 'pub-tags', class: 'field-label' }, 'Tags'));
  tagsRow.appendChild(el('input', { id: 'pub-tags', class: 'field-input', type: 'text', placeholder: 'git, beginner' }));
  tagsRow.appendChild(el('span', { class: 'field-help' }, 'Comma-separated'));
  body.appendChild(tagsRow);

  const createRepoRow = el('div', { class: 'field-row' });
  createRepoRow.appendChild(el('label', { class: 'field-label' }, 'Repository'));
  const createRepoLabel = el('label', { class: 'checkbox-label' });
  createRepoLabel.appendChild(el('input', { id: 'pub-create-repo', type: 'checkbox' }));
  createRepoLabel.appendChild(document.createTextNode(' Create repo if missing'));
  createRepoRow.appendChild(createRepoLabel);
  createRepoRow.appendChild(el('span', { class: 'field-help' }, 'Creates a public user/org repo when the target does not exist'));
  body.appendChild(createRepoRow);

  const registryRow = el('div', { class: 'field-row publish-registry-row' });
  registryRow.appendChild(el('label', { class: 'field-label' }, 'Registry'));
  const registryLabel = el('label', { class: 'checkbox-label' });
  const registryCheckbox = el('input', { id: 'pub-add-registry', type: 'checkbox' });
  if (authorSettings.defaultRegistryRepo) {
    registryCheckbox.checked = true;
    registryCheckbox.disabled = true;
  }
  registryLabel.appendChild(registryCheckbox);
  registryLabel.appendChild(document.createTextNode(authorSettings.defaultRegistryRepo ? ' Add to registry repo (settings default)' : ' Add to registry repo'));
  registryRow.appendChild(registryLabel);
  const registryInput = el('input', { id: 'pub-registry-repo', class: 'field-input', type: 'text', placeholder: 'owner/registry-repo or GitHub URL' });
  registryInput.value = authorSettings.defaultRegistryRepo;
  registryRow.appendChild(registryInput);
  const registryPathInput = el('input', { id: 'pub-registry-path', class: 'field-input', type: 'text', placeholder: 'registry filename/path' });
  registryPathInput.value = authorSettings.defaultRegistryPath;
  registryRow.appendChild(registryPathInput);
  registryRow.appendChild(el('span', { class: 'field-help' }, 'Updates this JSON registry file in the registry repo'));
  body.appendChild(registryRow);

  const bumpRow = el('div', { class: 'field-row' });
  bumpRow.appendChild(el('label', { class: 'field-label' }, 'Version Bump'));
  const bumpGroup = el('div', { class: 'radio-group' });
  const v = state.course?.version ?? '1.0.0';
  for (const b of [
    { value: 'none', label: `None (${v})` },
    { value: 'patch', label: `Patch → ${bumpPreview(v, 'patch')}` },
    { value: 'minor', label: `Minor → ${bumpPreview(v, 'minor')}` },
    { value: 'major', label: `Major → ${bumpPreview(v, 'major')}` },
  ]) {
    const lbl = el('label', { class: 'radio-label' });
    const radio = el('input', { type: 'radio', name: 'bump-type', value: b.value, class: 'radio-input' });
    if (b.value === 'patch') radio.checked = true;
    lbl.appendChild(radio);
    lbl.appendChild(document.createTextNode(` ${b.label}`));
    bumpGroup.appendChild(lbl);
  }
  bumpRow.appendChild(bumpGroup);
  body.appendChild(bumpRow);

  body.appendChild(el('div', { class: 'publish-progress hidden', id: 'publish-progress' }));
  const actions = el('div', { class: 'publish-actions' });
  actions.appendChild(el('button', { class: 'btn btn-primary', id: 'confirm-publish-btn' }, 'Publish'));
  body.appendChild(actions);

  // Feature 7 – publish history
  body.appendChild(buildPublishHistory());

  panel.appendChild(body);
  return panel;
}

function buildPublishHistory(): HTMLElement {
  const section = el('div', { class: 'publish-history', id: 'publish-history' });
  section.appendChild(el('div', { class: 'field-label' }, 'Publish History'));
  const list = el('div', { class: 'history-list', id: 'history-list' });
  renderHistoryItems(list, state.publishHistory);
  section.appendChild(list);
  return section;
}

function renderHistoryItems(container: HTMLElement, history: PublishHistoryEntry[]): void {
  container.innerHTML = '';
  if (history.length === 0) {
    container.appendChild(el('div', { class: 'history-empty' }, 'No publishes yet.'));
    return;
  }
  for (const entry of history) {
    const row = el('div', { class: 'history-row' });
    const meta = el('div', { class: 'history-meta' });
    meta.appendChild(el('span', { class: 'history-version' }, `v${entry.version}`));
    meta.appendChild(el('span', { class: 'history-repo' }, entry.repo));
    meta.appendChild(el('span', { class: 'history-date' }, timeAgo(entry.date)));
    row.appendChild(meta);
    const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-url': entry.registryUrl, title: entry.registryUrl }, 'Copy URL');
    row.appendChild(copyBtn);
    container.appendChild(row);
  }
}

function refreshPublishHistory(): void {
  const container = document.getElementById('history-list');
  if (container) renderHistoryItems(container, state.publishHistory);
}

function bumpPreview(version: string, type: 'major' | 'minor' | 'patch'): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Feature 5 – import panel
function buildImportPanel(): HTMLElement {
  const panel = el('div', { class: `import-panel${showImport ? '' : ' hidden'}`, id: 'import-panel' });

  const header = el('div', { class: 'publish-header' });
  header.appendChild(el('h3', { class: 'publish-title' }, 'Import Course'));
  header.appendChild(el('button', { class: 'btn btn-ghost btn-icon', id: 'import-close' }, '×'));
  panel.appendChild(header);

  const body = el('div', { class: 'import-body' });

  const urlRow = el('div', { class: 'field-row' });
  urlRow.appendChild(el('label', { for: 'import-url', class: 'field-label' }, 'GitHub URL'));
  urlRow.appendChild(el('input', { id: 'import-url', class: 'field-input', type: 'text', placeholder: 'https://github.com/owner/course-name' }));
  urlRow.appendChild(el('span', { class: 'field-help' }, 'Paste a GitHub repo URL to clone it'));
  body.appendChild(urlRow);

  const importActions = el('div', { class: 'publish-actions import-actions' });
  importActions.appendChild(el('button', { class: 'btn btn-primary', id: 'confirm-import-url-btn' }, 'Import from GitHub'));
  importActions.appendChild(el('span', { class: 'import-or' }, 'or'));
  importActions.appendChild(el('button', { class: 'btn btn-secondary', id: 'import-local-btn' }, 'Open Local Folder…'));
  body.appendChild(importActions);

  body.appendChild(el('div', { class: 'publish-progress hidden', id: 'import-progress' }));
  panel.appendChild(body);
  return panel;
}

function handleImportProgressMsg(status: string, message: string): void {
  const area = document.getElementById('import-progress');
  if (!area) return;
  area.classList.remove('hidden');
  const cls = status === 'error' ? 'error' : status === 'success' ? 'success' : '';
  const icon = status === 'error' ? '✕' : status === 'success' ? '✓' : '⟳';
  area.innerHTML = `<div class="progress-msg ${cls}"><span${status === 'progress' ? ' class="spinner"' : ''}>${icon}</span> ${escapeHtml(message)}</div>`;
}

// ─── Publish progress message ────────────────────────────────────────────────

function handlePublishProgressMsg(
  status: 'progress' | 'success' | 'error',
  message: string,
  registryUrl?: string,
): void {
  const area = document.getElementById('publish-progress');
  const btn = document.getElementById('confirm-publish-btn') as HTMLButtonElement | null;
  if (!area) return;
  area.classList.remove('hidden');

  if (status === 'progress') {
    area.innerHTML = `<div class="progress-msg"><span class="spinner">⟳</span> ${escapeHtml(message)}</div>`;
    if (btn) btn.disabled = true;
  } else if (status === 'success') {
    let html = `<div class="progress-msg success">✓ ${escapeHtml(message)}</div>`;
    if (registryUrl) {
      html += `<div class="registry-url-block">
        <div class="field-label">Registry URL (use as instrktr.registryUrl):</div>
        <code class="registry-url">${escapeHtml(registryUrl)}</code>
        <button class="btn btn-ghost btn-sm copy-btn" data-url="${escapeHtml(registryUrl)}">Copy</button>
      </div>`;
    }
    area.innerHTML = html;
    if (btn) { btn.disabled = false; btn.textContent = 'Publish Again'; }
    const copyBtn = area.querySelector<HTMLButtonElement>('.copy-btn');
    if (copyBtn) copyBtn.onclick = () => copyToClipboard(copyBtn.dataset.url ?? '', copyBtn);
  } else {
    area.innerHTML = `<div class="progress-msg error">✕ ${escapeHtml(message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
  }
}

function copyToClipboard(text: string, btn: HTMLButtonElement): void {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent ?? 'Copy';
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2_000);
  });
}

// ─── Event listeners ─────────────────────────────────────────────────────────

function attachEventListeners(): void {
  document.getElementById('save-btn')?.addEventListener('click', handleSave);
  document.getElementById('validate-btn')?.addEventListener('click', validateCourse);
  document.getElementById('schema-btn')?.addEventListener('click', exportCourseSchema);
  document.getElementById('readme-btn')?.addEventListener('click', generateReadme);
  document.getElementById('sample-btn')?.addEventListener('click', async () => {
    if (!await requireSavedChanges('replacing the course with sample content')) return;
    await generateSampleCourse();
  });
  document.getElementById('renumber-btn')?.addEventListener('click', renumberStepPaths);
  document.getElementById('undo-btn')?.addEventListener('click', undoLastAction);
  document.getElementById('switch-course-btn')?.addEventListener('click', async () => {
    if (!await requireSavedChanges('switching courses')) return;
    post({ command: 'listWorkspaceCourses' });
  });

  // Publish panel toggle
  document.getElementById('publish-btn')?.addEventListener('click', () => {
    publishPanelVisible = !publishPanelVisible;
    document.getElementById('publish-panel')?.classList.toggle('hidden', !publishPanelVisible);
  });
  document.getElementById('publish-close')?.addEventListener('click', () => {
    publishPanelVisible = false;
    document.getElementById('publish-panel')?.classList.add('hidden');
  });
  document.getElementById('confirm-publish-btn')?.addEventListener('click', handlePublish);
  document.getElementById('load-repos-btn')?.addEventListener('click', () => post({ command: 'listRepos' }));

  // History copy buttons (delegated)
  document.getElementById('history-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-url]');
    if (btn?.dataset.url) copyToClipboard(btn.dataset.url, btn);
  });

  // Feature 2 – preview button
  document.getElementById('preview-btn')?.addEventListener('click', showPreviewOverlay);

  // Feature 5 – import panel
  document.getElementById('import-btn')?.addEventListener('click', () => {
    showImport = !showImport;
    document.getElementById('import-panel')?.classList.toggle('hidden', !showImport);
  });
  document.getElementById('import-close')?.addEventListener('click', () => {
    showImport = false;
    document.getElementById('import-panel')?.classList.add('hidden');
  });
  document.getElementById('confirm-import-url-btn')?.addEventListener('click', async () => {
    if (!await requireSavedChanges('importing a course')) return;
    const url = (document.getElementById('import-url') as HTMLInputElement | null)?.value.trim() ?? '';
    if (!url) { handleImportProgressMsg('error', 'Enter a GitHub URL.'); return; }
    post({ command: 'importCourseFromUrl', url });
  });
  document.getElementById('import-local-btn')?.addEventListener('click', async () => {
    if (!await requireSavedChanges('importing a course')) return;
    post({ command: 'importCourseFromLocal' });
  });

  // Asset copy reference buttons (delegated)
  document.getElementById('assets-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.asset-copy-btn');
    if (btn) {
      const path = btn.dataset.path ?? '';
      const isImage = btn.dataset.image === 'true';
      const ref = isImage ? `![alt text](${path})` : `[link text](${path})`;
      copyToClipboard(ref, btn);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = '📋'; }, 1_500);
      return;
    }
    const previewBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.asset-preview-btn');
    if (previewBtn?.dataset.path) {
      previewAsset(previewBtn.dataset.path);
      return;
    }
    const deleteBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.asset-delete-btn');
    if (deleteBtn?.dataset.path) {
      void (async () => {
        const assetPath = deleteBtn.dataset.path!;
        if (!await confirmDialog('Delete Asset', `Delete ${assetPath} on next save?`, 'Delete')) return;
        pendingDeletedFilePaths.add(assetPath);
        state.assets = state.assets.filter((a) => a.relativePath !== assetPath);
        markDirty();
        refreshAssetList();
      })();
      return;
    }
    const renameBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.asset-rename-btn');
    if (renameBtn?.dataset.path) {
      const oldPath = renameBtn.dataset.path;
      const base = oldPath.split('/').pop() ?? oldPath;
      void (async () => {
        const name = await promptDialog('Rename Asset', 'New asset filename:', base);
        if (!name || name === base) return;
        const newPath = `assets/${name}`;
        postRenameFile(oldPath, newPath, { kind: 'asset' });
        const asset = state.assets.find((a) => a.relativePath === oldPath);
        if (asset) {
          asset.filename = name;
          asset.relativePath = newPath;
        }
        markDirty();
        refreshAssetList();
      })();
    }
  });

  document.querySelector('[data-action="import-asset"]')?.addEventListener('click', () => {
    post({ command: 'importAsset' });
  });

  attachMetaListeners();
  attachSearchListeners();
  attachStepListListeners();

  // Collapsible sections
  document.getElementById('meta-header')?.addEventListener('click', () => {
    const body = document.getElementById('meta-body');
    const chevron = document.querySelector('#meta-header .chevron');
    if (body) { const collapsed = body.classList.toggle('collapsed'); if (chevron) chevron.textContent = collapsed ? '▸' : '▾'; }
  });
  document.getElementById('assets-header')?.addEventListener('click', () => {
    const body = document.getElementById('assets-body');
    const chevron = document.querySelector('#assets-header .chevron');
    if (body) { const collapsed = body.classList.toggle('collapsed'); if (chevron) chevron.textContent = collapsed ? '▸' : '▾'; }
  });

  attachEditorListeners();
}

function attachEditorListeners(): void {
  // Tab buttons live inside the editor panel, which is replaced on every tab
  // switch. Bind them here so the newly-rendered panel remains navigable.
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as AppState['activeTab'] | undefined;
      if (tab) selectTab(tab);
    });
  });

  document.getElementById('instructions-editor')?.addEventListener('input', () => markDirty());
  for (const id of ['validator', 'starter', 'solution'] as const) {
    document.getElementById(`${id}-editor`)?.addEventListener('input', () => {
      markDirty();
      updateSyntaxStatus(id);
    });
  }

  // Instructions preview toggle
  document.getElementById('preview-toggle')?.addEventListener('click', toggleMarkdownPreview);

  // Feature 3 – template button
  document.getElementById('template-btn')?.addEventListener('click', showTemplateDialog);

  // Quick snippet chips
  document.querySelectorAll<HTMLButtonElement>('.snippet-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const ta = document.getElementById('validator-editor') as HTMLTextAreaElement | null;
      const code = chip.dataset.snippetKey ? renderedSnippetCode.get(chip.dataset.snippetKey) : undefined;
      if (ta && code) { insertSnippet(ta, '\n' + await parameterizeSnippet(code) + '\n'); markDirty(); }
      else showError(`Snippet insert failed: missing editor or snippet key "${chip.dataset.snippetKey ?? '(none)'}".`);
    });
  });

  // Feature 1 – run validator
  document.getElementById('run-validator-btn')?.addEventListener('click', async () => {
    if (validatorRunning || state.selectedStep === -1 || !state.course) return;
    if (!await requireSavedChanges('running the validator')) return;
    const fileWrites = saveCurrentTabContent(false);
    const risky = fileWrites.some((w) => /terminal\.(?:run|runShell)|child_process|rm\s+-|sudo|curl\s+.*\|\s*(sh|bash)/.test(w.content));
    if (risky && !await confirmDialog('Run Validator', 'This validator may run shell commands. Run it in author test mode anyway?', 'Run Validator')) return;
    validatorRunning = true;
    validatorResult = null;
    refreshValidatorResult();
    post({ command: 'runValidator', stepIndex: state.selectedStep, course: state.course, fileWrites });
  });

  // Feature 6 – library toggle and interactions
  document.getElementById('library-toggle')?.addEventListener('click', () => {
    showLibrary = !showLibrary;
    const editorArea = document.querySelector('.validator-editor-area');
    if (!state.course || state.selectedStep === -1) return;
    const step = state.course.steps[state.selectedStep];
    if (!editorArea) return;
    // Re-build the validator tab with the new library state
    const tabContent = document.querySelector('.tab-content');
    if (tabContent) { tabContent.innerHTML = ''; tabContent.appendChild(buildValidatorTab(step)); attachEditorListeners(); }
  });

  document.getElementById('library-close')?.addEventListener('click', () => {
    showLibrary = false;
    const tabContent = document.querySelector('.tab-content');
    if (!state.course || state.selectedStep === -1 || !tabContent) return;
    tabContent.innerHTML = '';
    tabContent.appendChild(buildValidatorTab(state.course.steps[state.selectedStep]));
    attachEditorListeners();
  });

  document.getElementById('library-search')?.addEventListener('input', (e) => {
    librarySearch = (e.target as HTMLInputElement).value;
    const list = document.getElementById('library-list');
    if (list) renderLibrarySnippets(list);
  });

  document.querySelectorAll<HTMLButtonElement>('.lib-cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      libraryCategory = btn.dataset.cat ?? '';
      document.querySelectorAll('.lib-cat-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const list = document.getElementById('library-list');
      if (list) renderLibrarySnippets(list);
    });
  });

  document.getElementById('library-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.lib-insert');
    if (btn) {
      void (async () => {
        const ta = document.getElementById('validator-editor') as HTMLTextAreaElement | null;
        const code = btn.dataset.snippetKey ? renderedSnippetCode.get(btn.dataset.snippetKey) : undefined;
        if (ta && code) { insertSnippet(ta, '\n' + await parameterizeSnippet(code) + '\n'); markDirty(); }
        else showError(`Snippet insert failed: missing editor or snippet key "${btn.dataset.snippetKey ?? '(none)'}".`);
      })();
    }
  });
  document.getElementById('custom-snippet-add')?.addEventListener('click', addCustomSnippet);

  // Meta tab fields
  document.getElementById('step-id')?.addEventListener('input', () => markDirty());
  document.getElementById('step-title')?.addEventListener('input', () => markDirty());
  document.getElementById('create-starter-btn')?.addEventListener('click', () => createStepFile('starter'));
  document.getElementById('create-solution-btn')?.addEventListener('click', () => createStepFile('solution'));
  document.getElementById('empty-create-starter-btn')?.addEventListener('click', () => createStepFile('starter'));
  document.getElementById('empty-create-solution-btn')?.addEventListener('click', () => createStepFile('solution'));
  document.getElementById('empty-back-starter-btn')?.addEventListener('click', () => selectTab('instructions'));
  document.getElementById('empty-back-solution-btn')?.addEventListener('click', () => selectTab('instructions'));
  document.getElementById('rename-starter-btn')?.addEventListener('click', () => void renameStepFile('starter'));
  document.getElementById('rename-solution-btn')?.addEventListener('click', () => void renameStepFile('solution'));
  document.getElementById('delete-starter-btn')?.addEventListener('click', () => void deleteStepFile('starter'));
  document.getElementById('delete-solution-btn')?.addEventListener('click', () => void deleteStepFile('solution'));
  document.getElementById('meta-create-starter')?.addEventListener('click', () => createStepFile('starter'));
  document.getElementById('meta-create-solution')?.addEventListener('click', () => createStepFile('solution'));

  document.querySelector('[data-action="add-hint"]')?.addEventListener('click', () => {
    if (!state.course || state.selectedStep === -1) return;
    state.course.steps[state.selectedStep].hints.push('');
    markDirty();
    const hl = document.getElementById('hints-list');
    if (hl) { renderHints(hl, state.course.steps[state.selectedStep].hints); attachHintListeners(); }
  });
  attachHintListeners();
}

function attachHintListeners(): void {
  document.querySelectorAll<HTMLInputElement>('.hint-input').forEach((input) => {
    input.addEventListener('input', () => {
      if (!state.course || state.selectedStep === -1) return;
      const idx = parseInt(input.dataset.hintIndex ?? '0', 10);
      state.course.steps[state.selectedStep].hints[idx] = input.value;
      markDirty();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-action="delete-hint"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.course || state.selectedStep === -1) return;
      const idx = parseInt(btn.dataset.index ?? '0', 10);
      state.course.steps[state.selectedStep].hints.splice(idx, 1);
      markDirty();
      const hl = document.getElementById('hints-list');
      if (hl) { renderHints(hl, state.course.steps[state.selectedStep].hints); attachHintListeners(); }
    });
  });
}

function attachMetaListeners(): void {
  const bind = (id: string, setter: (v: string) => void) => {
    const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    input?.addEventListener('input', () => { setter(input.value); markDirty(); });
  };
  bind('meta-title', (v) => { if (state.course) state.course.title = v; });
  bind('meta-id', (v) => { if (state.course) state.course.id = v; });
  bind('meta-version', (v) => { if (state.course) state.course.version = v; });
  bind('meta-engine', (v) => { if (state.course) state.course.engineVersion = v; });
  bind('meta-description', (v) => { if (state.course) state.course.description = v; });

  const bindSetting = (id: string, key: keyof Pick<AuthorSettings, 'defaultRegistryRepo' | 'defaultRegistryPath'>) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    input?.addEventListener('change', () => {
      authorSettings = { ...authorSettings, [key]: input.value.trim() };
      post({ command: 'saveSettings', settings: { [key]: authorSettings[key] } });
      updatePublishRegistryDefaults();
    });
  };
  bindSetting('settings-default-registry-repo', 'defaultRegistryRepo');
  bindSetting('settings-default-registry-path', 'defaultRegistryPath');
}

function updateSettingsFields(): void {
  const repo = document.getElementById('settings-default-registry-repo') as HTMLInputElement | null;
  if (repo && repo.value !== authorSettings.defaultRegistryRepo) repo.value = authorSettings.defaultRegistryRepo;
  const path = document.getElementById('settings-default-registry-path') as HTMLInputElement | null;
  if (path && path.value !== authorSettings.defaultRegistryPath) path.value = authorSettings.defaultRegistryPath;
  updatePublishRegistryDefaults();
}

function updatePublishRegistryDefaults(): void {
  const repo = document.getElementById('pub-registry-repo') as HTMLInputElement | null;
  if (repo && !repo.value.trim()) repo.value = authorSettings.defaultRegistryRepo;
  const path = document.getElementById('pub-registry-path') as HTMLInputElement | null;
  if (path && !path.value.trim()) path.value = authorSettings.defaultRegistryPath;
  const enabled = document.getElementById('pub-add-registry') as HTMLInputElement | null;
  if (enabled && authorSettings.defaultRegistryRepo) {
    enabled.checked = true;
    enabled.disabled = true;
  }
}

function attachSearchListeners(): void {
  const input = document.getElementById('course-search') as HTMLInputElement | null;
  input?.addEventListener('input', () => {
    courseSearch = input.value;
    renderSearchResults();
  });
  document.getElementById('restore-step-btn')?.addEventListener('click', () => {
    if (!state.course || pendingDeletedSteps.length === 0) return;
    const restored = pendingDeletedSteps.pop()!;
    state.course.steps.push(restored);
    markDirty();
    render();
  });
  renderSearchResults();
}

async function fillRepoPicker(repos: string[]): Promise<void> {
  const repoInput = document.getElementById('pub-repo') as HTMLInputElement | null;
  if (!repoInput) return;
  if (repos.length === 0) return;
  const pick = await promptDialog('Choose Repo', `${repos.slice(0, 30).map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nEnter number or owner/repo:`, '1');
  if (!pick) return;
  const idx = Number(pick) - 1;
  repoInput.value = repos[idx] ?? pick;
}

async function showCourseSwitcher(courses: string[]): Promise<void> {
  if (courses.length === 0) {
    showTextDialog('Courses', 'No course.json files found in the current workspace.');
    return;
  }
  const pick = await promptDialog('Open Course', `${courses.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nEnter number:`, '1');
  const idx = pick ? Number(pick) - 1 : -1;
  if (courses[idx]) post({ command: 'openWorkspaceCourse', courseDir: courses[idx] });
}

function undoLastAction(): void {
  const previous = undoStack.pop();
  if (!previous) {
    showTextDialog('Undo', 'Nothing to undo.');
    return;
  }
  state.course = previous;
  state.isDirty = true;
  saveState();
  render();
}

function selectTab(tab: AppState['activeTab']): void {
  if (tab === state.activeTab) return;
  saveCurrentTabContent(false);
  state.activeTab = tab;
  saveState();
  const newPanel = buildEditorPanel();
  document.querySelector('.editor-panel')?.replaceWith(newPanel);
  attachEditorListeners();
}

function createStepFile(kind: 'starter' | 'solution'): void {
  if (!state.course || state.selectedStep === -1) return;
  pushUndo();
  const step = state.course.steps[state.selectedStep];
  const dir = step.instructions?.split('/').slice(0, -1).join('/') || `steps/${String(state.selectedStep + 1).padStart(2, '0')}-${step.id}`;
  const path = `${dir}/${kind}.js`;
  step[kind] = path;
  fileCache[path] = kind === 'starter'
    ? `// Starter code for ${step.title}\n`
    : `// Reference solution for ${step.title}\n`;
  state.activeTab = kind;
  markDirty();
  saveState();
  render();
}

async function renameStepFile(kind: 'starter' | 'solution'): Promise<void> {
  if (!state.course || state.selectedStep === -1) return;
  const step = state.course.steps[state.selectedStep];
  const oldPath = step[kind];
  if (!oldPath) return;
  const newPath = await promptDialog(`Rename ${kind}`, `New ${kind} path:`, oldPath);
  if (!newPath || newPath === oldPath) return;
  pushUndo();
  const content = fileCache[oldPath] ?? '';
  fileCache[newPath] = content;
  delete fileCache[oldPath];
  step[kind] = newPath;
  postRenameFile(oldPath, newPath, {
    kind: 'step-file',
    stepIndex: state.selectedStep,
    fileKind: kind,
    oldContent: content,
  });
  markDirty();
  render();
}

async function deleteStepFile(kind: 'starter' | 'solution'): Promise<void> {
  if (!state.course || state.selectedStep === -1) return;
  const step = state.course.steps[state.selectedStep];
  const oldPath = step[kind];
  if (!oldPath || !await confirmDialog('Delete Step File', `Delete ${oldPath} on next save?`, 'Delete')) return;
  pushUndo();
  pendingDeletedFilePaths.add(oldPath);
  delete step[kind];
  markDirty();
  render();
}

async function validateCourse(): Promise<void> {
  saveCurrentTabContent(false);
  if (!state.course) return;
  const problems: string[] = [];
  const ids = new Set<string>();
  const availableAssets = new Set(state.assets.map((asset) => asset.relativePath));
  if (!state.course.id) problems.push('Course ID is missing.');
  if (!/^\d+\.\d+\.\d+/.test(state.course.version)) problems.push(`Version "${state.course.version}" is not valid semver.`);
  for (const [i, step] of state.course.steps.entries()) {
    if (ids.has(step.id)) problems.push(`Duplicate step ID: ${step.id}`);
    ids.add(step.id);
    const fileContents = new Map<string, { label: string; path: string; content: string }>();
    for (const [label, path] of Object.entries({ instructions: step.instructions, validator: step.validator, starter: step.starter, solution: step.solution })) {
      if (!path) {
        if (label === 'instructions') problems.push(`Step ${i + 1} has no instructions path.`);
        continue;
      }
      if (path.includes('..')) problems.push(`Step ${i + 1} ${label} path is unsafe: ${path}`);
      const content = await readFile(path);
      if (!content && label !== 'starter' && label !== 'solution') problems.push(`Step ${i + 1} ${label} file is missing or empty: ${path}`);
      fileContents.set(label, { label, path, content });
    }
    const validator = fileContents.get('validator')?.content ?? '';
    const validatorSyntax = getJavaScriptSyntaxError(validator);
    if (validatorSyntax) {
      problems.push(`Step ${i + 1} validator JavaScript syntax: ${validatorSyntax}`);
    }
    for (const warning of staticValidatorWarnings(validator)) {
      problems.push(`Step ${i + 1} validator risk: ${warning}`);
    }
    for (const file of fileContents.values()) {
      for (const assetPath of findAssetReferences(file.content, file.path)) {
        if (!availableAssets.has(assetPath)) problems.push(`Broken asset link in step ${i + 1} ${file.label}: ${assetPath}`);
      }
    }
  }
  showTextDialog('Course Validation', problems.length ? problems.map((p) => `• ${p}`).join('\n') : '✓ No course structure issues found.');
}

function findAssetReferences(content: string, sourcePath: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    /["'`]((?:(?:\.{1,2}\/)+|\/)?assets\/[^"'`\s)]+)["'`]/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const normalized = normalizeAssetReference(match[1], sourcePath);
      if (normalized) refs.add(normalized);
    }
  }

  return [...refs];
}

function normalizeAssetReference(ref: string, sourcePath: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(ref)) return null;
  const withoutAnchor = ref.split(/[?#]/, 1)[0];
  if (!withoutAnchor) return null;

  const sourceDir = sourcePath.split('/').slice(0, -1);
  const parts = withoutAnchor.startsWith('/')
    ? withoutAnchor.slice(1).split('/')
    : [...sourceDir, ...withoutAnchor.split('/')];
  const normalized: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }

  const assetIndex = normalized.indexOf('assets');
  return assetIndex >= 0 ? normalized.slice(assetIndex).join('/') : null;
}

function staticValidatorWarnings(code: string): string[] {
  const warnings: string[] = [];
  if (/rm\s+-rf|fs\.rmSync|fs\.unlinkSync/.test(code)) warnings.push('destructive file deletion command/API');
  if (/\bsudo\b/.test(code)) warnings.push('uses sudo');
  if (/curl\s+[^|]+\|\s*(sh|bash)/.test(code)) warnings.push('pipes network script into a shell');
  if (/\.\.\//.test(code)) warnings.push('references parent directories');
  if (/while\s*\(\s*true\s*\)|setInterval/.test(code)) warnings.push('may run indefinitely');
  if (/path\/to\/file|expected content|Missing expected content/.test(code)) warnings.push('still contains placeholder snippet text');
  if (/\.toUpperC\b/.test(code)) warnings.push('possible typo: did you mean .toUpperCase()?');
  return warnings;
}

function getJavaScriptSyntaxError(source: string): string | null {
  const normalized = normalizeForSyntaxCheck(source);
  if (!normalized.trim()) return null;
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: { token: string; line: number }[] = [];
  let quote: '"' | "'" | '`' | null = null;
  let line = 1;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === '\n') line++;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < normalized.length && normalized[i] !== '\n') i++;
      i--;
      continue;
    }
    if (ch === '/' && next === '*') {
      const startLine = line;
      i += 2;
      while (i < normalized.length && !(normalized[i] === '*' && normalized[i + 1] === '/')) {
        if (normalized[i] === '\n') line++;
        i++;
      }
      if (i >= normalized.length) return `Unterminated block comment starting on line ${startLine}`;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push({ token: ch, line });
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if (!open || open.token !== pairs[ch]) return `Unexpected "${ch}" on line ${line}`;
    }
  }
  if (quote) return `Unterminated ${quote === '`' ? 'template' : 'string'} literal`;
  const open = stack.pop();
  return open ? `Unclosed "${open.token}" from line ${open.line}` : null;
}

function exportCourseSchema(): void {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Instrktr Course',
    type: 'object',
    required: ['id', 'title', 'version', 'engineVersion', 'steps'],
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
      title: { type: 'string', minLength: 1 },
      version: { type: 'string', pattern: '^\\\\d+\\\\.\\\\d+\\\\.\\\\d+' },
      engineVersion: { type: 'string' },
      description: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'title', 'instructions', 'hints'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            instructions: { type: 'string' },
            hints: { type: 'array', items: { type: 'string' } },
            validator: { type: 'string' },
            starter: { type: 'string' },
            solution: { type: 'string' },
          },
        },
      },
    },
  };
  const content = JSON.stringify(schema, null, 2) + '\n';
  fileCache['course.schema.json'] = content;
  post({ command: 'writeFile', filePath: 'course.schema.json', content });
  showTextDialog('Schema exported', 'course.schema.json was written to the course root.');
}

function generateReadme(): void {
  if (!state.course) return;
  pushUndo();
  saveCurrentTabContent(false);
  const lines = [
    `# ${state.course.title}`,
    '',
    state.course.description ?? '',
    '',
    `Version: ${state.course.version}`,
    `Engine: ${state.course.engineVersion}`,
    '',
    '## Steps',
    '',
    ...state.course.steps.flatMap((s, i) => [`${i + 1}. **${s.title}** (${s.id})`, `   - Instructions: \`${s.instructions}\``, s.validator ? `   - Validator: \`${s.validator}\`` : '']),
    '',
  ];
  const content = lines.filter((line) => line !== undefined).join('\n');
  fileCache['README.md'] = content;
  post({ command: 'writeFile', filePath: 'README.md', content });
  markDirty();
  showTextDialog('README generated', 'README.md was generated in the course root. Save the course to keep metadata changes.');
}

async function renumberStepPaths(): Promise<void> {
  if (!state.course) return;
  pushUndo();
  const writes: FileWrite[] = [];
  for (const [i, step] of state.course.steps.entries()) {
    const dir = `steps/${String(i + 1).padStart(2, '0')}-${step.id}`;
    for (const key of ['instructions', 'validator', 'starter', 'solution'] as const) {
      const oldPath = step[key];
      if (!oldPath) continue;
      const filename = oldPath.split('/').pop() || `${key}.md`;
      const newPath = `${dir}/${filename}`;
      if (oldPath === newPath) continue;
      const content = fileCache[oldPath] ?? await readFile(oldPath);
      fileCache[newPath] = content;
      writes.push({ filePath: newPath, content });
      pendingDeletedFilePaths.add(oldPath);
      step[key] = newPath;
    }
  }
  for (const write of writes) post({ command: 'writeFile', filePath: write.filePath, content: write.content });
  if (writes.length) {
    markDirty();
    render();
  }
}

async function generateSampleCourse(): Promise<void> {
  if (!state.course) return;
  if (!await confirmDialog('Generate Sample Course', 'Replace current course with a 3-step sample course?', 'Replace')) return;
  pushUndo();
  state.course.title = state.course.title || 'Sample Instrktr Course';
  state.course.description = state.course.description || 'A generated sample course with starter files and validators.';
  state.course.steps = [
    {
      id: 'read-readme',
      title: 'Read the README',
      instructions: 'steps/01-read-readme/instructions.md',
      hints: ['Look for the Getting Started heading.'],
      validator: 'steps/01-read-readme/validate.js',
    },
    {
      id: 'write-function',
      title: 'Write a Function',
      instructions: 'steps/02-write-function/instructions.md',
      hints: ['Export the function with module.exports.'],
      validator: 'steps/02-write-function/validate.js',
      starter: 'steps/02-write-function/starter.js',
      solution: 'steps/02-write-function/solution.js',
    },
    {
      id: 'run-tests',
      title: 'Run Tests',
      instructions: 'steps/03-run-tests/instructions.md',
      hints: ['Use npm test.'],
      validator: 'steps/03-run-tests/validate.js',
    },
  ];
  const writes: FileWrite[] = [
    { filePath: 'steps/01-read-readme/instructions.md', content: '# Read the README\n\nOpen README.md and add a Getting Started section.\n' },
    { filePath: 'steps/01-read-readme/validate.js', content: wrapValidatorBody("  const readme = await context.files.read('README.md');\n  if (!/^## Getting Started$/m.test(readme)) return context.fail('Add ## Getting Started to README.md.');\n  return context.pass('README section found!');") },
    { filePath: 'steps/02-write-function/instructions.md', content: '# Write a Function\n\nImplement greet(name) in solution.js.\n' },
    { filePath: 'steps/02-write-function/starter.js', content: 'function greet(name) {\\n  // TODO\\n}\\nmodule.exports = { greet };\\n' },
    { filePath: 'steps/02-write-function/solution.js', content: 'function greet(name) {\\n  return `Hello, ${name}!`;\\n}\\nmodule.exports = { greet };\\n' },
    { filePath: 'steps/02-write-function/validate.js', content: wrapValidatorBody("  const { stdout, exitCode } = await context.terminal.run('node -e \"const {greet}=require(\\\\\\'./steps/02-write-function/solution\\\\\\');console.log(greet(\\\\\\'Ada\\\\\\'))\"');\n  if (exitCode !== 0 || !stdout.includes('Ada')) return context.fail('greet(name) is not working yet.');\n  return context.pass('Function works!');") },
    { filePath: 'steps/03-run-tests/instructions.md', content: '# Run Tests\n\nRun npm test and make it pass.\n' },
    { filePath: 'steps/03-run-tests/validate.js', content: wrapValidatorBody("  const { stdout, stderr, exitCode } = await context.terminal.run('npm test');\n  if (exitCode !== 0) return context.fail(`Tests failed:\\n${stderr || stdout}`);\n  return context.pass('Tests pass!');") },
  ];
  for (const write of writes) {
    queueFileWrite(write.filePath, write.content);
  }
  state.selectedStep = 0;
  state.activeTab = 'instructions';
  markDirty();
  render();
}

function previewAsset(path: string): void {
  const asset = state.assets.find((a) => a.relativePath === path);
  if (!asset) return;
  const body = asset.isImage && asset.webviewUri
    ? `<img src="${escapeHtml(asset.webviewUri)}" alt="${escapeHtml(asset.filename)}" class="asset-preview-image"><p>${escapeHtml(asset.relativePath)} · ${fmtBytes(asset.size)}</p>`
    : `${asset.relativePath} · ${fmtBytes(asset.size)}`;
  showHtmlDialog(asset.filename, body);
}

function showTextDialog(title: string, text: string): void {
  showHtmlDialog(title, `<pre class="dialog-pre">${escapeHtml(text)}</pre>`);
}

function showHtmlDialog(title: string, html: string): void {
  const overlay = el('div', { class: 'dialog-overlay' });
  const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' });
  dialog.appendChild(el('div', { class: 'dialog-title' }, title));
  const body = el('div', { class: 'dialog-body' });
  body.innerHTML = html;
  dialog.appendChild(body);
  const close = el('button', { class: 'btn btn-secondary' }, 'Close');
  close.onclick = () => overlay.remove();
  const actions = el('div', { class: 'dialog-actions' }, close);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  dialog.focus();
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function renderSearchResults(): void {
  const box = document.getElementById('search-results');
  const restore = document.getElementById('restore-step-btn');
  if (restore) restore.classList.toggle('hidden', pendingDeletedSteps.length === 0);
  if (!box || !state.course) return;
  const q = courseSearch.trim().toLowerCase();
  box.innerHTML = '';
  box.classList.toggle('hidden', !q);
  if (!q) return;
  const matches = state.course.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => [step.title, step.id, ...step.hints, step.instructions, step.validator ?? '', step.starter ?? '', step.solution ?? '']
      .some((v) => v.toLowerCase().includes(q)));
  if (matches.length === 0) {
    box.appendChild(el('div', { class: 'assets-empty' }, 'No matches.'));
    return;
  }
  for (const { step, index } of matches) {
    const row = el('button', { class: 'search-result btn btn-ghost btn-sm', 'data-index': String(index) }, `${index + 1}. ${step.title}`);
    row.addEventListener('click', () => {
      saveCurrentTabContent();
      state.selectedStep = index;
      state.activeTab = 'instructions';
      saveState();
      render();
    });
    box.appendChild(row);
  }
}

function attachStepListListeners(): void {
  document.querySelectorAll<HTMLElement>('.step-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.action === 'delete-step') return;
      const idx = parseInt(item.dataset.index ?? '-1', 10);
      if (idx !== state.selectedStep) {
        saveCurrentTabContent();
        state.selectedStep = idx;
        state.activeTab = 'instructions';
        saveState();
        render();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action="delete-step"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.course) return;
      const idx = parseInt(btn.dataset.index ?? '-1', 10);
      const step = state.course.steps[idx];
      if (!step) return;
      pushUndo();
      const stepDir = step.instructions?.split('/').slice(0, -1).join('/');
      const filePaths = [stepDir, step.instructions, step.validator, step.starter, step.solution].filter(Boolean) as string[];
      filePaths.forEach((fp) => pendingDeletedFilePaths.add(fp));
      pendingDeletedSteps.push(step);
      state.course.steps.splice(idx, 1);
      if (state.selectedStep >= state.course.steps.length) state.selectedStep = state.course.steps.length - 1;
      markDirty();
      render();
    });
  });

  document.querySelector<HTMLButtonElement>('[data-action="add-step"]')?.addEventListener('click', async () => {
    if (!state.course) return;
    const title = await promptDialog('New Step', 'Enter a title for the new step:', 'Step title…');
    if (!title) return;
    pushUndo();
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const stepIndex = state.course.steps.length;
    const newStep: StepDef = { id, title, instructions: '', hints: [] };
    state.course.steps.push(newStep);
    state.selectedStep = stepIndex;
    state.activeTab = 'instructions';
    markDirty();
    render();
    post({ command: 'createStepScaffold', stepIndex, step: newStep });
  });

  // Drag-to-reorder
  const list = document.getElementById('steps-list');
  if (!list) return;

  list.addEventListener('dragstart', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.step-item');
    if (!item) return;
    dragSourceIndex = parseInt(item.dataset.index ?? '-1', 10);
    item.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragend', (e) => {
    (e.target as HTMLElement).closest<HTMLElement>('.step-item')?.classList.remove('dragging');
    document.querySelectorAll('.step-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const item = (e.target as HTMLElement).closest<HTMLElement>('.step-item');
    document.querySelectorAll('.step-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
    if (item) item.classList.add('drag-over');
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!state.course) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>('.step-item');
    if (!item) return;
    const dropIndex = parseInt(item.dataset.index ?? '-1', 10);
    if (dropIndex === dragSourceIndex || dragSourceIndex === -1) return;
    pushUndo();
    const [moved] = state.course.steps.splice(dragSourceIndex, 1);
    state.course.steps.splice(dropIndex, 0, moved);
    if (state.selectedStep === dragSourceIndex) state.selectedStep = dropIndex;
    else if (dragSourceIndex < state.selectedStep && dropIndex >= state.selectedStep) state.selectedStep--;
    else if (dragSourceIndex > state.selectedStep && dropIndex <= state.selectedStep) state.selectedStep++;
    dragSourceIndex = -1;
    markDirty();
    render();
  });
}

// ─── Save logic ───────────────────────────────────────────────────────────────

function saveCurrentTabContent(persistWrites = true): FileWrite[] {
  const fileWrites: FileWrite[] = [];
  if (!state.course || state.selectedStep === -1) return fileWrites;
  const step = state.course.steps[state.selectedStep];
  if (!step) return fileWrites;

  const instructionsTa = document.getElementById('instructions-editor') as HTMLTextAreaElement | null;
  if (instructionsTa && step.instructions) {
    fileCache[step.instructions] = instructionsTa.value;
    fileWrites.push({ filePath: step.instructions, content: instructionsTa.value });
  }

  const validatorTa = document.getElementById('validator-editor') as HTMLTextAreaElement | null;
  if (validatorTa && step.validator) {
    const content = wrapValidatorBody(validatorTa.value);
    fileCache[step.validator] = content;
    fileWrites.push({ filePath: step.validator, content });
  }

  const starterTa = document.getElementById('starter-editor') as HTMLTextAreaElement | null;
  if (starterTa && step.starter) {
    fileCache[step.starter] = starterTa.value;
    fileWrites.push({ filePath: step.starter, content: starterTa.value });
  }

  const solutionTa = document.getElementById('solution-editor') as HTMLTextAreaElement | null;
  if (solutionTa && step.solution) {
    fileCache[step.solution] = solutionTa.value;
    fileWrites.push({ filePath: step.solution, content: solutionTa.value });
  }

  const stepId = (document.getElementById('step-id') as HTMLInputElement | null)?.value;
  const stepTitle = (document.getElementById('step-title') as HTMLInputElement | null)?.value;
  if (stepId) step.id = stepId;
  if (stepTitle) step.title = stepTitle;

  if (persistWrites) {
    for (const write of fileWrites) {
      post({ command: 'writeFile', filePath: write.filePath, content: write.content });
    }
  }

  return fileWrites;
}

function handleSave(): void {
  if (!state.course) return;
  const fileWrites = collectPendingFileWrites(saveCurrentTabContent(false));
  post({
    command: 'saveCourse',
    course: state.course,
    fileWrites,
    fileDeletes: Array.from(pendingDeletedFilePaths),
  });
}

async function requireSavedChanges(actionLabel: string): Promise<boolean> {
  if (!state.isDirty && pendingDeletedFilePaths.size === 0 && pendingFileWrites.size === 0) return true;
  if (await confirmDialog('Save Changes', `You have unsaved changes. Save before ${actionLabel}?`, 'Save')) {
    handleSave();
  }
  return false;
}

async function handlePublish(): Promise<void> {
  if (!state.course) return;
  if (!await requireSavedChanges('publishing')) return;
  const repo = (document.getElementById('pub-repo') as HTMLInputElement | null)?.value.trim() ?? '';
  const tagsRaw = (document.getElementById('pub-tags') as HTMLInputElement | null)?.value.trim() ?? '';
  const createRepo = (document.getElementById('pub-create-repo') as HTMLInputElement | null)?.checked ?? false;
  const addToRegistry = Boolean(authorSettings.defaultRegistryRepo)
    || ((document.getElementById('pub-add-registry') as HTMLInputElement | null)?.checked ?? false);
  const registryRepoRaw = (document.getElementById('pub-registry-repo') as HTMLInputElement | null)?.value.trim() ?? '';
  const registryPath = (document.getElementById('pub-registry-path') as HTMLInputElement | null)?.value.trim() || authorSettings.defaultRegistryPath;
  const registryRepo = addToRegistry ? normalizeGitHubRepoInput(registryRepoRaw) : '';
  const bumpType = (document.querySelector<HTMLInputElement>('input[name="bump-type"]:checked')?.value as
    'major' | 'minor' | 'patch' | 'none') ?? 'patch';

  if (!repo || !/^[\w.\-]+\/[\w.\-]+$/.test(repo)) {
    const area = document.getElementById('publish-progress');
    if (area) { area.classList.remove('hidden'); area.innerHTML = '<div class="progress-msg error">✕ Enter a valid GitHub repo (owner/repo-name).</div>'; }
    return;
  }
  if (addToRegistry && !registryRepo) {
    const area = document.getElementById('publish-progress');
    if (area) { area.classList.remove('hidden'); area.innerHTML = '<div class="progress-msg error">✕ Enter a valid registry repo (owner/repo or GitHub URL).</div>'; }
    return;
  }
  if (addToRegistry && (!registryPath || registryPath.includes('..') || registryPath.startsWith('/'))) {
    const area = document.getElementById('publish-progress');
    if (area) { area.classList.remove('hidden'); area.innerHTML = '<div class="progress-msg error">✕ Enter a safe registry filename/path.</div>'; }
    return;
  }
  const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const fileWrites = collectPendingFileWrites(saveCurrentTabContent(false));
  const nextVersion = bumpType === 'none' ? state.course.version : bumpPreview(state.course.version, bumpType);
  const confirmed = await confirmDialog(
    'Publish Course',
    `Publish dry run:\n\nRepo: ${repo}${createRepo ? ' (create if missing)' : ''}\nRegistry repo: ${registryRepo || '(Gist only)'}${registryRepo ? `\nRegistry file: ${registryPath}` : ''}\nVersion: ${state.course.version} → ${nextVersion}\nTags: ${tags.join(', ') || '(none)'}\nRegistry entry: ${state.course.id} / ${state.course.title}\n\nThis will ${createRepo ? 'create a public repo if needed, ' : ''}commit the current course files to GitHub, tag that commit, create a release, update the registry Gist${registryRepo ? ', and update the registry repo' : ''}.\n\nProceed?`,
    'Publish',
  );
  if (!confirmed) return;
  post({
    command: 'publishCourse',
    repo,
    tags,
    bumpType,
    createRepo,
    registryRepo: registryRepo || undefined,
    registryPath: registryRepo ? registryPath : undefined,
    course: state.course,
    fileWrites,
    fileDeletes: Array.from(pendingDeletedFilePaths),
  });
}

function normalizeGitHubRepoInput(value: string): string {
  const trimmed = value.trim();
  const short = trimmed.match(/^([\w.\-]+)\/([\w.\-]+)$/);
  if (short) return `${short[1]}/${short[2]}`;
  const url = trimmed.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return url ? `${url[1]}/${url[2]}` : '';
}

// ─── Feature 2: Course Preview overlay ───────────────────────────────────────

function showPreviewOverlay(): void {
  if (!state.course) return;
  const course = state.course;

  let previewStep = state.selectedStep >= 0 ? state.selectedStep : 0;
  let hintsShown = 0;
  let running = false;
  let lastResult: ValidatorTestResult | null = null;

  const overlay = el('div', { class: 'dialog-overlay preview-overlay', id: 'preview-overlay' });
  const dialog = el('div', { class: 'dialog preview-dialog' });

  const refreshPreview = () => {
    dialog.innerHTML = '';
    const step = course.steps[previewStep];
    if (!step) { overlay.remove(); return; }

    const header = el('div', { class: 'preview-header' });
    const nav = el('div', { class: 'preview-nav' });
    if (previewStep > 0) {
      const prevBtn = el('button', { class: 'btn btn-ghost btn-sm' }, '← Prev');
      prevBtn.onclick = () => { previewStep--; hintsShown = 0; lastResult = null; refreshPreview(); };
      nav.appendChild(prevBtn);
    }
    const progress = previewProgress[step.id] ? ` · ${previewProgress[step.id]}` : '';
    nav.appendChild(el('span', { class: 'preview-step-label' }, `Step ${previewStep + 1} / ${course.steps.length}${progress}`));
    if (previewStep < course.steps.length - 1) {
      const nextBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Next →');
      nextBtn.onclick = () => { previewStep++; hintsShown = 0; lastResult = null; refreshPreview(); };
      nav.appendChild(nextBtn);
    }
    header.appendChild(nav);
    const closeBtn = el('button', { class: 'btn btn-ghost btn-icon preview-close-btn' }, '×');
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // Instructions
    const instructionsHtml = fileCache[step.instructions]
      ? renderMarkdown(fileCache[step.instructions])
      : '<div class="preview-placeholder">Instructions not loaded — save your work and try again.</div>';
    const body = el('div', { class: 'preview-body' });
    body.innerHTML = instructionsHtml;
    dialog.appendChild(body);

    // Hints
    if (step.hints.length > 0) {
      const hintsArea = el('div', { class: 'preview-hints' });
      for (let i = 0; i < hintsShown; i++) {
        const h = el('div', { class: 'preview-hint' });
        h.appendChild(el('span', { class: 'hint-icon' }, '💡'));
        h.appendChild(document.createTextNode(` ${step.hints[i]}`));
        hintsArea.appendChild(h);
      }
      if (hintsShown < step.hints.length) {
        const hintBtn = el('button', { class: 'btn btn-ghost btn-sm' }, `Show Hint (${step.hints.length - hintsShown} left)`);
        hintBtn.onclick = () => { hintsShown++; refreshPreview(); };
        hintsArea.appendChild(hintBtn);
      }
      dialog.appendChild(hintsArea);
    }

    // Validator result
    if (lastResult) {
      const resultDiv = el('div', { class: 'preview-result' });
      renderValidatorResult(resultDiv, lastResult);
      dialog.appendChild(resultDiv);
    }

    // Actions
    const actions = el('div', { class: 'preview-actions' });
    if (step.validator) {
      const checkBtn = el('button', { class: 'btn btn-primary', ...(running ? { disabled: 'true' } : {}) }, running ? '⟳ Checking…' : 'Check Work');
      checkBtn.onclick = async () => {
        if (running) return;
        if (!await requireSavedChanges('running the preview validator')) return;
        running = true;
        const fileWrites = saveCurrentTabContent(false);
        const risky = fileWrites.some((w) => /terminal\.(?:run|runShell)|child_process|rm\s+-|sudo|curl\s+.*\|\s*(sh|bash)/.test(w.content));
        if (risky && !await confirmDialog('Run Preview Validator', 'This validator may run shell commands. Run it in author test mode anyway?', 'Run Validator')) { running = false; return; }
        lastResult = null;
        refreshPreview();
        post({ command: 'runValidator', stepIndex: previewStep, course, fileWrites });

        const waitForResult = (event: MessageEvent) => {
          const msg = event.data as ExtensionMessage;
          if (msg.command === 'validatorResult') {
            window.removeEventListener('message', waitForResult);
            running = false;
            lastResult = msg.result;
            previewProgress[step.id] = msg.result.status;
            // Also update normal validator result tracking
            validatorResult = msg.result;
            refreshPreview();
          }
        };
        window.addEventListener('message', waitForResult);
      };
      actions.appendChild(checkBtn);
    }
    dialog.appendChild(actions);
  };

  refreshPreview();
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ─── Feature 3: Step template dialog ─────────────────────────────────────────

function showTemplateDialog(): void {
  if (!state.course || state.selectedStep === -1) return;
  const overlay = el('div', { class: 'dialog-overlay', id: 'template-dialog' });
  const dialog = el('div', { class: 'dialog template-dialog' });

  dialog.appendChild(el('div', { class: 'dialog-title' }, 'Step Templates'));
  dialog.appendChild(el('p', { class: 'dialog-body' }, 'Choose a template to pre-fill this step\'s instructions, validator, and starter files.'));

  const useTemplate = async (tpl: StepTemplate) => {
    const files = getTemplateAffectedFiles(tpl);
    if (!await confirmDialog('Apply Template', `Apply "${tpl.name}"?\n\nThis will update/create:\n- ${files.join('\n- ')}`, 'Apply')) return;
    applyTemplate(tpl);
    overlay.remove();
  };

  const grid = el('div', { class: 'template-grid' });
  for (const tpl of STEP_TEMPLATES) {
    const card = el('div', { class: 'template-card' });
    card.appendChild(el('span', { class: 'tpl-icon' }, tpl.icon));
    card.appendChild(el('div', { class: 'tpl-name' }, tpl.name));
    card.appendChild(el('div', { class: 'tpl-desc' }, tpl.description));
    const tags = el('div', { class: 'tpl-tags' });
    tpl.tags.forEach((t) => tags.appendChild(el('span', { class: 'tpl-tag' }, t)));
    card.appendChild(tags);
    const useBtn = el('button', { class: 'btn btn-primary btn-sm tpl-use-btn', type: 'button' }, 'Use Template');
    useBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void useTemplate(tpl);
    });
    card.appendChild(useBtn);
    card.addEventListener('dblclick', () => void useTemplate(tpl));
    grid.appendChild(card);
  }
  dialog.appendChild(grid);

  const actions = el('div', { class: 'dialog-actions' });
  const cancel = el('button', { class: 'btn btn-secondary' }, 'Cancel');
  cancel.onclick = () => overlay.remove();
  actions.appendChild(cancel);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function getStepDir(step: StepDef): string {
  return step.instructions?.split('/').slice(0, -1).join('/')
    || `steps/${String(state.selectedStep + 1).padStart(2, '0')}-${step.id}`;
}

function resolveTemplatePath(step: StepDef, filePath: string): string {
  return filePath.includes('/') ? filePath : `${getStepDir(step)}/${filePath}`;
}

function ensureTemplateStepFiles(step: StepDef): void {
  const dir = getStepDir(step);
  step.instructions ||= `${dir}/instructions.md`;
  step.validator ||= `${dir}/validate.js`;
}

function getTemplateAffectedFiles(tpl: StepTemplate): string[] {
  const step = state.course?.steps[state.selectedStep];
  if (!step) return ['instructions', 'validator', ...(tpl.starterFiles ?? []).map((f) => f.path)];
  const dir = getStepDir(step);
  return [
    step.instructions || `${dir}/instructions.md`,
    step.validator || `${dir}/validate.js`,
    ...(tpl.starterFiles ?? []).map((f) => resolveTemplatePath(step, f.path)),
  ];
}

function applyTemplate(tpl: StepTemplate): void {
  if (!state.course || state.selectedStep === -1) return;
  pushUndo();
  const step = state.course.steps[state.selectedStep];
  ensureTemplateStepFiles(step);

  // Update instructions cache and textarea
  if (step.instructions) {
    queueFileWrite(step.instructions, tpl.instructions);
    const ta = document.getElementById('instructions-editor') as HTMLTextAreaElement | null;
    if (ta) ta.value = tpl.instructions;
  }

  // Update validator body cache and textarea
  if (step.validator) {
    const fullValidator = wrapValidatorBody(tpl.validatorBody);
    queueFileWrite(step.validator, fullValidator);
    const ta = document.getElementById('validator-editor') as HTMLTextAreaElement | null;
    if (ta) ta.value = tpl.validatorBody;
  }

  for (const starter of tpl.starterFiles ?? []) {
    const targetPath = resolveTemplatePath(step, starter.path);
    queueFileWrite(targetPath, starter.content);
    if (!step.starter && /\.(?:js|ts|json)$/.test(targetPath)) step.starter = targetPath;
  }

  markDirty();
  saveState();
  render();
}

// ─── Validator body helpers ───────────────────────────────────────────────────

function extractValidatorBody(source: string): string {
  if (!source.trim()) return '';
  const match = source.match(/module\.exports\s*=\s*async\s+function\s+validate\s*\([^)]*\)\s*\{([\s\S]*)\};?\s*$/);
  return match ? match[1].replace(/^\n/, '').replace(/\n$/, '') : source;
}

function wrapValidatorBody(body: string): string {
  return `module.exports = async function validate(context) {\n${body}\n};\n`;
}

function getJsEditorSource(kind: 'validator' | 'starter' | 'solution'): string {
  const ta = document.getElementById(`${kind}-editor`) as HTMLTextAreaElement | null;
  const value = ta?.value ?? '';
  return kind === 'validator' ? wrapValidatorBody(value) : value;
}

function normalizeForSyntaxCheck(source: string): string {
  // The lightweight checker runs in a classic Function parser. Allow common ESM
  // source forms by converting imports/exports to parse-only placeholders.
  return source
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+(?=(async\s+)?function|class|const|let|var)\s*/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
}

function updateSyntaxStatus(kind: 'validator' | 'starter' | 'solution'): void {
  const area = document.getElementById(`${kind}-syntax-status`);
  if (!area) return;
  if (authorSettings.syntaxStatus === 'off') {
    area.textContent = '';
    area.className = 'syntax-status';
    return;
  }
  const source = getJsEditorSource(kind);
  if (!source.trim()) {
    area.textContent = '';
    area.className = 'syntax-status';
    return;
  }
  const syntaxError = getJavaScriptSyntaxError(source);
  if (!syntaxError) {
    area.textContent = authorSettings.syntaxStatus === 'always' ? '✓ JavaScript syntax OK' : '';
    area.className = 'syntax-status syntax-ok';
  } else {
    area.textContent = `⚠ JavaScript syntax: ${syntaxError}`;
    area.className = 'syntax-status syntax-error';
  }
}

function insertSnippet(textarea: HTMLTextAreaElement, snippet: string): void {
  const { selectionStart: start, selectionEnd: end } = textarea;
  textarea.focus();
  textarea.setSelectionRange(start, end);
  // execCommand('insertText') preserves native textarea undo in VS Code webviews.
  // Fall back to setRangeText where the browser no longer supports execCommand.
  if (!document.execCommand('insertText', false, snippet)) {
    textarea.setRangeText(snippet, start, end, 'end');
  }
  textarea.focus();
  textarea.dispatchEvent(new Event('input'));
}

async function parameterizeSnippet(code: string): Promise<string> {
  const jsStringLiteral = (value: string): string => JSON.stringify(value);
  const jsStringContent = (value: string): string => JSON.stringify(value).slice(1, -1);
  let out = code;
  const replacements: [RegExp, () => Promise<string>][] = [
    [/'path\/to\/file\.txt'/g, async () => jsStringLiteral(await promptDialog('Snippet Parameter', 'File path:', 'path/to/file.txt') ?? 'path/to/file.txt')],
    [/'http:\/\/localhost:3000\/health'/g, async () => jsStringLiteral(await promptDialog('Snippet Parameter', 'Endpoint URL:', 'http://localhost:3000/health') ?? 'http://localhost:3000/health')],
    [/'npm test'/g, async () => jsStringLiteral(await promptDialog('Snippet Parameter', 'Command:', 'npm test') ?? 'npm test')],
    [/expected output/g, async () => jsStringContent(await promptDialog('Snippet Parameter', 'Expected output text:', 'expected output') ?? 'expected output')],
  ];
  for (const [pattern, getValue] of replacements) {
    if (pattern.test(out)) out = out.replace(pattern, await getValue());
  }
  return out;
}

async function addCustomSnippet(): Promise<void> {
  const label = await promptDialog('Custom Snippet', 'Snippet label:', 'Check README heading');
  if (!label) return;
  const description = await promptDialog('Custom Snippet', 'Short description:', 'Validates course-specific work');
  if (description === null) return;
  const code = await promptDialog('Custom Snippet', 'Validator body code:', "  return context.pass('Looks good!');");
  if (!code) return;
  const snippets = [...state.customSnippets, {
    id: `custom-${Date.now()}`,
    label,
    description,
    code,
  }];
  state.customSnippets = snippets;
  saveState();
  post({ command: 'saveCustomSnippets', snippets });
  render();
}

// ─── Preview toggle for instructions ─────────────────────────────────────────

function toggleMarkdownPreview(): void {
  const editorPane = document.getElementById('editor-pane');
  const previewPane = document.getElementById('preview-pane');
  const toggleBtn = document.getElementById('preview-toggle');
  if (!editorPane || !previewPane) return;

  previewVisible = !previewVisible;
  if (previewVisible) {
    const md = (document.getElementById('instructions-editor') as HTMLTextAreaElement | null)?.value ?? '';
    previewPane.innerHTML = renderMarkdown(md);
    editorPane.classList.remove('active');
    previewPane.classList.add('active');
    if (toggleBtn) toggleBtn.textContent = 'Edit';
  } else {
    editorPane.classList.add('active');
    previewPane.classList.remove('active');
    if (toggleBtn) toggleBtn.textContent = 'Preview';
  }
}

// ─── Generic prompt dialog ────────────────────────────────────────────────────

function promptDialog(title: string, body: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'dialog-overlay' });
    const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    dialog.appendChild(el('div', { class: 'dialog-title' }, title));
    dialog.appendChild(el('p', { class: 'dialog-body' }, body));
    const input = el('input', { class: 'field-input', type: 'text', placeholder });
    dialog.appendChild(input);
    const actions = el('div', { class: 'dialog-actions' });
    const cancel = el('button', { class: 'btn btn-secondary' }, 'Cancel');
    const confirm = el('button', { class: 'btn btn-primary' }, 'Create');
    const finish = (v: string | null) => { overlay.remove(); resolve(v); };
    cancel.onclick = () => finish(null);
    confirm.onclick = () => { const v = input.value.trim(); if (v) finish(v); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = input.value.trim(); if (v) finish(v); }
      else if (e.key === 'Escape') finish(null);
    });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
  });
}

function confirmDialog(title: string, body: string, confirmLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'dialog-overlay' });
    const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    dialog.appendChild(el('div', { class: 'dialog-title' }, title));
    dialog.appendChild(el('p', { class: 'dialog-body' }, body));
    const actions = el('div', { class: 'dialog-actions' });
    const cancel = el('button', { class: 'btn btn-secondary' }, 'Cancel');
    const confirm = el('button', { class: 'btn btn-primary' }, confirmLabel);
    const finish = (confirmed: boolean) => { overlay.remove(); resolve(confirmed); };
    cancel.onclick = () => finish(false);
    confirm.onclick = () => finish(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter') finish(true);
    });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    confirm.focus();
  });
}

// ─── Quick snippet chips ──────────────────────────────────────────────────────

const QUICK_SNIPPETS = [
  { label: 'File exists', description: 'Check a file is present', code: `  const exists = await context.files.exists('path/to/file');\n  if (!exists) return context.fail('File not found.');\n  return context.pass('File exists!');` },
  { label: 'Read file', description: 'Read file content and inspect it', code: `  const content = await context.files.read('path/to/file');\n  if (!content.trim()) return context.fail('File is empty.');\n  if (!content.includes('expected')) return context.fail('Missing expected content.');\n  return context.pass('File content is correct!');` },
  { label: 'File matches', description: 'Check file content against a regex', code: `  const ok = await context.files.matches('path/to/file', /expected/i);\n  if (!ok) return context.fail('Content does not match.');\n  return context.pass('Content is correct!');` },
  { label: 'Terminal output', description: 'Check the last command\'s output in the terminal emulator', code: `  const ok = await context.terminal.outputContains('expected output');\n  if (!ok) return context.fail('Expected output not found in terminal.');\n  return context.pass('Terminal output looks correct!');` },
  { label: 'Last command', description: 'Check the last terminal command run by the learner', code: `  const cmd = await context.terminal.lastCommand();\n  if (!cmd.includes('expected')) return context.warn('Run the expected command.');\n  return context.pass('Command run!');` },
  { label: 'Run & check', description: 'Execute a command and check exit code', code: `  const { stdout, exitCode } = await context.terminal.run('your-command');\n  if (exitCode !== 0) return context.fail(\`Failed: \${stdout}\`);\n  return context.pass('Success!');` },
];

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  render();
  post({ command: 'ready' });
});
