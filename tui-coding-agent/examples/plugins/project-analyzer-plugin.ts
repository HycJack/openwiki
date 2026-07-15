/**
 * 项目分析插件
 *
 * 类似 openwiki 的代码分析功能：
 * - 分析项目结构、关键配置、依赖关系和模块架构
 * - 生成结构化的项目概览报告
 * - 提供 /analyze 命令手动触发分析
 */

import { Type } from "typebox";
import { readdir, stat, readFile } from "node:fs/promises";
import * as fs from "node:fs";
import path from "node:path";
import type { PluginAPI } from "../../src/plugin/types.js";

// -------------------------------------------------------
// 分析类型
// -------------------------------------------------------

interface ProjectInfo {
  name: string;
  version?: string;
  type: "module" | "commonjs";
  description?: string;
  entryPoint?: string;
}

interface ModuleInfo {
  name: string;
  path: string;
  type: "module" | "config" | "tests" | "docs" | "tool" | "plugin" | "other";
  files: number;
}

interface DependencyInfo {
  name: string;
  version: string;
  isDev: boolean;
}

interface KeyFile {
  path: string;
  summary: string;
}

interface AnalysisReport {
  project: ProjectInfo;
  modules: ModuleInfo[];
  dependencies: { total: number; production: number; dev: number };
  topDependencies: DependencyInfo[];
  keyFiles: KeyFile[];
  directoryTree: string;
}

// -------------------------------------------------------
// 分析逻辑
// -------------------------------------------------------

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next",
  ".turbo", ".cache", "__pycache__", ".venv", "venv", ".tca",
]);

const IGNORE_FILES = new Set([
  ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".gitignore", ".editorconfig", ".prettierrc", ".eslintrc",
]);

function isSourceExt(ext: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".vue", ".svelte",
    ".rb", ".php", ".swift", ".kt", ".kts", ".scala", ".ex", ".exs", ".clj", ".cljs",
    ".dart", ".lua", ".jl", ".elm", ".hs", ".nim", ".crystal", ".zig", ".odin",
    ".cs", ".fs", ".fsx", ".sql", ".r", ".m", ".mm",
  ].includes(ext);
}

