# Instrktr Course Author

A VS Code extension for creating and editing [Instrktr](https://github.com/instrktr/instrktr-engine) courses — visual step editor, inline validator testing, asset management, and one-click publishing to a personal GitHub registry.

## Features

- **Visual course editor** — edit step instructions (Markdown), validator code, and metadata without touching JSON directly
- **Inline validator testing** — run your `validate.js` against the current workspace and see pass/fail results instantly
- **Snippet library** — 40+ ready-to-use validator snippets across files, terminal, Git, Node, Python, and config categories
- **Custom and parameterized snippets** — save your own snippets and fill common placeholders before insertion
- **Step templates** — eight pre-built step patterns (write a function, fix a bug, run a command, etc.) to scaffold steps quickly
- **Starter and solution editing** — edit optional starter and reference solution files next to instructions and validators
- **Course preview** — walk through your course as a learner, including hint reveal and validator checks
- **Asset management** — import images and files into `assets/`, copy Markdown references in one click, and preview local images in Markdown
- **Course quality tools** — validate structure, search steps, restore unsaved deletions, renumber step folders, and generate a learner README
- **Schema, safety, and CI support** — export a course JSON schema, scan risky validators, and package VSIX artifacts in CI
- **Course import** — clone a course from a GitHub URL or open a local folder
- **Publish** — pick a GitHub repo, dry-run the release details, then create a GitHub release and update a personal registry Gist

## Requirements

- VS Code 1.93 or later
- Git (for import from GitHub and publish features)
- A GitHub account (for publish and sign-in features)

## Getting Started

1. Install the extension from the `.vsix` file: **Extensions → ⋯ → Install from VSIX…**
2. Click the **Course Author** icon in the Activity Bar
3. Choose **New Course…** to scaffold a new course, or **Open Course Folder…** to open an existing one

## How to Use

### Create or Open a Course

Use the Course Author view in the Activity Bar as the main entry point.

- **New Course…** creates a course folder with starter metadata and the first step.
- **Open Course Folder…** opens any existing Instrktr course from disk.
- **Edit Course in Current Workspace** opens the current VS Code workspace as a course when the workspace root already contains course files.
- **Import from GitHub** clones a course repository locally, then opens it in the editor.

### Edit Course Metadata

Open the course details panel to set the title, description, difficulty, tags, author, estimated duration, and other course-level metadata. Save changes before switching courses or running publishing actions.

### Build Steps

Each step has editable instructions, validation code, optional hints, and optional starter or solution files.

1. Select a step in the step list.
2. Edit the Markdown instructions shown to learners.
3. Add or update `validate.js` for the step.
4. Use starter files for learner scaffolding and solution files for reference answers.
5. Save the course when the dirty indicator appears.

Use **Add Step** for a blank step, or choose a step template to scaffold common patterns such as writing a function, fixing a bug, running a command, or updating configuration. If step numbers get out of order after edits, use the renumber action to normalize the step folders.

### Write Validators

Validators are JavaScript files that export an async function. Insert snippets from the snippet library for common file, terminal, Git, Node, Python, and configuration checks. Parameterized snippets prompt for common values before insertion, and custom snippets can be saved for reuse across courses.

Run the inline validator tester from the editor to execute the current step validator against the selected workspace. The test result shows pass, fail, or warning output without leaving VS Code.

### Manage Assets

Use asset management to import images and supporting files into the course `assets/` folder. After importing an asset, copy the generated Markdown reference and paste it into step instructions. Local images render in the course preview.

### Preview and Quality Check

Use preview mode to walk through the course as a learner. Preview supports step navigation, Markdown rendering, hint reveal, and validator checks.

Before publishing, run the quality tools to:

- validate course structure
- find missing or risky step data
- scan validators for risky patterns
- search across steps
- restore unsaved deleted content
- generate a learner-facing README
- export the course JSON schema

### Publish a Course

Publishing packages the course as a GitHub release and can update a personal registry Gist.

1. Select the target GitHub repository.
2. Run a dry run and review the release details.
3. Confirm the release version and registry settings.
4. Publish the release.

The publish flow requires Git and GitHub access from the local machine. Use the dry run before creating a release.

## Validator Context API

Validators are `module.exports = async function validate(context) { … }` files. The `context` object provides:

### Files
```js
await context.files.exists('path/to/file')        // → boolean
await context.files.read('path/to/file')           // → string
await context.files.matches('path/to/file', /re/)  // → boolean
await context.files.list('path/to/dir')            // → string[]
```

### Terminal
```js
await context.terminal.lastCommand()               // → string  (last command the learner ran)
await context.terminal.outputContains('text')      // → boolean (output of last command)
await context.terminal.run('npm test')             // → { stdout, stderr, exitCode }
```

In the authoring extension's inline tester, `lastCommand()` and `outputContains()` inspect
commands run through `context.terminal.run()` during that validator run. Learner terminal
history/output is available in the Instrktr runtime, not in VS Code author test mode.

### Environment & Workspace
```js
context.env.get('MY_VAR')                          // → string | undefined
await context.workspace.getConfig('instrktr.key')  // → unknown
```

## Development

```bash
npm run typecheck   # extension + webview TypeScript checks
npm test            # smoke tests for manifest, icons, asset preview, templates
npm run build       # production bundle into dist/
npm run package     # build a .vsix
```

### Results
```js
return context.pass('Message shown to learner')
return context.fail('What went wrong')
return context.warn('Soft warning — step not blocked')
```

## License

[MIT](LICENSE)
