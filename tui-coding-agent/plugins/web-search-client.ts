/**
 * Web Search Client
 *
 * 基于 DuckDuckGo HTML 搜索 + 页面内容提取。
 * 纯 Node.js 内置 API（fetch + 正则），无外部依赖。
 *
 * 参考：https://github.com/emanuelcasco/pi-mono-extensions/tree/main/extensions/web-search
 */

// 只允许 http/https
const ALLOWED_PROTOCOLS = ["http:", "https:"];

// 阻止内网/私有地址
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,
  /^\[::\]$/,
];

const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; tca-web-search/0.1)";

export interface SearchResult {
  title: string;
  url: string;
  abstract: string;
}

export interface WebReadResult {
  title: string;
  content: string;
  truncated: boolean;
}

/** 验证 URL 合法性，阻止内网地址 */
function validateUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`URL protocol "${parsed.protocol}" is not allowed. Only http: and https: are supported.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname))) {
    throw new Error(`URL hostname "${hostname}" points to a private/internal network and is blocked.`);
  }
  return parsed;
}

/** 带重试的 fetch */
async function fetchWithRetry(url: string, timeoutMs: number, retries = 2): Promise<{ text: string; contentType: string }> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: {
            "user-agent": DEFAULT_USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "follow",
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        const text = await resp.text();
        const contentType = resp.headers.get("content-type") ?? "";
        return { text, contentType };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // 只在连接/超时类错误上重试
      const msg = lastErr.message;
      if (!/(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|timeout|abort)/i.test(msg)) {
        throw lastErr;
      }
      // 等待后重试（指数退避）
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

/** 从 DuckDuckGo 搜索结果 HTML 中提取链接 */
function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // 查找所有 .result 块
  const resultBlocks = html.match(/<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi);
  if (!resultBlocks) return results;

  for (const block of resultBlocks) {
    if (results.length >= maxResults) break;

    // 提取标题
    const titleMatch = block.match(/class="result__a"[^>]*>(.*?)<\/a>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]!).trim() : "";

    // 提取 URL（来自 uddg 参数）
    let url = "";
    const hrefMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/i);
    if (hrefMatch) {
      url = unwrapDuckDuckGoUrl(hrefMatch[1]!);
    }

    // 提取摘要
    const snippetMatch = block.match(/class="result__snippet"[^>]*>(.*?)<\/[a-z]+>/i);
    const abstract = snippetMatch ? stripHtml(snippetMatch[1]!).trim() : "";

    if (title && url) {
      results.push({ title, url, abstract });
    }
  }

  return results;
}

/** 解包 DuckDuckGo 的跳转 URL */
function unwrapDuckDuckGoUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, SEARCH_ENDPOINT);
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

/** 剥离 HTML 标签 */
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/** 简单的页面内容提取（正则版，无 JSDOM/Readability 依赖） */
function extractPageContent(html: string): { title: string; content: string } {
  // 提取标题
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]!) : "Untitled";

  // 移除脚本、样式、导航等
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "")
    // 移除注释
    .replace(/<!--[\s\S]*?-->/g, "")
    // 替换块级标签为换行
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|blockquote|pre|code|section|article)[^>]*>/gi, "\n")
    // 去掉其他所有标签
    .replace(/<[^>]+>/g, "")
    // 解码 HTML 实体
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    // 合并空白
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  // 限制最大长度
  const MAX_CHARS = 50000;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + "\n\n[...content truncated]";
  }

  return { title, content: text };
}

// ============================================================================
// Public API
// ============================================================================

export class WebSearchClient {
  private readonly searchTimeout: number;
  private readonly fetchTimeout: number;

  constructor(options?: { searchTimeout?: number; fetchTimeout?: number }) {
    this.searchTimeout = options?.searchTimeout ?? 15_000;
    this.fetchTimeout = options?.fetchTimeout ?? 15_000;
  }

  /** DuckDuckGo 搜索 */
  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const searchUrl = new URL(SEARCH_ENDPOINT);
    searchUrl.searchParams.set("q", query);
    const { text: html } = await fetchWithRetry(searchUrl.href, this.searchTimeout);
    return parseDuckDuckGoResults(html, maxResults);
  }

  /** 读取页面内容 */
  async readPage(url: string, maxChars = 8000): Promise<WebReadResult> {
    validateUrl(url);
    const { text: html } = await fetchWithRetry(url, this.fetchTimeout);
    const { title, content: rawContent } = extractPageContent(html);
    const truncated = rawContent.length > maxChars;
    const content = truncated ? rawContent.slice(0, maxChars) + "\n\n[Content truncated]" : rawContent;
    return { title, content, truncated };
  }
}