function isConfigExt(ext: string): boolean {
  return [".json", ".yaml", ".yml", ".toml", ".env", ".config.js", ".config.ts"].includes(ext);
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function classifyDir(name: string): ModuleInfo["type"] {
  const lower = name.toLowerCase();
  if (lower === "src" || lower === "lib" || lower === "app" || lower === "source") return "module";
  if (lower === "test" || lower === "tests" || lower === "__tests__" || lower === "spec" || lower === "e2e") return "tests";
  if (lower === "docs" || lower === "doc" || lower === "documentation") return "docs";
  if (lower === "config" || lower === "cfg" || lower === "configuration") return "config";
  if (lower === "plugin" || lower === "plugins" || lower === "extension" || lower === "extensions") return "plugin";
  if (lower === "bin" || lower === "cli" || lower === "scripts" || lower === "tool" || lower === "tools") return "tool";
  return "other";
}

async function analyzeDirectory(
  dirPath: string,
  depth: number = 0,
  maxDepth: number = 4,
): Promise<{ tree: string[]; sourceFiles: number; moduleMap: Map<string, number> }> {
  const tree: string[] = [];
  let sourceFiles = 0;
  const moduleMap = new Map<string, number>();

  if (depth > maxDepth) return { tree, sourceFiles, moduleMap };

  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const items = entries
    .filter((e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  for (const entry of items) {
    const fullPath = path.join(dirPath, entry.name);
    const prefix = "  ".repeat(depth) + (entry === items[items.length - 1] ? "└─ " : "├─ ");

    if (entry.isDirectory()) {
      const dirType = classifyDir(entry.name);
      tree.push(`${prefix}${entry.name}/`);
      const sub = await analyzeDirectory(fullPath, depth + 1, maxDepth);
      tree.push(...sub.tree);
      sourceFiles += sub.sourceFiles;
      const current = moduleMap.get(dirType) ?? 0;
      moduleMap.set(dirType, current + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!IGNORE_FILES.has(entry.name) && (isSourceExt(ext) || isConfigExt(ext))) {
        sourceFiles++;
      }
      tree.push(`${prefix}${entry.name}`);
    }
  }

  return { tree, sourceFiles, moduleMap };
}

async function analyzeProject(cwd: string): Promise<AnalysisReport> {
  // 读取 package.json
  const pkgJson = await readJsonSafe(path.join(cwd, "package.json"));
  const project: ProjectInfo = {
    name: (pkgJson?.name as string) ?? path.basename(cwd),
    version: pkgJson?.version as string | undefined,
    description: pkgJson?.description as string | undefined,
    type: (pkgJson?.type as "module" | "commonjs") ?? "commonjs",
    entryPoint: (pkgJson?.main as string) ?? "index.js",
  };

  // 分析目录结构
  const { tree, sourceFiles, moduleMap } = await analyzeDirectory(cwd);

  // 读取依赖
  const deps = pkgJson?.dependencies as Record<string, string> | undefined;
  const devDeps = pkgJson?.devDependencies as Record<string, string> | undefined;
  const prodCount = deps ? Object.keys(deps).length : 0;
  const devCount = devDeps ? Object.keys(devDeps).length : 0;

  const topDeps: DependencyInfo[] = [];
  if (deps) {
    for (const [name, version] of Object.entries(deps).slice(0, 15)) {
      topDeps.push({ name, version, isDev: false });
    }
  }
  if (devDeps) {
    for (const [name, version] of Object.entries(devDeps).slice(0, 10)) {
      topDeps.push({ name, version, isDev: true });
    }
  }

  // 分析关键文件
  const keyFiles: KeyFile[] = [];

  // tsconfig
  const tsconfig = await readJsonSafe(path.join(cwd, "tsconfig.json"));
  if (tsconfig) {
    const target = (tsconfig.compilerOptions as Record<string, unknown> | undefined)?.target;
    const jsx = (tsconfig.compilerOptions as Record<string, unknown> | undefined)?.jsx;
    keyFiles.push({
      path: "tsconfig.json",
      summary: `TypeScript config${target ? ` (target: ${target})` : ""}${jsx ? ` (jsx: ${jsx})` : ""}`,
    });
  }

  // eslint config
  for (const name of ["eslint.config.mjs", "eslint.config.js", ".eslintrc", ".eslintrc.json"]) {
    if (fs.existsSync(path.join(cwd, name))) {
      keyFiles.push({ path: name, summary: "ESLint configuration" });
      break;
    }
  }

  // README
  for (const name of ["README.md", "README.txt", "Readme.md"]) {
    if (fs.existsSync(path.join(cwd, name))) {
      const content = await readFile(path.join(cwd, name), "utf-8").catch(() => "");
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      keyFiles.push({
        path: name,
        summary: firstLine ? `${firstLine}` : "Project README",
      });
      break;
    }
  }

  // 入口文件
  if (project.entryPoint && fs.existsSync(path.join(cwd, project.entryPoint))) {
    keyFiles.push({ path: project.entryPoint, summary: "Project entry point" });
  }

  // 主要源目录中的 index/main 文件
  for (const dir of ["src", "lib", "app"]) {
    for (const name of ["index.ts", "index.js", "main.ts", "main.js", "app.ts", "app.tsx"]) {
      const fp = path.join(cwd, dir, name);
      if (fs.existsSync(fp)) {
        keyFiles.push({ path: path.posix.join(dir, name), summary: `Module entry (${dir}/)` });
        break;
      }
    }
  }

  // 模块分析
  const modules: ModuleInfo[] = [];
  for (const [mType, count] of moduleMap) {
    modules.push({ name: mType, path: mType, type: mType as ModuleInfo["type"], files: count });
  }
  // 保证 src 在最前面
  modules.sort((a, b) => {
    if (a.type === "module") return -1;
    if (b.type === "module") return 1;
    return b.files - a.files;
  });

  return {
    project,
    modules,
    dependencies: { total: prodCount + devCount, production: prodCount, dev: devCount },
    topDependencies: topDeps,
    keyFiles,
    directoryTree: tree.join("\n"),
  };
}

// -------------------------------------------------------
// 格式化报告
// -------------------------------------------------------

function formatReport(report: AnalysisReport): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════╗");
  lines.push("║        Project Analysis Report          ║");
  lines.push("╚══════════════════════════════════════════╝");
  lines.push("");

  lines.push(`Project: ${report.project.name}${report.project.version ? ` v${report.project.version}` : ""}`);
  if (report.project.description) lines.push(`  Description: ${report.project.description}`);
  lines.push(`  Type: ${report.project.type}`);
  lines.push(`  Entry: ${report.project.entryPoint}`);
  lines.push("");

  lines.push("── Key Files ──");
  for (const kf of report.keyFiles) {
    lines.push(`  ${kf.path}`);
    lines.push(`    ${kf.summary}`);
  }
  lines.push("");

  lines.push("── Dependencies ──");
  lines.push(`  Total: ${report.dependencies.total} (prod: ${report.dependencies.production}, dev: ${report.dependencies.dev})`);
  if (report.topDependencies.length > 0) {
    lines.push("  Top:");
    for (const dep of report.topDependencies.slice(0, 10)) {
      lines.push(`    ${dep.isDev ? "[dev] " : ""}${dep.name}@${dep.version}`);
    }
  }
  lines.push("");

  lines.push("── Modules ──");
  for (const mod of report.modules) {
    lines.push(`  ${mod.type}: ${mod.files} subdirectories`);
  }
  lines.push("");

  lines.push("── Directory Structure ──");
  // 限制目录树长度
  const treeLines = report.directoryTree.split("\n");
  const truncated = treeLines.length > 60 ? [...treeLines.slice(0, 58), "  ... (truncated)"] : treeLines;
  for (const line of truncated) {
    lines.push(`  ${line}`);
  }
  lines.push("");

  lines.push("── Analysis Summary ──");
  lines.push(`  Source files: ${report.keyFiles.filter((f) => f.path.endsWith(".ts") || f.path.endsWith(".js")).length}`);
  lines.push(`  Key configs: ${report.keyFiles.filter((f) => f.path.endsWith(".json") || f.path.includes("eslint")).length}`);
  lines.push(`  Top dependencies: ${report.topDependencies.length}`);

  return lines.join("\n");
}

// -------------------------------------------------------
// 插件入口
// -------------------------------------------------------

export default function projectAnalyzerPlugin(api: PluginAPI): void {
  // 注册分析工具
  api.registerTool({
    name: "analyze_project",
    label: "Analyze Project",
    description:
      "Analyze the project structure: key files, dependencies, modules, and directory layout. " +
      "Useful when you need to understand a new codebase before making changes.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Project root directory to analyze (default: cwd)" })),
    }),
    execute: async (_toolCallId, params) => {
      const dir = params.path ?? process.cwd();
      const report = await analyzeProject(dir);
      const text = formatReport(report);

      return {
        content: [{ type: "text", text }],
        details: { report },
      };
    },
  });

  // 注册 /analyze 命令
  api.registerCommand("analyze", async (ctx, args) => {
    await ctx.waitForIdle();
    const targetDir = args.trim() || ctx.cwd;
    const resolvedDir = path.resolve(ctx.cwd, targetDir);
    // 检查目录是否存在
    try {
      await stat(resolvedDir);
    } catch {
      ctx.notify(`Directory not found: ${resolvedDir}`, "error");
      return;
    }
    const report = await analyzeProject(resolvedDir);
    const text = formatReport(report);
    ctx.sendMessage(
      `Project Analysis for ${report.project.name} (${resolvedDir}):\n\n${text}`,
    );
  });

  // 在 agent 启动时输出简短的项目信息
  api.on("before_agent_start", () => {
    api.notify("[INFO] Project analyzer loaded. Use /analyze for full report, or ask the AI to run analyze_project tool.", "info");
  });
}
