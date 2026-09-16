/**
 * 力扣题干是 HTML，喂给模型前转成 markdown。
 * 目标：砍掉 60~80% 字符，且模型对 markdown 更稳。
 *
 * 刻意做得简单 —— 不引入依赖，覆盖力扣实际用到的标签即可。
 */

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&le;": "<=",
  "&ge;": ">=",
  "&ne;": "!=",
  "&times;": "x",
  "&minus;": "-",
  "&hellip;": "...",
  "&mdash;": "—",
  "&ndash;": "–",
};

function decodeEntities(s: string): string {
  let out = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out;
}

export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  let s = html;

  // 丢掉完全无用的块
  s = s.replace(/<(script|style|svg|iframe)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // 数学公式：力扣用 <span class="katex"> / <sup> / <sub>
  s = s.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, "^$1");
  s = s.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, "_$1");
  // 上标数字（力扣常用 10<sup>4</sup> 表示 10^4）
  s = s.replace(/\^(\d+)/g, "^$1");

  // 块级：pre / code
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => "\n```\n" + c + "\n```\n");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => "`" + c.trim() + "`");

  // 行内样式
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // 列表
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => "- " + c.trim() + "\n");
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");

  // 块级换行
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|tr|table|blockquote)>/gi, "\n\n");
  s = s.replace(/<(p|div|h[1-6]|tr|table|blockquote)[^>]*>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "[$1]");
  s = s.replace(/<img[^>]*>/gi, "");

  // 剩余标签一律去掉
  s = s.replace(/<[^>]+>/g, "");

  s = decodeEntities(s);

  // 归一化空白：保留段落，压掉多余空行与行尾空格
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, (m) => (m.length > 0 && /^[-*]/.test(l.trim()) ? m : m)))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  return s;
}
