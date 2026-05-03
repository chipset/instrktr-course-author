export interface LibrarySnippet {
  id: string;
  label: string;
  description: string;
  code: string;  // body lines to insert (no outer wrapper)
}

export interface SnippetCategory {
  id: string;
  label: string;
  snippets: LibrarySnippet[];
}

export const SNIPPET_LIBRARY: SnippetCategory[] = [
  {
    id: 'files',
    label: 'Files & Dirs',
    snippets: [
      {
        id: 'file-exists',
        label: 'File exists',
        description: 'Pass if a specific file is present',
        code: `  const exists = await context.files.exists('path/to/file.txt');
  if (!exists) return context.fail('path/to/file.txt not found.');
  return context.pass('File exists!');`,
      },
      {
        id: 'multi-files-exist',
        label: 'Multiple files exist',
        description: 'Verify several required files are all present',
        code: `  const required = ['index.js', 'package.json', 'README.md'];
  for (const f of required) {
    if (!await context.files.exists(f)) {
      return context.fail(\`Required file not found: \${f}\`);
    }
  }
  return context.pass('All required files present!');`,
      },
      {
        id: 'file-content-regex',
        label: 'File matches regex',
        description: 'Check file content against a regular expression',
        code: `  const ok = await context.files.matches('path/to/file.txt', /expected pattern/i);
  if (!ok) return context.fail('File content does not match expected pattern.');
  return context.pass('File content looks correct!');`,
      },
      {
        id: 'file-read-inspect',
        label: 'Read and inspect',
        description: 'Read a file and perform custom checks on its content',
        code: `  const content = await context.files.read('path/to/file.txt');
  if (!content.trim()) return context.fail('File is empty.');
  if (!content.includes('expected')) {
    return context.fail('File is missing expected content.');
  }
  return context.pass('File content is correct!');`,
      },
      {
        id: 'list-dir',
        label: 'Directory listing',
        description: 'Check that a directory contains specific files',
        code: `  const files = await context.files.list('src/');
  const required = ['index.js', 'utils.js'];
  const missing = required.filter(f => !files.includes(f));
  if (missing.length > 0) {
    return context.fail(\`Missing files in src/: \${missing.join(', ')}\`);
  }
  return context.pass('All required files are present in src/!');`,
      },
      {
        id: 'json-key',
        label: 'JSON file key',
        description: 'Verify a specific key exists and has the right value in a JSON file',
        code: `  const raw = await context.files.read('config.json');
  let config;
  try { config = JSON.parse(raw); } catch { return context.fail('config.json is not valid JSON.'); }
  if (config.name !== 'expected-value') {
    return context.fail(\`Expected config.name to be "expected-value", got "\${config.name}"\`);
  }
  return context.pass('Configuration looks correct!');`,
      },
      {
        id: 'file-not-exists',
        label: 'File does NOT exist',
        description: 'Verify a file was deleted or was never created',
        code: `  const exists = await context.files.exists('path/to/unwanted-file.txt');
  if (exists) return context.fail('Unexpected file found — make sure to delete it.');
  return context.pass('File correctly removed.');`,
      },
    ],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    snippets: [
      {
        id: 'last-command',
        label: 'Check last command',
        description: 'Verify the learner ran a specific terminal command',
        code: `  const cmd = await context.terminal.lastCommand();
  if (!cmd.includes('git init')) {
    return context.warn('Run \`git init\` in the terminal first.');
  }
  return context.pass('Command run correctly!');`,
      },
      {
        id: 'output-contains',
        label: 'Terminal output contains',
        description: 'Check that the last command produced expected output in the terminal emulator',
        code: `  const ok = await context.terminal.outputContains('expected output');
  if (!ok) return context.fail('Expected output not found. Run the command and check the result.');
  return context.pass('Output looks correct!');`,
      },
      {
        id: 'command-and-output',
        label: 'Command ran + output check',
        description: 'Verify the learner ran a specific command AND it produced expected output',
        code: `  const cmd = await context.terminal.lastCommand();
  if (!cmd.includes('npm start')) {
    return context.warn('Run \`npm start\` in the terminal first.');
  }

  const ok = await context.terminal.outputContains('Server listening');
  if (!ok) return context.fail('Server did not start correctly. Check the terminal for errors.');

  return context.pass('Server started successfully!');`,
      },
      {
        id: 'output-no-errors',
        label: 'Output has no errors',
        description: 'Confirm the last terminal command produced no error output',
        code: `  const hasError = await context.terminal.outputContains('Error');
  const hasFail  = await context.terminal.outputContains('FAILED');
  if (hasError || hasFail) {
    return context.fail('Terminal output contains errors. Fix them and run the command again.');
  }
  return context.pass('No errors detected in terminal output!');`,
      },
      {
        id: 'run-and-check',
        label: 'Run command & check exit',
        description: 'Execute a command and verify it succeeds',
        code: `  const { stdout, exitCode } = await context.terminal.run('npm test');
  if (exitCode !== 0) {
    return context.fail(\`Tests failed:\\n\${stdout}\`);
  }
  return context.pass('All tests pass!');`,
      },
      {
        id: 'run-and-inspect-output',
        label: 'Run command & inspect output',
        description: 'Execute a command and check its stdout',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('node index.js');
  if (exitCode !== 0) return context.fail(\`Script errored: \${stderr || stdout}\`);
  if (!stdout.includes('Hello')) {
    return context.fail(\`Expected output to contain "Hello". Got: \${stdout.trim()}\`);
  }
  return context.pass('Script output is correct!');`,
      },
      {
        id: 'env-var',
        label: 'Environment variable',
        description: 'Check that an environment variable is set',
        code: `  const val = context.env.get('MY_VAR');
  if (!val) return context.fail('Environment variable MY_VAR is not set.');
  return context.pass(\`MY_VAR is set to: \${val}\`);`,
      },
    ],
  },
  {
    id: 'git',
    label: 'Git',
    snippets: [
      {
        id: 'git-init',
        label: 'Repo initialized',
        description: 'Check that git init was run',
        code: `  const hasGit = await context.files.exists('.git/config');
  if (!hasGit) return context.fail('No .git folder found. Run \`git init\` first.');
  return context.pass('Git repository initialized!');`,
      },
      {
        id: 'git-staged',
        label: 'File is staged',
        description: 'Verify a file is staged for commit',
        code: `  const { stdout, exitCode } = await context.terminal.run('git diff --cached --name-only');
  if (exitCode !== 0) return context.fail('Could not check staged files. Is git initialized?');
  if (!stdout.includes('README.md')) {
    return context.warn('README.md is not staged. Run \`git add README.md\`.');
  }
  return context.pass('File is staged!');`,
      },
      {
        id: 'git-committed',
        label: 'Has commit(s)',
        description: 'Verify at least one commit exists',
        code: `  const { stdout, exitCode } = await context.terminal.run('git log --oneline');
  if (exitCode !== 0 || !stdout.trim()) {
    return context.fail('No commits found. Stage your changes and run \`git commit\`.');
  }
  return context.pass('Commit found!');`,
      },
      {
        id: 'git-commit-message',
        label: 'Commit message',
        description: 'Check the most recent commit message',
        code: `  const { stdout, exitCode } = await context.terminal.run('git log -1 --format=%s');
  if (exitCode !== 0) return context.fail('Could not read last commit message.');
  if (!stdout.toLowerCase().includes('initial')) {
    return context.warn(\`Commit message "\${stdout.trim()}" doesn't mention "initial". Consider a more descriptive message.\`);
  }
  return context.pass(\`Good commit message: "\${stdout.trim()}"\`);`,
      },
      {
        id: 'git-remote',
        label: 'Remote configured',
        description: 'Check that a remote (origin) is set up',
        code: `  const { stdout, exitCode } = await context.terminal.run('git remote -v');
  if (exitCode !== 0 || !stdout.includes('origin')) {
    return context.fail('No "origin" remote configured. Add one with \`git remote add origin <url>\`.');
  }
  return context.pass('Remote "origin" is configured!');`,
      },
      {
        id: 'git-branch',
        label: 'On specific branch',
        description: 'Verify the learner is on the correct branch',
        code: `  const { stdout, exitCode } = await context.terminal.run('git branch --show-current');
  if (exitCode !== 0) return context.fail('Could not determine current branch.');
  const branch = stdout.trim();
  if (branch !== 'feature/my-feature') {
    return context.fail(\`Expected branch "feature/my-feature", but on "\${branch}". Run \`git checkout -b feature/my-feature\`.\`);
  }
  return context.pass(\`On the correct branch: \${branch}\`);`,
      },
    ],
  },
  {
    id: 'node',
    label: 'Node / npm',
    snippets: [
      {
        id: 'package-json-field',
        label: 'package.json field',
        description: 'Check a specific field in package.json',
        code: `  const raw = await context.files.read('package.json');
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return context.fail('package.json is not valid JSON.'); }
  if (!pkg.scripts?.test) {
    return context.fail('No "test" script found in package.json. Add one under "scripts".');
  }
  return context.pass('Test script is configured!');`,
      },
      {
        id: 'node-modules',
        label: 'Dependencies installed',
        description: 'Check that npm install has been run',
        code: `  const installed = await context.files.exists('node_modules');
  if (!installed) {
    return context.fail('node_modules not found. Run \`npm install\` first.');
  }
  return context.pass('Dependencies are installed!');`,
      },
      {
        id: 'specific-dependency',
        label: 'Specific dependency',
        description: 'Check that a specific package is listed in dependencies',
        code: `  const raw = await context.files.read('package.json');
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return context.fail('package.json is not valid JSON.'); }
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!allDeps['express']) {
    return context.fail('"express" not found in package.json. Run \`npm install express\`.');
  }
  return context.pass('express dependency found!');`,
      },
      {
        id: 'npm-test-passes',
        label: 'npm test passes',
        description: 'Run npm test and verify it exits cleanly',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('npm test');
  if (exitCode !== 0) {
    return context.fail(\`Tests failed:\\n\${stdout || stderr}\`);
  }
  return context.pass('All tests pass!');`,
      },
    ],
  },
  {
    id: 'python',
    label: 'Python',
    snippets: [
      {
        id: 'python-function',
        label: 'Function defined',
        description: 'Check that a Python function is defined in a file',
        code: `  const ok = await context.files.matches('solution.py', /def\\s+greet\\s*\\(/);
  if (!ok) return context.fail('Function \`greet\` not found in solution.py.');
  return context.pass('Function \`greet\` is defined!');`,
      },
      {
        id: 'python-run',
        label: 'Python script runs',
        description: 'Execute a Python script and check its output',
        code: `  const { stdout, exitCode } = await context.terminal.run('python3 solution.py');
  if (exitCode !== 0) return context.fail(\`Script failed to run: \${stdout}\`);
  if (!stdout.includes('Hello')) {
    return context.fail(\`Expected "Hello" in output. Got: \${stdout.trim()}\`);
  }
  return context.pass('Script runs and produces expected output!');`,
      },
      {
        id: 'requirements-txt',
        label: 'requirements.txt',
        description: 'Check that requirements.txt lists a dependency',
        code: `  const reqs = await context.files.read('requirements.txt');
  if (!reqs.match(/flask/i)) {
    return context.fail('"flask" not found in requirements.txt.');
  }
  return context.pass('requirements.txt looks correct!');`,
      },
    ],
  },
  {
    id: 'config',
    label: 'Config Files',
    snippets: [
      {
        id: 'env-file',
        label: '.env file key',
        description: 'Check that a .env file defines a specific variable',
        code: `  const envContent = await context.files.read('.env');
  if (!envContent) return context.fail('.env file not found or empty.');
  if (!envContent.includes('DATABASE_URL=')) {
    return context.fail('DATABASE_URL not set in .env. Add it like: DATABASE_URL=your_url');
  }
  return context.pass('.env file configured correctly!');`,
      },
      {
        id: 'gitignore',
        label: '.gitignore entry',
        description: 'Verify that .gitignore includes a specific entry',
        code: `  const ignore = await context.files.read('.gitignore');
  if (!ignore.includes('node_modules')) {
    return context.fail('"node_modules" not in .gitignore. Add it to avoid committing dependencies.');
  }
  return context.pass('.gitignore looks good!');`,
      },
      {
        id: 'tsconfig',
        label: 'tsconfig.json strict',
        description: 'Verify TypeScript strict mode is enabled',
        code: `  const raw = await context.files.read('tsconfig.json');
  let ts;
  try { ts = JSON.parse(raw); } catch { return context.fail('tsconfig.json is not valid JSON.'); }
  if (!ts.compilerOptions?.strict) {
    return context.fail('TypeScript "strict" mode is not enabled. Set "strict": true in compilerOptions.');
  }
  return context.pass('TypeScript strict mode is enabled!');`,
      },
      {
        id: 'yaml-key',
        label: 'YAML key (regex)',
        description: 'Check a key in a YAML file using a regex (no parser needed)',
        code: `  const ok = await context.files.matches('config.yml', /^\\s*port:\\s*3000/m);
  if (!ok) return context.fail('Expected "port: 3000" in config.yml.');
  return context.pass('Config port is set to 3000!');`,
      },
      {
        id: 'workspace-config',
        label: 'VS Code workspace setting',
        description: 'Read a setting from the VS Code workspace configuration (settings.json)',
        code: `  const value = await context.workspace.getConfig('instrktr.targetBranch');
  if (!value) {
    return context.fail('No target branch configured. Add "instrktr.targetBranch" to .vscode/settings.json.');
  }
  return context.pass(\`Target branch is configured: \${value}\`);`,
      },
    ],
  },

  {
    id: 'http-api',
    label: 'HTTP/API',
    snippets: [
      {
        id: 'fetch-status-ok',
        label: 'Fetch endpoint status',
        description: 'Call an HTTP endpoint and require a 2xx response',
        code: `  const res = await fetch('http://localhost:3000/health');
  if (!res.ok) {
    return context.fail(\`Expected 2xx from /health, got \${res.status}.\`);
  }
  return context.pass('Endpoint returned a successful status!');`,
      },
      {
        id: 'json-response-shape',
        label: 'Validate JSON shape',
        description: 'Fetch JSON and verify required fields are present',
        code: `  const res = await fetch('http://localhost:3000/api/user');
  if (!res.ok) return context.fail(\`API returned status \${res.status}.\`);
  const data = await res.json();
  for (const field of ['id', 'name', 'email']) {
    if (!(field in data)) return context.fail(\`Missing JSON field: \${field}\`);
  }
  return context.pass('JSON response has the expected shape!');`,
      },
      {
        id: 'json-field-value',
        label: 'JSON field value',
        description: 'Fetch JSON and compare a specific field value',
        code: `  const res = await fetch('http://localhost:3000/api/config');
  if (!res.ok) return context.fail(\`API returned status \${res.status}.\`);
  const data = await res.json();
  if (data.mode !== 'production') {
    return context.fail(\`Expected mode "production", got "\${data.mode}".\`);
  }
  return context.pass('API returned the expected field value!');`,
      },
      {
        id: 'auth-header-required',
        label: 'Auth header behavior',
        description: 'Verify an endpoint rejects unauthenticated requests and accepts an auth header',
        code: `  const withoutAuth = await fetch('http://localhost:3000/api/private');
  if (![401, 403].includes(withoutAuth.status)) {
    return context.fail(\`Expected 401/403 without auth, got \${withoutAuth.status}.\`);
  }

  const withAuth = await fetch('http://localhost:3000/api/private', {
    headers: { Authorization: 'Bearer test-token' },
  });
  if (!withAuth.ok) return context.fail(\`Expected success with auth header, got \${withAuth.status}.\`);
  return context.pass('Auth behavior looks correct!');`,
      },
    ],
  },
  {
    id: 'docker',
    label: 'Docker',
    snippets: [
      {
        id: 'dockerfile-exists',
        label: 'Dockerfile exists',
        description: 'Verify a Dockerfile is present in the project root',
        code: `  if (!await context.files.exists('Dockerfile')) {
    return context.fail('Dockerfile not found. Create one in the project root.');
  }
  return context.pass('Dockerfile exists!');`,
      },
      {
        id: 'docker-image-builds',
        label: 'Image builds',
        description: 'Run docker build and require success',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('docker build -t course-check .');
  if (exitCode !== 0) return context.fail(\`Docker build failed:\n\${stderr || stdout}\`);
  return context.pass('Docker image builds successfully!');`,
      },
      {
        id: 'docker-container-command',
        label: 'Container command runs',
        description: 'Run a command inside the built image',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('docker run --rm course-check node --version');
  if (exitCode !== 0) return context.fail(\`Container command failed:\n\${stderr || stdout}\`);
  return context.pass(\`Container command ran: \${stdout.trim()}\`);`,
      },
      {
        id: 'compose-config-valid',
        label: 'Compose config validates',
        description: 'Use docker compose config to validate compose syntax',
        code: `  const hasCompose = await context.files.exists('docker-compose.yml') || await context.files.exists('compose.yml');
  if (!hasCompose) return context.fail('No docker-compose.yml or compose.yml found.');
  const { stdout, stderr, exitCode } = await context.terminal.run('docker compose config');
  if (exitCode !== 0) return context.fail(\`Compose config is invalid:\n\${stderr || stdout}\`);
  return context.pass('Docker Compose configuration is valid!');`,
      },
    ],
  },
  {
    id: 'database',
    label: 'Databases',
    snippets: [
      {
        id: 'sqlite-query',
        label: 'SQLite query works',
        description: 'Run a SQLite query against a local database file',
        code: `  if (!await context.files.exists('app.db')) return context.fail('app.db not found.');
  const { stdout, stderr, exitCode } = await context.terminal.run('sqlite3 app.db "select count(*) from users;"');
  if (exitCode !== 0) return context.fail(\`SQLite query failed:\n\${stderr || stdout}\`);
  return context.pass(\`SQLite query worked. User count: \${stdout.trim()}\`);`,
      },
      {
        id: 'postgres-env-vars',
        label: 'Postgres env vars',
        description: 'Check common Postgres connection environment variables',
        code: `  const required = ['PGHOST', 'PGUSER', 'PGDATABASE'];
  const missing = required.filter((name) => !context.env.get(name));
  if (missing.length) return context.fail(\`Missing Postgres env vars: \${missing.join(', ')}\`);
  return context.pass('Postgres environment variables are configured!');`,
      },
      {
        id: 'migration-file-exists',
        label: 'Migration exists',
        description: 'Verify at least one migration file exists',
        code: `  const dirs = ['migrations', 'db/migrations', 'prisma/migrations'];
  for (const dir of dirs) {
    const files = await context.files.list(dir);
    if (files.length > 0) return context.pass(\`Found migrations in \${dir}.\`);
  }
  return context.fail('No migration files found. Add a migration before continuing.');`,
      },
      {
        id: 'seed-data-check',
        label: 'Seed data check',
        description: 'Verify a seed file contains expected data',
        code: `  const seed = await context.files.read('seed.sql');
  if (!seed) return context.fail('seed.sql not found.');
  if (!/insert\s+into\s+users/i.test(seed)) {
    return context.fail('seed.sql should insert at least one user.');
  }
  return context.pass('Seed data includes users!');`,
      },
    ],
  },
  {
    id: 'frontend',
    label: 'Frontend',
    snippets: [
      {
        id: 'html-element-exists',
        label: 'HTML element exists',
        description: 'Check an HTML file for a required element or id',
        code: `  const html = await context.files.read('index.html');
  if (!html) return context.fail('index.html not found.');
  if (!html.includes('id="app"')) return context.fail('Expected an element with id="app".');
  return context.pass('Required HTML element exists!');`,
      },
      {
        id: 'css-class-exists',
        label: 'CSS class exists',
        description: 'Check CSS for a required class selector',
        code: `  const css = await context.files.read('styles.css');
  if (!css) return context.fail('styles.css not found.');
  if (!/\.card\s*\{/.test(css)) return context.fail('Expected a .card CSS class.');
  return context.pass('CSS selector found!');`,
      },
      {
        id: 'frontend-build',
        label: 'Frontend build passes',
        description: 'Run the project build script and require success',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('npm run build');
  if (exitCode !== 0) return context.fail(\`Build failed:\n\${stderr || stdout}\`);
  return context.pass('Frontend build passes!');`,
      },
      {
        id: 'playwright-page-check',
        label: 'Playwright page check',
        description: 'Template for running a Playwright smoke check',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('npx playwright test --grep @smoke');
  if (exitCode !== 0) return context.fail(\`Playwright smoke test failed:\n\${stderr || stdout}\`);
  return context.pass('Playwright smoke test passed!');`,
      },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    snippets: [
      {
        id: 'no-hardcoded-secrets',
        label: 'No hardcoded secrets',
        description: 'Scan common files for obvious secret-like strings',
        code: `  const files = ['.env', 'config.json', 'src/index.js', 'README.md'];
  const secretPattern = /(api[_-]?key|secret|password|token)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}/i;
  for (const file of files) {
    const content = await context.files.read(file);
    if (content && secretPattern.test(content)) {
      return context.fail(\`Possible hardcoded secret found in \${file}. Move it to environment variables.\`);
    }
  }
  return context.pass('No obvious hardcoded secrets found!');`,
      },
      {
        id: 'env-gitignored',
        label: '.env is gitignored',
        description: 'Verify .env files are excluded from Git',
        code: `  const gitignore = await context.files.read('.gitignore');
  if (!/(^|\n)\.env(\n|$)/.test(gitignore) && !/(^|\n)\.env\.\*(\n|$)/.test(gitignore)) {
    return context.fail('Add .env or .env.* to .gitignore.');
  }
  return context.pass('.env files are gitignored!');`,
      },
      {
        id: 'npm-audit',
        label: 'npm audit check',
        description: 'Run npm audit and require no high/critical findings',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('npm audit --audit-level=high');
  if (exitCode !== 0) return context.fail(\`npm audit found high severity issues:\n\${stderr || stdout}\`);
  return context.pass('npm audit found no high severity issues!');`,
      },
      {
        id: 'executable-permissions',
        label: 'Script permissions',
        description: 'Verify a shell script is executable',
        code: `  const { stdout, exitCode } = await context.terminal.run('test -x scripts/setup.sh && echo executable');
  if (exitCode !== 0 || !stdout.includes('executable')) {
    return context.fail('scripts/setup.sh should be executable. Run chmod +x scripts/setup.sh.');
  }
  return context.pass('Script permissions look correct!');`,
      },
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    snippets: [
      {
        id: 'branch-name',
        label: 'Branch name check',
        description: 'Verify the current Git branch follows a naming convention',
        code: `  const { stdout, exitCode } = await context.terminal.run('git branch --show-current');
  if (exitCode !== 0) return context.fail('Could not read current Git branch.');
  const branch = stdout.trim();
  if (!/^(feature|fix|docs)\/.+/.test(branch)) {
    return context.warn(\`Branch "\${branch}" should start with feature/, fix/, or docs/.\`);
  }
  return context.pass(\`Branch name looks good: \${branch}\`);`,
      },
      {
        id: 'clean-working-tree',
        label: 'Clean working tree',
        description: 'Require no uncommitted Git changes',
        code: `  const { stdout, exitCode } = await context.terminal.run('git status --porcelain');
  if (exitCode !== 0) return context.fail('Could not read Git status.');
  if (stdout.trim()) return context.warn('You still have uncommitted changes. Commit or stash them first.');
  return context.pass('Working tree is clean!');`,
      },
      {
        id: 'minimum-commits',
        label: 'Minimum commits',
        description: 'Require at least a certain number of commits',
        code: `  const { stdout, exitCode } = await context.terminal.run('git rev-list --count HEAD');
  if (exitCode !== 0) return context.fail('Could not count commits.');
  const count = Number(stdout.trim());
  if (count < 3) return context.warn(\`Expected at least 3 commits, found \${count}.\`);
  return context.pass(\`Commit history has \${count} commits.\`);`,
      },
      {
        id: 'github-actions-workflow',
        label: 'Actions workflow exists',
        description: 'Verify a GitHub Actions workflow file exists',
        code: `  const workflows = await context.files.list('.github/workflows');
  if (!workflows.some((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    return context.fail('No GitHub Actions workflow found in .github/workflows.');
  }
  return context.pass('GitHub Actions workflow found!');`,
      },
    ],
  },

  {
    id: 'm3270',
    label: 'm3270 Sessions',
    snippets: [
      {
        id: 'm3270-installed',
        label: 'm3270 installed',
        description: 'Verify m3270 is available on PATH before running terminal emulator checks',
        code: `  // Source pattern: Instrktr validators can run authoritative shell checks with context.terminal.run().
  const { stdout, stderr, exitCode } = await context.terminal.run('m3270 -v');
  if (exitCode !== 0) {
    return context.fail(\`m3270 is not installed or not on PATH:\n\${stderr || stdout}\`);
  }
  return context.pass(\`m3270 is available: \${(stdout || stderr).split('\\n')[0]}\`);`,
      },
      {
        id: 's3270-installed',
        label: 's3270 installed',
        description: 'Prefer s3270 for scripted 3270 validation when available',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('s3270 -v');
  if (exitCode !== 0) {
    return context.warn(\`s3270 is not available. Scripted checks may need m3270 or x3270 tools installed.\\n\${stderr || stdout}\`);
  }
  return context.pass(\`s3270 is available: \${(stdout || stderr).split('\\n')[0]}\`);`,
      },
      {
        id: 'm3270-env-host-port',
        label: 'Host/port env configured',
        description: 'Check non-secret environment variables used to connect a 3270 session',
        code: `  const host = context.env.get('TN3270_HOST');
  const port = context.env.get('TN3270_PORT') ?? '23';
  if (!host) return context.fail('Set TN3270_HOST to the target host before continuing.');
  if (!/^\\d+$/.test(port)) return context.fail(\`TN3270_PORT must be numeric. Got: \${port}\`);
  return context.pass(\`3270 target configured: \${host}:\${port}\`);`,
      },
      {
        id: 's3270-connect-wait',
        label: 'Connect and wait for input',
        description: 'Use s3270 scripting to connect to a TN3270 host and wait for an input field',
        code: `  const host = context.env.get('TN3270_HOST');
  const port = context.env.get('TN3270_PORT') ?? '23';
  if (!host) return context.fail('Set TN3270_HOST first.');

  const script = [
    \`Connect(\${host}:\${port})\`,
    'Wait(InputField,10)',
    'Ascii()',
    'Disconnect()',
    'Quit()',
  ].join('\\n');

  const { stdout, stderr, exitCode } = await context.terminal.runShell(\`printf '%s\\n' \${JSON.stringify(script)} | s3270 -script\`);
  if (exitCode !== 0) return context.fail(\`Could not connect or wait for input field:\n\${stderr || stdout}\`);
  return context.pass('3270 session connected and reached an input-capable screen.');`,
      },
      {
        id: 's3270-screen-contains',
        label: 'Screen contains text',
        description: 'Connect with s3270 and verify the current screen contains expected text',
        code: `  const host = context.env.get('TN3270_HOST');
  const port = context.env.get('TN3270_PORT') ?? '23';
  const expected = 'READY';
  if (!host) return context.fail('Set TN3270_HOST first.');

  const script = [
    \`Connect(\${host}:\${port})\`,
    'Wait(10,Seconds)',
    'Ascii()',
    'Disconnect()',
    'Quit()',
  ].join('\\n');

  const { stdout, stderr, exitCode } = await context.terminal.runShell(\`printf '%s\\n' \${JSON.stringify(script)} | s3270 -script\`);
  if (exitCode !== 0) return context.fail(\`3270 screen read failed:\n\${stderr || stdout}\`);
  if (!stdout.includes(expected)) {
    return context.fail(\`Expected screen text "\${expected}" not found. Screen output:\n\${stdout.slice(0, 800)}\`);
  }
  return context.pass(\`3270 screen contains "\${expected}".\`);`,
      },
      {
        id: 's3270-send-enter-read',
        label: 'Send command + Enter',
        description: 'Type a command into a 3270 session, press Enter, and inspect the screen',
        code: `  const host = context.env.get('TN3270_HOST');
  const port = context.env.get('TN3270_PORT') ?? '23';
  if (!host) return context.fail('Set TN3270_HOST first.');

  const command = 'TSO';
  const expected = 'IKJ';
  const script = [
    \`Connect(\${host}:\${port})\`,
    'Wait(InputField,10)',
    \`String("\${command}")\`,
    'Enter()',
    'Wait(5,Seconds)',
    'Ascii()',
    'Disconnect()',
    'Quit()',
  ].join('\\n');

  const { stdout, stderr, exitCode } = await context.terminal.runShell(\`printf '%s\\n' \${JSON.stringify(script)} | s3270 -script\`);
  if (exitCode !== 0) return context.fail(\`3270 command failed:\n\${stderr || stdout}\`);
  if (!stdout.includes(expected)) return context.warn(\`Command ran, but expected text "\${expected}" was not found.\`);
  return context.pass(\`3270 command "\${command}" produced expected screen text.\`);`,
      },
      {
        id: 's3270-login-flow-template',
        label: 'Login flow template',
        description: 'Template for a credential-free login/navigation flow; avoids env.get for secrets',
        code: `  // Do not read passwords/tokens with context.env.get(); Instrktr blocks common secret env names.
  // Prefer checking post-login artifacts or screens created by the learner's own session.
  const host = context.env.get('TN3270_HOST');
  const user = context.env.get('TN3270_USER');
  const port = context.env.get('TN3270_PORT') ?? '23';
  if (!host || !user) return context.fail('Set TN3270_HOST and TN3270_USER. Do not store passwords in course validators.');

  const script = [
    \`Connect(\${host}:\${port})\`,
    'Wait(InputField,10)',
    \`String("\${user}")\`,
    'Tab()',
    // Intentionally no password entry here.
    'Ascii()',
    'Disconnect()',
    'Quit()',
  ].join('\\n');

  const { stdout, stderr, exitCode } = await context.terminal.runShell(\`printf '%s\\n' \${JSON.stringify(script)} | s3270 -script\`);
  if (exitCode !== 0) return context.fail(\`3270 login screen check failed:\n\${stderr || stdout}\`);
  return context.pass('3270 login screen is reachable. Continue using learner-provided credentials interactively.');`,
      },
      {
        id: 'm3270-last-command-used',
        label: 'Learner used m3270',
        description: 'Check shell integration for a recent m3270/s3270/x3270 command',
        code: `  const cmd = await context.terminal.lastCommand();
  if (!/\\b(m3270|s3270|x3270)\\b/.test(cmd)) {
    return context.warn('Run an m3270, s3270, or x3270 command in the Instrktr terminal first.');
  }
  return context.pass(\`3270 terminal command detected: \${cmd}\`);`,
      },
      {
        id: 'm3270-output-contains',
        label: '3270 output contains',
        description: 'Check captured terminal output for expected m3270/s3270 text',
        code: `  const expected = 'READY';
  const ok = await context.terminal.outputContains(expected);
  if (!ok) return context.fail(\`Expected terminal output to contain "\${expected}".\`);
  return context.pass(\`Terminal output contains "\${expected}".\`);`,
      },
      {
        id: 'm3270-script-file-check',
        label: 'Script file sanity check',
        description: 'Validate a learner-created s3270 command script file',
        code: `  const scriptPath = 'scripts/session.s3270';
  const content = await context.files.read(scriptPath);
  if (!content) return context.fail(\`Create \${scriptPath} first.\`);
  for (const required of ['Connect(', 'Wait(', 'Ascii()', 'Quit()']) {
    if (!content.includes(required)) return context.fail(\`\${scriptPath} should include \${required}.\`);
  }
  if (/String\\([^)]*(password|passwd|secret)/i.test(content)) {
    return context.fail('Do not hardcode passwords or secrets in 3270 scripts.');
  }
  return context.pass('s3270 script file has the expected safe structure.');`,
      },
    ],
  },
  {
    id: 'zowe',
    label: 'Zowe/Mainframe',
    snippets: [
      {
        id: 'zowe-version',
        label: 'Zowe CLI installed',
        description: 'Check that Zowe CLI is available',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('zowe --version');
  if (exitCode !== 0) return context.fail(\`Zowe CLI is not available:\n\${stderr || stdout}\`);
  return context.pass(\`Zowe CLI version: \${stdout.trim()}\`);`,
      },
      {
        id: 'zowe-profile-list',
        label: 'Zowe profile exists',
        description: 'Verify at least one Zowe profile is configured',
        code: `  const { stdout, exitCode } = await context.terminal.run('zowe profiles list zosmf');
  if (exitCode !== 0 || !stdout.trim()) return context.fail('No z/OSMF profile found. Configure one with zowe profiles create zosmf-profile.');
  return context.pass('Zowe z/OSMF profile found!');`,
      },
      {
        id: 'zowe-command-succeeds',
        label: 'Zowe command succeeds',
        description: 'Run a Zowe command and require success',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('zowe zos-files list data-set "USER.*"');
  if (exitCode !== 0) return context.fail(\`Zowe command failed:\n\${stderr || stdout}\`);
  return context.pass('Zowe command completed successfully!');`,
      },
      {
        id: 'zowe-config-property',
        label: 'Zowe config property',
        description: 'Check zowe.config.json for an expected property',
        code: `  const raw = await context.files.read('zowe.config.json');
  if (!raw) return context.fail('zowe.config.json not found.');
  let config;
  try { config = JSON.parse(raw); } catch { return context.fail('zowe.config.json is invalid JSON.'); }
  if (!JSON.stringify(config).includes('zosmf')) {
    return context.fail('zowe.config.json should include a zosmf profile.');
  }
  return context.pass('Zowe config includes z/OSMF settings!');`,
      },
      {
        id: 'dataset-name-valid',
        label: 'Dataset name valid',
        description: 'Validate a dataset/member naming pattern in an answer file',
        code: `  const answer = (await context.files.read('dataset.txt')).trim().toUpperCase();
  if (!/^[A-Z#$@][A-Z0-9#$@-]{0,7}(\.[A-Z#$@][A-Z0-9#$@-]{0,7}){1,21}(\([A-Z#$@][A-Z0-9#$@]{0,7}\))?$/.test(answer)) {
    return context.fail('dataset.txt does not contain a valid dataset or member name.');
  }
  return context.pass(\`Dataset/member name looks valid: \${answer}\`);`,
      },
    ],
  },
  {
    id: 'course-authoring',
    label: 'Course Authoring',
    snippets: [
      {
        id: 'readme-section',
        label: 'README section exists',
        description: 'Verify the learner added a specific README heading',
        code: `  const readme = await context.files.read('README.md');
  if (!/^## Installation$/m.test(readme)) {
    return context.fail('Add a "## Installation" section to README.md.');
  }
  return context.pass('README contains the required section!');`,
      },
      {
        id: 'multi-directory-files',
        label: 'Files across dirs',
        description: 'Check expected files across multiple directories',
        code: `  const required = ['src/index.js', 'test/index.test.js', 'README.md'];
  const missing = [];
  for (const file of required) {
    if (!await context.files.exists(file)) missing.push(file);
  }
  if (missing.length) return context.fail(\`Missing files: \${missing.join(', ')}\`);
  return context.pass('All expected files are present!');`,
      },
      {
        id: 'command-generates-artifact',
        label: 'Command creates artifact',
        description: 'Run a command and verify it creates an expected output file',
        code: `  const { stdout, stderr, exitCode } = await context.terminal.run('npm run build');
  if (exitCode !== 0) return context.fail(\`Command failed:\n\${stderr || stdout}\`);
  if (!await context.files.exists('dist/app.js')) {
    return context.fail('Build completed but dist/app.js was not created.');
  }
  return context.pass('Command generated the expected artifact!');`,
      },
      {
        id: 'deep-json-config',
        label: 'Deep JSON config',
        description: 'Parse JSON and check nested configuration values',
        code: `  const raw = await context.files.read('config.json');
  if (!raw) return context.fail('config.json not found.');
  let config;
  try { config = JSON.parse(raw); } catch { return context.fail('config.json is invalid JSON.'); }
  if (config.server?.port !== 3000 || config.features?.auth !== true) {
    return context.fail('Expected server.port=3000 and features.auth=true in config.json.');
  }
  return context.pass('Nested JSON configuration is correct!');`,
      },
    ],
  },
  {
    id: 'patterns',
    label: 'Multi-Step',
    snippets: [
      {
        id: 'full-check',
        label: 'File + content check',
        description: 'Progressive: existence → content → value',
        code: `  // 1. File must exist
  if (!await context.files.exists('README.md')) {
    return context.fail('README.md not found. Create it first.');
  }

  // 2. Must not be empty
  const content = await context.files.read('README.md');
  if (!content.trim()) return context.warn('README.md is empty — add some content!');

  // 3. Must mention the project name
  if (!content.match(/# .+/)) {
    return context.warn('README.md should start with a heading (# Your Project Name).');
  }

  return context.pass('README.md looks great!');`,
      },
      {
        id: 'command-then-file',
        label: 'Command → file created',
        description: 'Verify a command was run by checking its output file',
        code: `  // Run the build step
  const { exitCode, stdout } = await context.terminal.run('npm run build');
  if (exitCode !== 0) return context.fail(\`Build failed: \${stdout}\`);

  // Verify the output file was created
  if (!await context.files.exists('dist/index.js')) {
    return context.fail('Build ran but dist/index.js was not created. Check your build config.');
  }

  return context.pass('Build succeeded and output file exists!');`,
      },
      {
        id: 'setup-verification',
        label: 'Full setup check',
        description: 'Verify an entire project structure',
        code: `  const checks: [string, string][] = [
    ['package.json', 'package.json'],
    ['src/index.js', 'src/index.js'],
    ['.gitignore', '.gitignore'],
  ];

  for (const [label, file] of checks) {
    if (!await context.files.exists(file)) {
      return context.fail(\`\${label} not found. Expected at: \${file}\`);
    }
  }

  // Check git is initialized
  if (!await context.files.exists('.git/config')) {
    return context.warn('Project files look good, but git is not initialized. Run \`git init\`.');
  }

  return context.pass('Project structure looks correct!');`,
      },
    ],
  },
];
