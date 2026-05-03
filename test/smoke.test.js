const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('extension manifest wires runtime and marketplace icons', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.icon, 'media/icon.png');
  assert.ok(fs.existsSync(pkg.icon), 'top-level package icon should exist');
  const activityIcon = pkg.contributes.viewsContainers.activitybar[0].icon;
  assert.equal(activityIcon, 'media/icon-instrktr-similar.svg');
  assert.ok(fs.existsSync(activityIcon), 'activity bar icon should exist');
});

test('package exposes extension and webview validation scripts', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts.typecheck, /typecheck:extension/);
  assert.match(scripts.typecheck, /typecheck:webview/);
  assert.match(scripts.package, /--no-dependencies/);
  assert.equal(scripts.test, 'node --test');
});

test('webview preview supports asset image rendering', () => {
  const main = read('webview-src/main.ts');
  const panel = read('src/CourseAuthorPanel.ts');
  assert.match(main, /resolvePreviewAssetUri/);
  assert.match(main, /markdown-image/);
  assert.match(panel, /img-src \$\{csp\} data: https:/);
  assert.match(panel, /localResourceRoots:[\s\S]*courseDir/);
});

test('step templates can scaffold starter files', () => {
  const templates = read('webview-src/stepTemplates.ts');
  const main = read('webview-src/main.ts');
  const styles = read('webview-src/styles.css');
  assert.match(templates, /starterFiles\?:/);
  assert.match(templates, /path: 'solution\.js'/);
  assert.match(templates, /path: 'buggy\.js'/);
  assert.match(main, /tpl\.starterFiles/);
  assert.match(main, /Use Template/);
  assert.match(main, /getTemplateAffectedFiles/);
  assert.match(main, /ensureTemplateStepFiles/);
  assert.match(main, /resolveTemplatePath/);
  assert.match(main, /queueFileWrite/);
  assert.match(styles, /tpl-use-btn/);
});

test('webview exposes authoring workflow helpers', () => {
  const main = read('webview-src/main.ts');
  assert.match(main, /validateCourse/);
  assert.match(main, /getJavaScriptSyntaxError/);
  assert.match(main, /validator JavaScript syntax/);
  assert.match(main, /still contains placeholder snippet text/);
  assert.match(main, /did you mean \.toUpperCase\(\)\?/);
  assert.doesNotMatch(main, /new Function/);
  assert.match(main, /generateReadme/);
  assert.match(main, /renumberStepPaths/);
  assert.match(main, /buildSimpleFileTab/);
  assert.match(main, /selectTab/);
  assert.match(main, /empty-create-starter-btn/);
  assert.match(main, /empty-back-starter-btn/);
  assert.match(main, /pendingDeletedSteps/);
  assert.match(main, /Publish dry run/);
  assert.match(main, /may run shell commands/);
  assert.match(main, /exportCourseSchema/);
  assert.match(main, /generateSampleCourse/);
  assert.match(main, /undoStack/);
  assert.match(main, /parameterizeSnippet/);
  assert.match(main, /JSON\.stringify/);
  assert.match(main, /addCustomSnippet/);
  assert.match(main, /previewProgress/);
  assert.match(main, /updateSyntaxStatus/);
  assert.match(main, /normalizeForSyntaxCheck/);
  assert.match(main, /JavaScript syntax OK/);
  assert.match(main, /data-js-editor/);
  assert.match(main, /syntaxStatus/);
  assert.match(main, /syntaxHighlighting/);
  assert.doesNotMatch(main, /highlight-textarea/);
  assert.match(main, /state\.selectedStep < 0 && msg\.course\.steps\.length > 0/);
});

test('starter and solution empty tabs stay actionable without autosaving', () => {
  const main = read('webview-src/main.ts');
  const styles = read('webview-src/styles.css');
  assert.match(main, /No \$\{kind\} file yet/);
  assert.match(main, /Create \$\{kind\}\.js/);
  assert.match(main, /Back to Instructions/);
  assert.match(main, /function selectTab/);
  assert.match(main, /saveCurrentTabContent\(false\)/);
  const createStepFileBody = main.match(/function createStepFile[\s\S]*?\n}\n\nasync function renameStepFile/)?.[0] ?? '';
  assert.ok(createStepFileBody, 'createStepFile body should be present');
  assert.doesNotMatch(createStepFileBody, /post\(\{ command: 'writeFile'/);
  assert.match(styles, /empty-file-tab/);
});

test('webview avoids native browser dialogs for VS Code interactions', () => {
  const main = read('webview-src/main.ts');
  const styles = read('webview-src/styles.css');
  assert.doesNotMatch(main, /window\.(confirm|prompt)/);
  assert.match(main, /function confirmDialog/);
  assert.match(main, /function promptDialog/);
  assert.match(main, /await confirmDialog\('Apply Template'/);
  assert.match(main, /await requireSavedChanges\('running the validator'\)/);
  assert.match(styles, /white-space: pre-wrap/);
});

test('editor tab handlers are rebound after panel replacement', () => {
  const main = read('webview-src/main.ts');
  const attachBody = main.match(/function attachEditorListeners[\s\S]*?\n}\n\nfunction attachHintListeners/)?.[0] ?? '';
  const eventBody = main.match(/function attachEventListeners[\s\S]*?\n}\n\nfunction attachEditorListeners/)?.[0] ?? '';
  assert.ok(attachBody, 'attachEditorListeners body should be present');
  assert.ok(attachBody.includes("document.querySelectorAll<HTMLButtonElement>('.tab-btn')"));
  assert.match(attachBody, /selectTab\(tab\)/);
  assert.doesNotMatch(eventBody, /querySelectorAll<HTMLButtonElement>\('\\.tab-btn'\)/);
});

