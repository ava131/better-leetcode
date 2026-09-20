#!/usr/bin/env node
/**
 * markdown.js 的单测。
 *
 *   node extension/test/markdown.test.mjs
 *
 * 重点不在"渲染得好不好看"，而在 **XSS 安全**：
 * 模型输出是不可信输入，渲染器必须先转义再格式化。
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 执行 markdown.js 的副作用：往 globalThis.__BL_MD__ 挂 { esc, md }
new Function(readFileSync(resolve(HERE, "../src/markdown.js"), "utf8"))();
const { md, esc } = globalThis.__BL_MD__;

let pass = 0,
  fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 160)));
  }
};

console.log("=== 1) 行内 ===");
check("粗体", md("**粗**").includes("<strong>粗</strong>"));
check("斜体", md("*斜*").includes("<em>斜</em>"));
check("行内代码", md("用 `left = mid` 试试").includes("<code>left = mid</code>"));
check("删除线", md("~~删~~").includes("<del>删</del>"));
check("链接", md("[文档](https://example.com/a)").includes('href="https://example.com/a"'));
check("段落包裹", md("一行话").includes("<p>一行话</p>"));

console.log("\n=== 2) 代码块 ===");
const cb = md("说明：\n\n```python\nif fast == slow:\n    return True\n```\n\n完。");
check("有 pre", cb.includes("<pre"));
check("保留了缩进", cb.includes("    return True"));
check("带了语言", cb.includes('data-lang="python"'));
check("代码块没被包进 <p>", !/<p>\s*<pre/.test(cb), cb);
check("未闭合的围栏也能渲染", md("看这个：\n```py\nx = 1").includes("<pre"));
// 代码块里的 markdown 不该被格式化
check(
  "代码块内的 ** 不被当粗体",
  !md("```\n**不该变粗**\n```").includes("<strong>"),
  md("```\n**不该变粗**\n```")
);

console.log("\n=== 3) 块级 ===");
check("h1", md("# 标题").includes("<h1>标题</h1>"));
check("h3", md("### 标题").includes("<h3>标题</h3>"));
check("h5 被压到 h4", md("##### 深").includes("<h4>"));
check("无序列表", md("- a\n- b").includes("<ul>") && md("- a\n- b").includes("<li>a</li>"));
check("有序列表", md("1. a\n2. b").includes("<ol>") && md("1. a").includes("<li>a</li>"));
check("列表项不残留 - 号", !md("- 第 11 行").includes("- 第"));
check("引用", md("> 注意").includes("<blockquote>"));
check("分隔线", md("---").includes("<hr>"));
const tbl = md("| 项 | 值 |\n|---|---|\n| 时间 | O(n) |");
check("表格", tbl.includes("<table>") && tbl.includes("<th>项</th>") && tbl.includes("<td>O(n)</td>"));
check("表格分隔行不出现", !tbl.includes("<td>---</td>"));

console.log("\n=== 4) 真实 LLM 输出片段 ===");
const real = `你错在第 11 行和第 13 行：

- 第 11 行 \`slow, fast = head, head\`，两个一开始都指向 \`head\`
- 第 13 行 \`if fast == slow\` 在移动之前就判断了

### 修法

\`\`\`python
while fast and fast.next:
    slow = slow.next
    fast = fast.next.next
    if slow == fast:
        return True
\`\`\`

> 核心：\`if\` 必须放在移动之后。`;
const r = md(real);
check("列表被渲染", r.includes("<ul>") && r.includes("<li>第 11 行"));
check("标题被渲染", r.includes("<h3>修法</h3>"));
check("引用被渲染", r.includes("<blockquote>"));
check("代码块被渲染", r.includes("<pre data-lang=\"python\">"));
check("没有裸露的 ** 或 ###", !r.includes("###") && !/\*\*/.test(r));

console.log("\n=== 5) XSS 安全（最关键）===");
check("script 标签被转义", !md('<script>alert(1)</script>').includes("<script"), md('<script>alert(1)</script>'));
check("img onerror 被转义", !/<img/i.test(md('<img src=x onerror=alert(1)>')));
check("iframe 被转义", !/<iframe/i.test(md('<iframe src="evil"></iframe>')));
check("双引号被转义", md('a "b"').includes("&quot;"));
check(
  "javascript: 链接不放行",
  !md("[点我](javascript:alert(1))").includes("<a "),
  md("[点我](javascript:alert(1))")
);
check(
  "data: 链接不放行",
  !md("[点我](data:text/html,<script>x</script>)").includes("<a "),
  md("[点我](data:text/html,<script>x</script>)")
);
check(
  "代码块里的标签也转义",
  !md("```\n<script>alert(1)</script>\n```").includes("<script")
);
check(
  "转义发生在格式化之前（&lt; 不会被重新解析）",
  !md("&lt;script&gt;").includes("<script")
);
check("esc 本身", esc("<>&\"") === "&lt;&gt;&amp;&quot;");

console.log("\n=== 6) 边界 ===");
check("空输入", md("") === "");
check("null", md(null) === "");
check("纯空白", md("   \n  ").trim() === "");
check("不崩：超长无换行", typeof md("x".repeat(5000)) === "string");

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
