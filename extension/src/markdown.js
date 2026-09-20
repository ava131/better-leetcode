/**
 * Markdown 渲染（供 content.js 使用）。
 *
 * 单独成文件的理由：content script 的多个 js 文件共享同一个 ISOLATED 作用域，
 * 所以可以这样拆；拆出来之后 Node 里也能直接 require 来跑单测。
 *
 * ⚠️ 安全前提：**先把整段转义，再做格式化**。输出里的 HTML 标签全部由本文件
 * 自己拼，绝不插入模型给的原始标签；链接只放行 http(s)。
 * 改动时务必守住这条 —— 模型输出是不可信输入。
 */

(function () {
  "use strict";

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /**
   * 覆盖 LLM 实际会输出的语法：围栏代码块、标题、有序/无序列表、引用、
   * 分隔线、表格、行内代码、粗体、斜体、删除线、链接。
   */
  function md(src) {
    let s = String(src ?? "");

    // 1) 先把代码块摘出来 —— 内容要原样保留，不能参与后续任何格式化
    const blocks = [];
    const stash = (lang, code) => {
      blocks.push({ lang: lang || "", code });
      return `\u0000BLK${blocks.length - 1}\u0000`;
    };
    s = s.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (_, lang, code) => stash(lang, code));
    // 未闭合的尾围栏（模型输出被截断时）
    s = s.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*)$/, (_, lang, code) => stash(lang, code));

    // 2) 转义（必须在格式化之前）
    s = esc(s);

    // 3) 行内
    s = s
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );

    // 4) 块级：逐行扫
    const out = [];
    let list = null; // "ul" | "ol"
    let inQuote = false;
    let table = [];

    const flushList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };
    const flushQuote = () => {
      if (inQuote) {
        out.push("</blockquote>");
        inQuote = false;
      }
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table
        .map((r) =>
          r
            .replace(/^\s*\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((c) => c.trim())
        )
        .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c))); // 去掉分隔行
      if (rows.length) {
        const head = rows[0];
        const body = rows.slice(1);
        out.push(
          "<table><thead><tr>" +
            head.map((c) => `<th>${c}</th>`).join("") +
            "</tr></thead><tbody>" +
            body.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
            "</tbody></table>"
        );
      }
      table = [];
    };
    const flushAll = () => {
      flushList();
      flushQuote();
      flushTable();
    };

    for (const raw of s.split("\n")) {
      const line = raw.replace(/[ \t]+$/, "");

      // 表格
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushList();
        flushQuote();
        table.push(line);
        continue;
      }
      flushTable();

      // 代码块占位符（单独一行）—— 直接输出，别再包 <p>
      if (/^\s*\u0000BLK\d+\u0000\s*$/.test(line)) {
        flushAll();
        out.push(line.trim());
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushAll();
        const lv = Math.min(h[1].length, 4);
        out.push(`<h${lv}>${h[2]}</h${lv}>`);
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        flushAll();
        out.push("<hr>");
        continue;
      }

      // 引用（> 已被转义成 &gt;）
      const q = line.match(/^\s*&gt;\s?(.*)$/);
      if (q) {
        flushList();
        flushTable();
        if (!inQuote) {
          out.push("<blockquote>");
          inQuote = true;
        }
        out.push(q[1].trim() ? `<p>${q[1]}</p>` : "");
        continue;
      }
      flushQuote();

      // 有序列表
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushTable();
        if (list !== "ol") {
          flushList();
          out.push("<ol>");
          list = "ol";
        }
        out.push(`<li>${ol[1]}</li>`);
        continue;
      }

      // 无序列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushTable();
        if (list !== "ul") {
          flushList();
          out.push("<ul>");
          list = "ul";
        }
        out.push(`<li>${ul[1]}</li>`);
        continue;
      }

      flushList();

      if (!line.trim()) {
        out.push("");
        continue;
      }
      out.push(`<p>${line}</p>`);
    }
    flushAll();

    let html = out.join("\n").replace(/\n{3,}/g, "\n\n");

    // 5) 还原代码块
    //
    // ★ 这里必须 esc：代码块是在**转义之前**被摘出来的，所以它的内容
    //   从未经过转义。忘了这一步就是一个 XSS 洞 —— 模型只要输出一个
    //   含 <script> 或 <img onerror> 的代码块就能注入 HTML。
    //   （单测 markdown.test.mjs 的「代码块里的标签也转义」就是守这条。）
    html = html.replace(/\u0000BLK(\d+)\u0000/g, (_, i) => {
      const b = blocks[Number(i)];
      const code = b.code.replace(/^\n+/, "").replace(/\n+$/, "");
      return `<pre data-lang="${esc(b.lang)}"><code>${esc(code)}</code></pre>`;
    });

    return html;
  }

  /**
   * 剥掉模型输出末尾的 <memory>…</memory> 段。
   *
   * 为什么需要：后端把 SSE 的**原始增量**直接转发下来，那段标签也在里面
   * （后端只是另外发一个 memory_suggestion 事件）。不剥的话用户会在对话里
   * 看到 `<memory>{"kind":...}</memory>` 的原始 JSON，而且它会被存进会话、
   * 下一轮再发给模型。
   *
   * 未闭合的也截掉 —— 流式过程中标签是一点点到的，不能让它闪出来。
   */
  function stripMemory(s) {
    let out = String(s ?? "")
      .replace(/<memory>[\s\S]*?<\/memory>/g, "")
      .replace(/<memory>[\s\S]*$/, "");
    // 流式途中标签可能只到了一半（"<mem"），尾巴上那半个也要藏起来。
    // 因为是拿**完整 buffer** 重算的，下一批字符到了它会自己回来，不会丢字。
    out = out.replace(/<(?:m(?:e(?:m(?:o(?:r(?:y)?)?)?)?)?)?$/, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  // 暴露给同作用域的 content.js（也方便在 Node 里单测）
  globalThis.__BL_MD__ = { esc, md, stripMemory };
})();