test('snippet insertion preserves native textarea undo', () => {
  const main = read('webview-src/main.ts');
  assert.match(main, /execCommand\('insertText'/);
  assert.match(main, /setRangeText\(snippet/);
  assert.match(main, /getElementById\('library-list'\)\?\.addEventListener\('click'/);
  assert.match(main, /Snippet insert failed/);
});

test('file editor async loads do not overwrite local edits', () => {
  const main = read('webview-src/main.ts');
  assert.match(main, /loadFileIntoTextarea/);
  assert.match(main, /textarea\.value !== valueAtRequest/);
  assert.match(main, /document\.contains\(textarea\)/);
});

test('snippet library includes expanded categories', () => {
  const snippets = read('webview-src/snippetLibrary.ts');
  for (const id of [
    'http-api',
    'docker',
    'database',
    'frontend',
    'security',
    'github',
    'm3270',
    'zowe',
    'course-authoring',
  ]) {
    assert.match(snippets, new RegExp(`id: '${id}'`));
  }
  assert.match(snippets, /id: 'fetch-status-ok'/);
  assert.match(snippets, /id: 'docker-image-builds'/);
  assert.match(snippets, /id: 'no-hardcoded-secrets'/);
  assert.match(snippets, /id: 's3270-connect-wait'/);
  assert.match(snippets, /id: 'm3270-script-file-check'/);
  assert.match(snippets, /id: 'zowe-version'/);
});

test('extension exposes repo, course switcher, custom snippet, and file rename messages', () => {
  const types = read('src/types.ts');
  const panel = read('src/CourseAuthorPanel.ts');
  const main = read('webview-src/main.ts');
  assert.match(types, /listRepos/);
  assert.match(types, /listWorkspaceCourses/);
  assert.match(types, /saveCustomSnippets/);
  assert.match(types, /renameFile/);
  assert.match(types, /renameResult/);
  assert.match(panel, /_sendRepos/);
  assert.match(panel, /_sendWorkspaceCourses/);
  assert.match(panel, /customSnippets/);
  assert.match(panel, /_loadSettings/);
  assert.match(panel, /command: 'renameResult'/);
  assert.match(main, /pendingRenames/);
  assert.match(main, /handleRenameResult/);
});

test('dirty course actions prompt users to save first', () => {
  const main = read('webview-src/main.ts');
  assert.match(main, /requireSavedChanges/);
  assert.match(main, /pendingFileWrites\.size/);
  assert.match(main, /collectPendingFileWrites/);
  assert.match(main, /Save before \$\{actionLabel\}/);
  assert.match(main, /running the validator/);
  assert.match(main, /publishing/);
  assert.match(main, /switching courses/);
});

test('sample generation queues all generated files for the next save', () => {
  const main = read('webview-src/main.ts');
  const sampleBody = main.match(/function generateSampleCourse[\s\S]*?\n}\n\nfunction previewAsset/)?.[0] ?? '';
  assert.ok(sampleBody, 'generateSampleCourse body should be present');
  assert.match(sampleBody, /Replace current course with a 3-step sample course/);
  assert.match(sampleBody, /queueFileWrite\(write\.filePath, write\.content\)/);
  assert.doesNotMatch(sampleBody, /post\(\{ command: 'writeFile'/);
});

test('package contributes syntax editor settings', () => {
  const pkg = JSON.parse(read('package.json'));
  const props = pkg.contributes.configuration.properties;
  assert.ok(props['instrktrAuthor.syntaxStatus']);
  assert.ok(props['instrktrAuthor.syntaxHighlighting']);
});

test('ci workflow packages the vsix artifact', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run typecheck/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run package/);
  assert.match(ci, /upload-artifact/);
});

test('publisher explicitly creates version git tag before release', () => {
  const publisher = read('src/RegistryPublisher.ts');
  assert.match(publisher, /_ensureTag/);
  assert.match(publisher, /refs\/tags\/\$\{tagName\}/);
  assert.match(publisher, /git\/ref\/heads/);
  assert.match(publisher, /git\/refs/);
});

test('validator tester supports shell-backed snippets', () => {
  const tester = read('src/ValidatorTester.ts');
  assert.match(tester, /runShell/);
  assert.match(tester, /shell: process\.platform === 'win32'/);
  assert.match(tester, /Number\.isFinite\(code\)/);
  const snippets = read('webview-src/snippetLibrary.ts');
  assert.match(snippets, /context\.terminal\.runShell/);
});
