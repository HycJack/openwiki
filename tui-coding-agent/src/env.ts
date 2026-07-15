/**
 * 环境变量加载
 *
 * 参考 openwiki 的 src/env.ts 设计：
 * - 从项目目录下的 .env 文件加载环境变量
 * - 如果 process.env 中已经设置了值，则不覆盖
 * - 纯 Node.js 实现，不依赖第三方库
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

type EnvMap = Record<string, string>;

/**
 * 查找 .env 文件的位置，按优先级：
 * 1. 当前工作目录下的 .env
 * 2. 用户目录下的 .tca/.env
 */
function findEnvPaths(cwd: string): string[] {
  const paths: string[] = [];
  paths.push(path.join(cwd, ".env"));
  paths.push(path.join(os.homedir(), ".tca", ".env"));
  return paths;
}

/**
 * 解析 .env 文件内容为键值对
 * 支持的格式：
 * - KEY=VALUE
 * - KEY="quoted value"
 * - # comment
 * - 空行
 */
export function parseEnv(content: string): EnvMap {
  const env: EnvMap = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();

    // 校验 key 格式：仅允许字母、数字、下划线，以字母或下划线开头
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    env[key] = parseEnvValue(rawValue);
  }

  return env;
}

function parseEnvValue(value: string): string {
  // 移除引号
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * 从指定路径加载 .env 文件并设置到 process.env
 * 仅当 process.env 中尚未设置该 key 时才会写入
 *
 * @param cwd 当前工作目录，用于查找 .env 文件
 * @returns 加载的键值对映射
 */
export async function loadEnv(cwd: string = process.cwd()): Promise<EnvMap> {
  const envPaths = findEnvPaths(cwd);
  const loaded: EnvMap = {};

  for (const envPath of envPaths) {
    try {
      const content = await readFile(envPath, "utf8");
      const parsed = parseEnv(content);

      for (const [key, value] of Object.entries(parsed)) {
        // 不覆盖已设置的环境变量
        if (process.env[key] === undefined) {
          process.env[key] = value;
          loaded[key] = value;
        }
      }
    } catch {
      // 文件不存在或无法读取，跳过
    }
  }

  return loaded;
}
