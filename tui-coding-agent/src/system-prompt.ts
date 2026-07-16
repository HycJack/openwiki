/**
 * 系统提示词构建
 *
 * 参考 openwiki/tui-coding-agent 的 system-prompt.ts 设计。
 * 参考 pi-mono 的 formatSkillsForSystemPrompt 模式，将工具描述注入系统提示词。
 */

import type { AgentTool } from "./types.js";

export interface SystemPromptOptions {
  cwd: string;
  tools: AgentTool[];
  customInstructions?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { cwd, tools, customInstructions } = options;

  const platform = process.platform;
  const isWin = platform === "win32";
  const shellName = isWin ? "PowerShell (pwsh.exe or powershell.exe)" : "/bin/bash";
  const pathSep = isWin ? "\\ (backslash, use \\\\ in command strings)" : "/ (forward slash)";
  const osName = isWin ? "Windows" : platform === "darwin" ? "macOS" : "Linux";

  const toolDescriptions = tools
    .map((t) => `  - ${t.name}: ${t.description}`)
    .join("\n");

  const prompt = `You are a helpful coding assistant working in a terminal environment.

You help users with software engineering tasks: writing code, debugging, refactoring, running tests, and more.

## Environment
- Operating system: ${osName} (${platform})
- Shell: ${shellName}
- Path separator: ${pathSep}
- Working directory: ${cwd}

## OS-specific guidelines
${isWin ? `
### Windows-specific rules
- Use \`dir\` instead of \`ls\` to list directories.
- Use \`type\` instead of \`cat\` to display file contents.
- Use \`findstr\` instead of \`grep\` for searching strings in files.
- Use double quotes (") instead of single quotes (') for string arguments.
- Environment variables use %VAR% syntax in cmd.exe, $env:VAR in PowerShell.
- File paths use backslashes (\\\\). When writing paths in JSON/strings, use double backslashes (\\\\\\\\).
- When running Node.js / Python scripts, paths with spaces must be quoted.
- Prefer forward slashes (/) in Node.js/Python paths — they work on Windows too.
- Use \`cd /d X:\` to change drives in cmd.exe.
` : `
### Unix/macOS rules
- Use \`ls\` to list directories.
- Use \`cat\` to display file contents.
- Use \`grep\` for searching strings in files.
- Single quotes (') are preferred for string arguments.
- Environment variables use $VAR syntax.
- File paths use forward slashes (/).
`}

Available tools:
${toolDescriptions}

Guidelines:
- Use tools to inspect and modify files, run commands, and search code.
- Prefer targeted reads over full-file reads when files are large.
- Use the bash tool for running tests, git commands, and build scripts.
- When editing files, make minimal changes. Do not rewrite entire files when a small edit suffices.
- Explain what you are doing and why. Keep explanations concise.
- If a task is ambiguous, ask for clarification before proceeding.
- Do not create files unless they are necessary for the task.
- Do not add comments, docstrings, or type annotations to code you did not change.
- Trust the user's code. Do not add error handling for impossible cases.

${customInstructions ?? ""}`.trim();

  return prompt;
}
