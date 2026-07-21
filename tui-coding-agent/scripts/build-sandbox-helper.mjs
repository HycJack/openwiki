/**
 * build-sandbox-helper.mjs — 编译 Windows 沙箱辅助工具
 *
 * 在 GitHub Actions Windows runner 上编译 HanaWindowsSandboxHelper main.cpp。
 * windows-latest 镜像预装了 Visual Studio Build Tools，通过 vswhere 查找 VS 安装路径。
 *
 * 用法：node scripts/build-sandbox-helper.mjs [arch]
 *   arch: x64 | arm64（默认 x64）
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function shouldBuild({ platform = process.platform } = {}) {
  return platform === "win32";
}

function outputDir({ arch = process.arch } = {}) {
  return path.join(rootDir, "bin");
}

function buildCompileCommand({ source, output } = {}) {
  if (!source) throw new Error("source is required");
  if (!output) throw new Error("output is required");
  const quote = (s) => `"${s.replace(/"/g, '\\"')}"`;
  return [
    "cl.exe",
    "/nologo",
    "/EHsc",
    "/std:c++17",
    "/W4",
    "/O2",
    quote(source),
    "/link",
    `/OUT:${quote(output)}`,
    "advapi32.lib",
    "user32.lib",
    "kernel32.lib",
  ].join(" ");
}

function findVsDevCmd() {
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) return null;

  try {
    const installationPath = execFileSync(vswhere, [
      "-latest",
      "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property", "installationPath",
    ], { encoding: "utf8", windowsHide: true }).trim();
    if (!installationPath) return null;
    const devCmd = path.join(installationPath, "Common7", "Tools", "VsDevCmd.bat");
    return fs.existsSync(devCmd) ? devCmd : null;
  } catch {
    return null;
  }
}

function runCompile(command) {
  const devCmd = findVsDevCmd();
  const scriptPath = path.join(outputDir(), "build-sandbox-helper.cmd");
  const lines = ["@echo off"];
  if (devCmd) {
    lines.push(`call "${devCmd}" -arch=x64`);
    lines.push("if errorlevel 1 exit /b %errorlevel%");
  }
  lines.push(command);
  lines.push("exit /b %errorlevel%");

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, lines.join("\r\n"), "utf-8");
  console.log(`[sandbox-helper] Running compile script: ${scriptPath}`);

  const result = spawnSync("cmd.exe", ["/d", "/c", scriptPath], {
    cwd: rootDir,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`[sandbox-helper] spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`[sandbox-helper] compile exited with code ${result.status}`);
  }
}

export function buildSandboxHelper({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!shouldBuild({ platform })) {
    console.log(`[sandbox-helper] skipped on ${platform}`);
    return { skipped: true };
  }

  const source = path.join(rootDir, "sandbox", "main.cpp");
  if (!fs.existsSync(source)) {
    throw new Error(`[sandbox-helper] source not found: ${source}`);
  }

  const outDir = outputDir({ arch });
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, "sandbox-helper.exe");
  const command = buildCompileCommand({ source, output });

  console.log(`[sandbox-helper] building ${output}`);
  runCompile(command);

  if (!fs.existsSync(output)) {
    throw new Error(`[sandbox-helper] build did not produce ${output}`);
  }
  console.log(`[sandbox-helper] build successful: ${output}`);
  return { skipped: false, target: output };
}

// 直接运行
if (process.argv[1] && fileURLToPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arch = process.argv[2] || process.arch;
    buildSandboxHelper({ arch });
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}
