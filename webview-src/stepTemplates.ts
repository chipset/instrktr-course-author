export interface StepTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  tags: string[];
  instructions: string;
  validatorBody: string;
  starterFiles?: { path: string; content: string }[];
}

export const STEP_TEMPLATES: StepTemplate[] = [
  {
    id: 'write-function',
    name: 'Write a Function',
    icon: '✍️',
    description: 'Learner writes a named function that meets a specification',
    tags: ['code', 'beginner'],
    instructions: `# Write the \`greet\` Function

In this step you'll write a simple function that returns a personalised greeting.

## Your task

Open \`solution.js\` and implement the \`greet\` function:

\`\`\`js
function greet(name) {
  // return a greeting string containing the name
}

module.exports = { greet };
\`\`\`

The function should return a string like **"Hello, Alice!"** when called with \`"Alice"\`.

Once you're done, click **Check Work**.
`,
    validatorBody: `  // Check the file exists
  if (!await context.files.exists('solution.js')) {
    return context.fail('solution.js not found. Create the file first.');
  }

  // Check the function is defined
  const ok = await context.files.matches('solution.js', /function\\s+greet\\s*\\(/);
  if (!ok) return context.fail('Function \`greet\` not found in solution.js.');

  // Run it to verify behaviour
  const { stdout, exitCode } = await context.terminal.run(
    'node -e "const {greet}=require(\\'./solution\\');console.log(greet(\\'Alice\\'))"'
  );
  if (exitCode !== 0) return context.fail(\`Error running solution: \${stdout}\`);
  if (!stdout.includes('Alice')) {
    return context.fail(\`Expected output to contain "Alice". Got: \${stdout.trim()}\`);
  }
  return context.pass('Function \`greet\` works correctly!');`,
    starterFiles: [
      {
        path: 'solution.js',
        content: `function greet(name) {
  // TODO: return a greeting string containing the name
}

module.exports = { greet };
`,
      },
    ],
  },

  {
    id: 'fix-a-bug',
    name: 'Fix a Bug',
    icon: '🐛',
    description: 'Learner is given broken code and must find and fix the bug',
    tags: ['debugging', 'intermediate'],
    instructions: `# Fix the Bug

The function below has a bug that causes it to return the wrong result.

## Buggy code

Open \`buggy.js\` — it contains:

\`\`\`js
function add(a, b) {
  return a - b;  // Bug is here
}
\`\`\`

## Your task

Fix the bug so that \`add(2, 3)\` returns \`5\`.

Once you've made the fix, click **Check Work**.
`,
    validatorBody: `  const { stdout, exitCode } = await context.terminal.run(
    'node -e "const {add}=require(\\'./buggy\\');console.log(add(2,3))"'
  );
  if (exitCode !== 0) return context.fail(\`Error running buggy.js: \${stdout}\`);
  if (stdout.trim() !== '5') {
    return context.fail(\`add(2, 3) returned \${stdout.trim()}, expected 5. Keep debugging!\`);
  }
  return context.pass('Bug fixed! \`add(2, 3)\` correctly returns 5.');`,
    starterFiles: [
      {
        path: 'buggy.js',
        content: `function add(a, b) {
  return a - b;  // Bug is here
}

module.exports = { add };
`,
      },
    ],
  },

  {
    id: 'run-command',
    name: 'Run a Command',
    icon: '▶️',
    description: 'Learner must run a specific terminal command',
    tags: ['terminal', 'beginner'],
    instructions: `# Initialize Your Project

Before we can start coding, we need to set up the project.

## Your task

Run the following command in the terminal:

\`\`\`bash
npm init -y
\`\`\`

This creates a \`package.json\` file that tracks your project's dependencies and scripts.

Once you've run it, click **Check Work**.
`,
    validatorBody: `  const exists = await context.files.exists('package.json');
  if (!exists) {
    return context.fail('package.json not found. Run \`npm init -y\` in the terminal.');
  }

  const cmd = await context.terminal.lastCommand();
  if (!cmd.includes('npm init')) {
    return context.warn('package.json found! (You may have run the command earlier — that\\'s fine.)');
  }

  return context.pass('package.json created successfully!');`,
  },

  {
    id: 'create-file',
    name: 'Create a File',
    icon: '📄',
    description: 'Learner must create a file with specific content',
    tags: ['files', 'beginner'],
    instructions: `# Create a Configuration File

Your application needs a configuration file to know which port to listen on.

## Your task

Create a file called \`config.json\` in the project root with this content:

\`\`\`json
{
  "port": 3000,
  "debug": false
}
\`\`\`

Make sure the JSON is valid and the values match exactly.

Once created, click **Check Work**.
`,
    validatorBody: `  if (!await context.files.exists('config.json')) {
    return context.fail('config.json not found. Create it in the project root.');
  }

  const raw = await context.files.read('config.json');
  let config;
  try { config = JSON.parse(raw); }
  catch { return context.fail('config.json contains invalid JSON. Check for missing commas or quotes.'); }

  if (config.port !== 3000) {
    return context.fail(\`Expected port 3000, got \${config.port}.\`);
  }
  if (config.debug !== false) {
    return context.fail('Expected debug to be false.');
  }
  return context.pass('config.json is correct!');`,
  },

  {
    id: 'answer-question',
    name: 'Answer a Question',
    icon: '❓',
    description: 'Learner writes their answer to a conceptual question in a text file',
    tags: ['theory', 'beginner'],
    instructions: `# What Is Version Control?

Before we dive into using Git, let's make sure we understand *why* we use it.

## Question

In your own words: **what is version control, and why is it useful?**

## Your task

Create a file called \`answer.txt\` and write your answer inside it (at least one sentence).

There's no single right answer — this is about articulating your understanding.

Click **Check Work** when you're done.
`,
    validatorBody: `  if (!await context.files.exists('answer.txt')) {
    return context.fail('answer.txt not found. Create it and write your answer.');
  }
  const content = await context.files.read('answer.txt');
  if (content.trim().length < 20) {
    return context.warn('Your answer is very short. Try to write at least a sentence explaining version control.');
  }
  return context.pass(\`Great answer! You wrote: "\${content.trim().slice(0, 80)}…"\`);`,
  },

  {
    id: 'install-deps',
    name: 'Install Dependencies',
    icon: '📦',
    description: 'Learner installs required packages using a package manager',
    tags: ['npm', 'setup'],
    instructions: `# Install Dependencies

This project needs a few packages before it can run.

## Your task

Install the required dependencies by running:

\`\`\`bash
npm install
\`\`\`

This will read \`package.json\` and install everything listed under \`"dependencies"\`.

After installation you should see a \`node_modules/\` folder.

Click **Check Work** once done.
`,
    validatorBody: `  const installed = await context.files.exists('node_modules');
  if (!installed) {
    return context.fail('node_modules not found. Run \`npm install\` first.');
  }

  // Check that a core dependency is actually present
  const hasExpress = await context.files.exists('node_modules/express');
  if (!hasExpress) {
    return context.fail('"express" not installed. Check package.json and re-run \`npm install\`.');
  }

  return context.pass('Dependencies installed successfully!');`,
    starterFiles: [
      {
        path: 'package.json',
        content: `{
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
`,
      },
    ],
  },

  {
    id: 'edit-config',
    name: 'Edit Configuration',
    icon: '⚙️',
    description: 'Learner modifies an existing configuration file to meet a requirement',
    tags: ['config', 'intermediate'],
    instructions: `# Enable Strict Mode

TypeScript's \`strict\` mode catches many common bugs at compile time.

## Your task

Open \`tsconfig.json\` and enable strict mode by ensuring \`compilerOptions\` contains:

\`\`\`json
{
  "compilerOptions": {
    "strict": true
  }
}
\`\`\`

If the file doesn't exist yet, create it with these contents.

Click **Check Work** when done.
`,
    validatorBody: `  if (!await context.files.exists('tsconfig.json')) {
    return context.fail('tsconfig.json not found. Create it with strict: true.');
  }
  const raw = await context.files.read('tsconfig.json');
  let ts;
  try { ts = JSON.parse(raw); }
  catch { return context.fail('tsconfig.json is not valid JSON.'); }
  if (!ts.compilerOptions?.strict) {
    return context.fail('"strict": true not set in compilerOptions. Update tsconfig.json.');
  }
  return context.pass('TypeScript strict mode is enabled!');`,
    starterFiles: [
      {
        path: 'tsconfig.json',
        content: `{
  "compilerOptions": {
    "strict": false
  }
}
`,
      },
    ],
  },

  {
    id: 'write-test',
    name: 'Write a Test',
    icon: '✅',
    description: 'Learner writes a unit test that verifies a function\'s behaviour',
    tags: ['testing', 'intermediate'],
    instructions: `# Write a Unit Test

Good code is tested code. In this step you'll write a test for the \`add\` function.

## Your task

Create a file called \`add.test.js\` that tests the \`add\` function from \`add.js\`:

\`\`\`js
const { add } = require('./add');

test('adds two numbers', () => {
  expect(add(2, 3)).toBe(5);
});

test('handles negative numbers', () => {
  expect(add(-1, 1)).toBe(0);
});
\`\`\`

Run \`npm test\` to verify your tests pass before clicking **Check Work**.
`,
    validatorBody: `  if (!await context.files.exists('add.test.js')) {
    return context.fail('add.test.js not found. Create it with at least one test.');
  }

  const content = await context.files.read('add.test.js');
  if (!content.includes('test(') && !content.includes('it(')) {
    return context.fail('No test() or it() calls found in add.test.js.');
  }

  const { stdout, exitCode } = await context.terminal.run('npm test -- --testPathPattern=add');
  if (exitCode !== 0) {
    return context.fail(\`Tests are failing:\\n\${stdout}\`);
  }
  return context.pass('Tests written and passing!');`,
    starterFiles: [
      {
        path: 'add.js',
        content: `function add(a, b) {
  return a + b;
}

module.exports = { add };
`,
      },
      {
        path: 'package.json',
        content: `{
  "scripts": {
    "test": "jest"
  },
  "devDependencies": {
    "jest": "^29.0.0"
  }
}
`,
      },
    ],
  },
];
