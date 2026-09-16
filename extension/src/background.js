/**
 * Service worker：唯一能发跨域请求的地方（content script 受页面 CORS 限制）。
 *
 * 注意：**不要在这里直接请求 leetcode.cn** —— 扩展上下文发跨站请求会丢
 * SameSite=Lax 的 LEETCODE_SESSION cookie。所有 leetcode 请求都在页面内
 * （拦截器 / content script）完成。这里只跟本地后端说话。
 */

const BACKEND = "http://127.0.0.1:8787";

// ★ 默认 storage.session 对 content script 是**不可见**的。
//   不放开的话，content script 里所有 storage.session 调用都会静默失败，
//   "刷新后恢复会话"就会失效。（实测 stub 环境掩盖了这个问题）
try {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
} catch (e) {
  console.warn("[bl] setAccessLevel 失败:", e);
}

async function backend(path, init) {
  const res = await fetch(BACKEND + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  return res;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "health") {
        const r = await backend("/health");
        sendResponse(await r.json());
        return;
      }
      if (msg.type === "confirmMemory") {
        const r = await backend("/memory/confirm", {
          method: "POST",
          body: JSON.stringify(msg.payload),
        });
        sendResponse(await r.json());
        return;
      }
      if (msg.type === "recordSubmission") {
        await backend("/submission", { method: "POST", body: JSON.stringify(msg.payload) });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "diag") {
        await backend("/diag", { method: "POST", body: JSON.stringify(msg.payload) });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "overview") {
        const r = await backend("/memory/overview");
        sendResponse(await r.json());
        return;
      }
      sendResponse({ error: "未知消息类型 " + msg.type });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // 异步响应
});

// ───────────────── 流式对话（用 port，因为要持续推送） ─────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat") return;

  let aborted = false;
  port.onDisconnect.addListener(() => {
    aborted = true;
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "chat") return;

    const ac = new AbortController();
    port.onDisconnect.addListener(() => ac.abort());

    try {
      const res = await fetch(BACKEND + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg.payload),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        port.postMessage({ type: "error", message: `${res.status} ${t.slice(0, 200)}` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done || aborted) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;

          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }

          if (event === "delta") port.postMessage({ type: "delta", text: payload.text });
          else if (event === "thinking") port.postMessage({ type: "thinking", text: payload.text });
          else if (event === "memory_suggestion")
            port.postMessage({ type: "memory_suggestion", suggestions: payload.suggestions });
          else if (event === "done") port.postMessage({ type: "done", ...payload });
          else if (event === "error") port.postMessage({ type: "error", message: payload.message });
        }
      }
      if (!aborted) port.postMessage({ type: "done", chars: 0 });
    } catch (e) {
      if (!aborted) port.postMessage({ type: "error", message: e.message });
    }
  });
});
