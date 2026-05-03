# Instrktr Course Author

A VS Code extension for creating and editing [Instrktr](https://github.com/instrktr/instrktr-engine) courses — visual step editor, inline validator testing, asset management, and one-click publishing to a personal GitHub registry.

## Features

- **Visual course editor** — edit step instructions (Markdown), validator code, and metadata without touching JSON directly
- **Inline validator testing** — run your `validate.js` against the current workspace and see pass/fail results instantly
- **Snippet library** — 40+ ready-to-use validator snippets across files, terminal, Git, Node, Python, and config categories
- **Step templates** — eight pre-built step patterns (write a function, fix a bug, run a command, etc.) to scaffold steps quickly
- **Starter and solution editing** — edit optional starter and reference solution files next to instructions and validators
- **Course preview** — walk through your course as a learner, including hint reveal and validator checks
- **Asset management** — import images and files into `assets/`, copy Markdown references in one click, and preview local images in Markdown
- **Course quality tools** — validate structure, search steps, restore unsaved deletions, renumber step folders, and generate a learner README
- **Course import** — clone a course from a GitHub URL or open a local folder
- **Publish** — dry-run the release details, then create a GitHub release and update a personal registry Gist in one step

## Requirements

- VS Code 1.93 or later
- Git (for import from GitHub and publish features)
- A GitHub account (for publish and sign-in features)

## Getting Started

1. Install the extension from the `.vsix` file: **Extensions → ⋯ → Install from VSIX…**
2. Click the **Course Author** icon in the Activity Bar
3. Choose **New Course…** to scaffold a new course, or **Open Course Folder…** to open an existing one

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
