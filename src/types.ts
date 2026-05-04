export interface CourseDef {
  id: string;
  title: string;
  version: string;
  engineVersion: string;
  description?: string;
  steps: StepDef[];
  migration?: Record<string, Record<string, string>>;
}

export interface StepDef {
  id: string;
  title: string;
  instructions: string;
  hints: string[];
  validator?: string;
  starter?: string;
  solution?: string;
}

export interface AuthState {
  signedIn: boolean;
  username?: string;
}

export interface PublishHistoryEntry {
  version: string;
  date: string;   // ISO timestamp
  repo: string;
  registryUrl: string;
}

export interface AssetInfo {
  filename: string;
  relativePath: string;  // relative to course root, e.g. "assets/logo.png"
  webviewUri?: string;   // URI safe to use in webview previews
  size: number;
  isImage: boolean;
}

export interface ValidatorTestResult {
  status: 'pass' | 'fail' | 'warn' | 'error';
  message: string;
  duration: number;
  terminalNote?: string;  // set when terminal APIs were mocked
}

export interface FileWrite {
  filePath: string;
  content: string;
}

export interface CustomSnippet {
  id: string;
  label: string;
  description: string;
  code: string;
}

export interface AuthorSettings {
  syntaxStatus: 'off' | 'errors' | 'always';
  syntaxHighlighting: boolean;
  defaultRegistryRepo: string;
  defaultRegistryPath: string;
}

// ─── Webview → Extension ────────────────────────────────────────────────────

export type WebviewMessage =
  | { command: 'ready' }
  | { command: 'saveCourse'; course: CourseDef; fileWrites?: FileWrite[]; fileDeletes?: string[] }
  | { command: 'readFile'; requestId: string; filePath: string }
  | { command: 'writeFile'; filePath: string; content: string }
  | { command: 'renameFile'; oldPath: string; newPath: string; requestId?: string }
  | { command: 'createStepScaffold'; stepIndex: number; step: StepDef }
  | { command: 'deleteFiles'; filePaths: string[] }
  | { command: 'publishCourse'; repo: string; tags: string[]; bumpType: 'major' | 'minor' | 'patch' | 'none'; createRepo?: boolean; registryRepo?: string; registryPath?: string; course?: CourseDef; fileWrites?: FileWrite[]; fileDeletes?: string[] }
  | { command: 'signIn' }
  | { command: 'signOut' }
  | { command: 'listRepos' }
  | { command: 'listWorkspaceCourses' }
  | { command: 'openWorkspaceCourse'; courseDir: string }
  | { command: 'saveCustomSnippets'; snippets: CustomSnippet[] }
  | { command: 'saveSettings'; settings: Partial<AuthorSettings> }
  // Feature 1 – validator testing
  | { command: 'runValidator'; stepIndex: number; course?: CourseDef; fileWrites?: FileWrite[] }
  // Feature 4 – asset management
  | { command: 'importAsset' }
  | { command: 'listAssets' }
  // Feature 5 – course import
  | { command: 'importCourseFromUrl'; url: string }
  | { command: 'importCourseFromLocal' };

// ─── Extension → Webview ────────────────────────────────────────────────────

export type ExtensionMessage =
  | { command: 'setCourse'; course: CourseDef }
  | { command: 'saveResult'; success: boolean; message?: string }
  | { command: 'fileContent'; requestId: string; filePath: string; content: string }
  | { command: 'renameResult'; requestId?: string; oldPath: string; newPath: string; success: boolean; message?: string }
  | { command: 'scaffoldResult'; stepIndex: number; instructions: string; validator: string }
  | { command: 'setAuth'; auth: AuthState }
  | { command: 'setRepos'; repos: string[] }
  | { command: 'setWorkspaceCourses'; courses: string[] }
  | { command: 'setCustomSnippets'; snippets: CustomSnippet[] }
  | { command: 'setSettings'; settings: AuthorSettings }
  | { command: 'setPublishRepo'; repo: string }
  | { command: 'publishProgress'; status: 'progress' | 'success' | 'error'; message: string; registryUrl?: string }
  | { command: 'error'; message: string }
  // Feature 1 – validator testing
  | { command: 'validatorResult'; result: ValidatorTestResult }
  // Feature 4 – asset management
  | { command: 'assetList'; assets: AssetInfo[] }
  | { command: 'assetImported'; asset: AssetInfo }
  // Feature 5 – course import
  | { command: 'importProgress'; status: 'progress' | 'success' | 'error'; message: string }
  | { command: 'importComplete'; courseDir: string }
  // Feature 7 – publish history
  | { command: 'setPublishHistory'; history: PublishHistoryEntry[] };
