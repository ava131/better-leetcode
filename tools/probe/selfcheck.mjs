#!/usr/bin/env node
/**
 * 注入脚本自检 —— **不开浏览器**，只做语法检查。
 *
 *   node tools/probe/selfcheck.mjs
 *
 * 存在理由（踩过两次，第二次还是我自己踩的）：
 *   `CHROME_STUB` 是一个**模板字符串**，里面写 `\n` 会被模板字符串解成
 *   **真实换行**，于是生成出来的注入脚本里出现"字符串字面量中间断行"：
 *
 *       reply({ type: "delta", text: "……跟随。
 *   " });
 *       → SyntaxError: Invalid or unexpected token
 *
 *   后果不是"测试报错"，而是**桩代码整段没跑起来** → 扩展以为后端没连上
 *   → `ui-wiring.mjs` 一片红，看起来像扩展坏了，实际是脚手架坏了。
 *   `node --check tools/probe/cdp.mjs` **查不出来**（它只把模板字符串当字符串）。
 *
 * 所以：凡是要注入页面的代码，都先在这里当**独立文件**跑一次语法检查。
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EXT_SRC = join(ROOT, "extension/src");

let pass = 0,
  fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : String(extra).slice(0, 300));
  }
};

const tmp = mkdtempSync(join(tmpdir(), "bl-selfcheck-"));
const syntaxOk = (file) => {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message).split("\n").slice(0, 4).join(" / ") };
  }
};

console.log("=== 1) 注入页面的桩代码（模板字符串生成的那份）===");
const cdp = await import("./cdp.mjs");
{
  const f = join(tmp, "chrome-stub.js");
  writeFileSync(f, cdp.CHROME_STUB);
  const r = syntaxOk(f);
  check("CHROME_STUB 生成的代码语法通过", r.ok, r.err);
  check("没有裸的 NUL 字符", !cdp.CHROME_STUB.includes("\u0000"));
  // 模板字符串里 `` ` `` 会直接截断整个字符串 —— 症状同样诡异
  check("模板串里没有多余的反引号", (cdp.CHROME_STUB.match(/`/g) || []).length === 0);
}

console.log("\n=== 2) 扩展本体 ===");
for (const f of readdirSync(EXT_SRC).filter((x) => x.endsWith(".js")).sort()) {
  const r = syntaxOk(join(EXT_SRC, f));
  check(`${f} 语法通过`, r.ok, r.err);
}

console.log("\n=== 3) 探针脚本自身 ===");
for (const f of readdirSync(HERE).filter((x) => x.endsWith(".mjs")).sort()) {
  const r = syntaxOk(join(HERE, f));
  check(`${f} 语法通过`, r.ok, r.err);
}

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
