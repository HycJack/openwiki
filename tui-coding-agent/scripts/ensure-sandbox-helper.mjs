/**
 * ensure-sandbox-helper.mjs — 确保 sandbox-helper.exe 存在，不存在则编译
 *
 * 参考 openhanako scripts/ensure-windows-sandbox-helper.mjs
 *
 * 用法：node scripts/ensure-sandbox-helper.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSandboxHelper } from "./build-sandbox-helper.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export function ensureSandboxHelper({
  platform = process.platform,
  arch = process.arch,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  build = buildSandboxHelper,
} = {}) {
  if (platform !== "win32") {
    console.log(`[sandbox-helper] not needed on ${platform}`);
    return { skipped: true, built: false };
  }

  const target = path.join(rootDir, "bin", "sandbox-helper.exe");
  const inputs = [
    path.join(rootDir, "sandbox", "main.cpp"),
    path.join(rootDir, "scripts", "build-sandbox-helper.mjs"),
  ];
  const targetMtime = existsSync(target) ? statSync(target).mtimeMs : -1;
  const newestInputMtime = Math.max(
    ...inputs.map((input) => (existsSync(input) ? statSync(input).mtimeMs : Number.POSITIVE_INFINITY)),
  );

  if (targetMtime >= newestInputMtime) {
    console.log(`[sandbox-helper] using existing ${target}`);
    return { skipped: false, built: false, target };
  }

  const result = build({ platform, arch });
  return { ...result, built: !result.skipped, target: result.target || target };
}

if (process.argv[1] && fileURLToPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureSandboxHelper({ arch: process.argv[2] || process.arch });
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}
