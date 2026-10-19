#!/usr/bin/env node
/**
 * 「SYS」按钮 / prompt 查看-编辑-回滚 的界面回归。
 *
 *   node tools/probe/prompt-ui.mjs
 *
 * 为什么单独一个探针：这一串交互（锁住 → 编辑 → 保存 → 切版本 → 恢复）全是
 * 用户手指点出来的，静态接线检查只能证明"函数和绑定还在"，证明不了"点下去真的对"。
 *
 * 后端用 `chrome.runtime.sendMessage` 的假实现顶替 —— 所以**不会碰你真在用的 prompt**，
 * 也不会写任何文件。
 *
 * 需要先起一个带调试端口的 Chrome（见 cdp.mjs 顶部注释）。不需要登录。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { open, sleep, EXT_SRC, CHROME_STUB } from "./cdp.mjs";

let pass = 0,
  fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 300)));
  }
};

const cdp = await open();
await cdp.send("Runtime.enable");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "interceptor.js"), "utf8"));
await cdp.addInitScript(CHROME_STUB, "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "markdown.js"), "utf8"), "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "content.js"), "utf8"), "bl_ext");
await cdp.navigate("https://leetcode.cn/problems/linked-list-cycle/");
await sleep(6000);

const W = (expr) => cdp.evalInWorld("bl_ext", expr);

// 挑一个活着的面板并全程只用它（测试环境里可能叠了多个，见 ★36）
const picked = await W(`(() => {
  const hosts = [...document.querySelectorAll('#better-leetcode-host')]
    .filter(h => h.shadowRoot && h.shadowRoot.querySelector('.wrap'));
  const h = hosts[hosts.length - 1];
  if (!h) return false;
  const sr = h.shadowRoot;
  sr.querySelector('.wrap')?.classList.remove('collapsed');
  window.__p = {
    open:  sr.querySelector('[data-act="prompt"]'),
    view:  sr.querySelector('.prompt'),
    ver:   sr.querySelector('.pver'),
    edit:  sr.querySelector('.pedit'),
    save:  sr.querySelector('.psave'),
    cancel:sr.querySelector('.pcancel'),
    restore:sr.querySelector('.prestore'),
    text:  sr.querySelector('.ptext'),
    stat:  sr.querySelector('.pstat'),
    md:    sr.querySelector('.pmd'),
    ft:    sr.querySelector('.ft'),
    calls: [],
  };
  // 假装是后端：只记调用、返回固定内容，不写任何文件
  // ★ 这段是**注入进页面的源码**，反引号会把外层模板串截断（★44 同族），
  //   所以围栏用 String.fromCharCode(96) 生成，别直接写三个反引号。
  const F = String.fromCharCode(96, 96, 96);
  const CUR = '# 假 prompt 当前版\\n\\n- 第一项\\n- 第二项\\n\\n' + F + 'python\\nprint(1)\\n' + F;
  const OLD = '【假 prompt 历史版】\\n旧的内容';
  window.chrome.runtime.sendMessage = async (msg) => {
    window.__p.calls.push(msg);
    if (msg.type === 'promptGet')
      return { ok: true, chars: CUR.length, path: '/tmp/fake/system.md', text: CUR,
               versions: [{ name: 'system.v0.9.0.md', chars: OLD.length, mtimeMs: Date.now() - 86400000, kind: 'milestone' }] };
    if (msg.type === 'promptVersion') return { ok: true, name: msg.payload.name, text: OLD };
    if (msg.type === 'promptSave')    return { ok: true, chars: msg.payload.text.length, archived: 'edited-2026.md' };
    if (msg.type === 'promptRestore') return { ok: true, chars: OLD.length, archived: 'edited-2026b.md' };
    if (msg.type === 'health') return { ok: true, model: 'stub', models: ['stub'], hasKey: true };
    return { ok: true };
  };
  return !!(window.__p.open && window.__p.view && window.__p.text);
})()`);
check("找到面板（SYS 按钮 + 视图都在）", picked === true, picked);
if (picked !== true) {
  console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}

const snap = `JSON.stringify((() => {
  const p = window.__p;
  return {
    open: !p.view.hidden,
    readonly: p.text.readOnly,
    value: p.text.value,
    textHidden: p.text.hidden,
    mdHidden: !p.md || p.md.hidden,
    mdHtml: p.md ? p.md.innerHTML : '',
    hasH1: !!(p.md && p.md.querySelector('h1')),
    hasLi: !!(p.md && p.md.querySelector('li')),
    hasPre: !!(p.md && p.md.querySelector('pre')),
    stat: p.stat.textContent,
    editShown: !p.edit.hidden,
    saveShown: !p.save.hidden,
    cancelShown: !p.cancel.hidden,
    restoreShown: !p.restore.hidden,
    verDisabled: p.ver.disabled,
    verValue: p.ver.value,
    verCount: p.ver.options.length,
    // ★ 别用 .hidden 属性判断 —— 类选择器里的 display:flex 会盖掉 [hidden]，
    //   属性是 true、画面照样显示（v0.10.0 就这么骗过我一次）。看真实可见性。
    ftHidden: getComputedStyle(p.ft).display === 'none',
    chipsHidden: getComputedStyle(p.ft.parentElement.querySelector('.chips')).display === 'none',
  };
})())`;
const S = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return null; }
};

console.log("=== 1) 点 SYS：打开、**锁住**、只读 ===");
await W(`window.__p.open.click(); "ok"`);
await sleep(600);
{
  const s = S(await W(snap));
  check("视图打开了", s?.open === true, s);
  check("★ 默认是只读（不能直接改）", s?.readonly === true, s);
  check("内容就是当前 prompt", s?.value?.includes("假 prompt 当前版"), s?.value);
  check("状态栏说清楚了「只读」", /只读/.test(s?.stat ?? ""), s?.stat);
  check("有版本下拉，且默认是「当前版本」", s?.verCount >= 2 && s?.verValue === "", s);
  check("只有「编辑」，没有保存/取消/恢复", s?.editShown && !s?.saveShown && !s?.cancelShown && !s?.restoreShown, s);
  check("输入区**真的**藏起来了（不是只设了属性）", s?.ftHidden === true, s);
  check("推荐问题那排也藏起来了", s?.chipsHidden === true, s);
  check("★ 只读时把 markdown **渲染**出来了", s?.hasH1 === true && s?.hasLi === true && s?.hasPre === true, s?.mdHtml?.slice(0, 200));
  check("★ 只读时不显示原文 textarea", s?.textHidden === true, s);
  check("原文里的 # / - 不该露在渲染结果里", !/>#[^<]/.test(s?.mdHtml ?? ""), s?.mdHtml?.slice(0, 120));
}

console.log("\n=== 2) 点「编辑」：解锁 ===");
await W(`window.__p.edit.click(); "ok"`);
await sleep(300);
{
  const s = S(await W(snap));
  check("★ 变成可编辑", s?.readonly === false, s);
  check("出现「保存」和「取消」", s?.saveShown && s?.cancelShown, s);
  check("「编辑」自己藏起来", s?.editShown === false, s);
  check("编辑时不能切版本（避免改一半跳走）", s?.verDisabled === true, s);
  check("★ 编辑时露出原文 txtarea（保留 # - ``` ）", s?.textHidden === false && /# 假 prompt/.test(s?.value ?? ""), s?.value?.slice(0, 80));
  check("编辑时不再显示渲染结果", s?.mdHidden === true, s);
}

console.log("\n=== 3) 改内容 + 点「保存」===");
await W(`(() => { const p = window.__p; p.text.value = "【我改过的 prompt】\\n新内容"; p.save.click(); return "ok"; })()`);
await sleep(800);
{
  const s = S(await W(snap));
  const calls = S(await W(`JSON.stringify(window.__p.calls.map(c => ({ t: c.type, text: c.payload && c.payload.text })))`));
  const save = (calls ?? []).find((c) => c.t === "promptSave");
  check("★ 真的把改后的内容发给后端了", save?.text?.includes("我改过的 prompt"), save);
  check("保存后又回到只读", s?.readonly === true, s);
  check("状态栏说「下一轮对话就生效」（不用重启）", /下一轮|生效/.test(s?.stat ?? ""), s?.stat);
  check("状态栏提到上一版已归档", /归档/.test(s?.stat ?? ""), s?.stat);
}

console.log("\n=== 4) 从下拉切到一个历史版本（只读预览）===");
await W(`(() => { const p = window.__p; p.ver.value = "system.v0.9.0.md"; p.ver.dispatchEvent(new Event("change")); return "ok"; })()`);
await sleep(600);
{
  const s = S(await W(snap));
  check("显示的是历史版本内容", s?.value?.includes("假 prompt 历史版"), s?.value);
  check("★ 预览历史版本时仍是只读", s?.readonly === true, s);
  check("出现「恢复这一版」，且没有「编辑」", s?.restoreShown && s?.editShown === false, s);
  check("状态栏说明「正在看历史版本」", /历史版本/.test(s?.stat ?? ""), s?.stat);
  check("历史版本也渲染成 markdown", s?.mdHidden === false, s);
}

console.log("\n=== 5) 点「恢复这一版」===");
await W(`window.__p.restore.click(); "ok"`);
await sleep(800);
{
  const s = S(await W(snap));
  const calls = S(await W(`JSON.stringify(window.__p.calls.map(c => ({ t: c.type, name: c.payload && c.payload.name })))`));
  const rs = (calls ?? []).find((c) => c.t === "promptRestore");
  check("★ 恢复请求带上了版本名", rs?.name === "system.v0.9.0.md", rs);
  check("状态栏说恢复成功、且会生效", /恢复|生效/.test(s?.stat ?? ""), s?.stat);
  check("恢复后下拉回到「当前版本」", s?.verValue === "", s);
}

console.log("\n=== 6) 再点 SYS：关掉视图、回到对话 ===");
await W(`window.__p.open.click(); "ok"`);
await sleep(400);
{
  const s = S(await W(snap));
  check("视图关了", s?.open === false, s);
  check("输入区回来了", s?.ftHidden === false, s);
  check("推荐问题也回来了", s?.chipsHidden === false, s);
}

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
