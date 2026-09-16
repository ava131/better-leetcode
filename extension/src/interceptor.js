/**
 * MAIN world 拦截器（document_start 注入）
 *
 * 职责：
 *  1. 被动捕获 submit 响应 → submission_id
 *  2. 主动发 1 次 GraphQL 拉提交详情（含失败用例）
 *  3. 读题干（来自 __NEXT_DATA__ / 描述 DOM —— 力扣不通过 GraphQL 请求题面！）
 *  4. 读 Monaco 编辑器内容与语言（ISOLATED world 拿不到 window.monaco）
 *
 * 铁律：**只观察，不改写**。任何异常都必须吞掉，绝不能弄坏 LeetCode 本身。
 *
 * 实测依据见 docs/R0-captured-api.md 与 docs/TECH-DESIGN.md §7
 */

(function () {
  "use strict";

  const TAG = "__better_leetcode__";
  const NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);
  window.__BL_NONCE__ = NONCE;

  // ★ 关键：MAIN world 与 ISOLATED world 的 **JS 全局作用域是隔离的**。
  //   content script 读不到 window.__BL_NONCE__（会拿到 undefined），
  //   于是它的 nonce 校验会把所有消息全部丢掉 —— 表现就是"插件完全没反应"。
  //   DOM 是两个 world 共享的，所以用 DOM 属性把 nonce 传过去。
  try {
    document.documentElement.setAttribute("data-bl-nonce", NONCE);
  } catch {}

  function post(type, payload) {
    try {
      // 每次都顺手把 nonce 写进 DOM —— document_start 时 documentElement 可能
      // 还不存在，所以不能只在最开头设一次。
      document.documentElement.setAttribute("data-bl-nonce", NONCE);
    } catch {}
    try {
      window.postMessage({ __bl: TAG, nonce: NONCE, type, payload }, window.location.origin);
    } catch {}
  }

  // ───────────────────────── 语言映射 ─────────────────────────

  // Monaco languageId → 力扣显示名
  const LANG_MAP = {
    cpp: "C++", c: "C", csharp: "C#", java: "Java",
    python: "Python", python3: "Python3",
    javascript: "JavaScript", typescript: "TypeScript",
    golang: "Go", go: "Go", rust: "Rust", kotlin: "Kotlin", swift: "Swift",
    php: "PHP", ruby: "Ruby", scala: "Scala", dart: "Dart",
    elixir: "Elixir", erlang: "Erlang", racket: "Racket", mysql: "MySQL",
    mssql: "MS SQL Server", postgresql: "PostgreSQL", bash: "Bash",
  };

  // ───────────────────────── 编辑器内容 ─────────────────────────
  //
  // 实测坑：monaco.editor.getModels() 会同时返回多个语言的模板，
  // 「取最长的」会拿到别的语言的默认模板（实测拿到过 C++ 模板）。
  // 必须用**当前活动编辑器**的 model。

  function activeModel() {
    const m = window.monaco;
    if (!m || !m.editor) return null;
    try {
      const editors = m.editor.getEditors ? m.editor.getEditors() : [];
      for (const ed of editors) {
        try {
          const model = ed.getModel && ed.getModel();
          if (model) return model;
        } catch {}
      }
    } catch {}

    // 降级：取有焦点的编辑器 / 第一个非空 model
    try {
      const models = m.editor.getModels ? m.editor.getModels() : [];
      let best = null;
      let bestLen = 0;
      for (const model of models) {
        try {
          const v = model.getValue();
          if (v && v.trim().length > bestLen) {
            best = model;
            bestLen = v.trim().length;
          }
        } catch {}
      }
      return best;
    } catch {}
    return null;
  }

  function readEditor() {
    try {
      const model = activeModel();
      if (model) {
        const code = model.getValue();
        let langId = "";
        try {
          langId = model.getLanguageId ? model.getLanguageId() : model.getModeId ? model.getModeId() : "";
        } catch {}
        return { code, langId, lang: LANG_MAP[langId] || langId || null, source: "monaco" };
      }
    } catch {}

    // 降级：Monaco 的隐藏 textarea（会丢换行，但好过没有）
    try {
      const ta = document.querySelector("textarea.inputarea, textarea[aria-label]");
      if (ta && typeof ta.value === "string" && ta.value.trim()) {
        return { code: ta.value, langId: "", lang: null, source: "textarea" };
      }
    } catch {}

    return { code: null, langId: "", lang: null, source: null };
  }

  // ───────────────────────── 题干 ─────────────────────────
  //
  // 实测坑：力扣的题面是**服务端渲染**进 __NEXT_DATA__ 与 DOM 的，
  // 题目页**不会**发 questionDetail 的 GraphQL 请求。
  // 所以必须主动读，不能靠监听。

  const DESC_SELECTORS = [
    '[data-track-load="description_content"]',
    'div[class*="question-content"]',
    'div[class*="description__"]',
    '[data-cy="question-content"]',
  ];

  function readDescHtml() {
    for (const sel of DESC_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerHTML && el.innerHTML.trim().length > 40) return el.innerHTML;
      } catch {}
    }
    return null;
  }

  /** 从 __NEXT_DATA__ 里挖 question 对象（含 translatedContent / tags / difficulty） */
  function readNextDataQuestion() {
    try {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el || !el.textContent) return null;
      const root = JSON.parse(el.textContent);
      let found = null;
      const seen = new Set();
      (function walk(o) {
        if (found || !o || typeof o !== "object" || seen.has(o)) return;
        seen.add(o);
        // 同时有 titleSlug 和 content 的对象就是 question
        if (typeof o.titleSlug === "string" && (typeof o.content === "string" || typeof o.translatedContent === "string")) {
          found = o;
          return;
        }
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (v && typeof v === "object") walk(v);
        }
      })(root);
      return found;
    } catch {
      return null;
    }
  }

  function slugFromUrl() {
    const m = location.pathname.match(/\/problems\/([^/]+)/);
    return m ? m[1] : null;
  }

  function readProblem() {
    const nd = readNextDataQuestion();
    const slug = slugFromUrl();
    const descHtml = readDescHtml();

    if (nd) {
      // 只取当前题（__NEXT_DATA__ 里可能缓存了别的题）
      if (nd.titleSlug && slug && nd.titleSlug !== slug) {
        // 不匹配就不信任元数据，只用 DOM
      } else {
        return {
          id: nd.questionId ? Number(nd.questionId) : null,
          slug: nd.titleSlug || slug,
          title: nd.translatedTitle || nd.questionTitle || nd.title || document.title,
          difficulty: nd.difficulty || null,
          tags: Array.isArray(nd.topicTags)
            ? nd.topicTags.map((t) => t.translatedName || t.name).filter(Boolean)
            : [],
          content: nd.translatedContent || nd.content || descHtml || "",
          source: "next_data",
        };
      }
    }

    if (!descHtml) return null;

    // 只有 DOM：尽力从页面里抠标题
    let title = document.title.replace(/\s*-\s*力扣.*$/, "").trim();
    try {
      const h = document.querySelector('div[class*="title"] , h1, [data-cy="question-title"]');
      if (h && h.textContent.trim()) title = h.textContent.trim();
    } catch {}

    return { id: null, slug, title, difficulty: null, tags: [], content: descHtml, source: "dom" };
  }

  // ───────────────────────── GraphQL：提交详情 ─────────────────────────

  const Q_SUBMISSION_DETAIL = `query submissionDetails($submissionId: ID!) {
  submissionDetail(submissionId: $submissionId) {
    code
    statusDisplay
    lang
    langVerboseName
    question { questionId titleSlug }
    passedTestCaseCnt
    totalTestCaseCnt
    stdOutput
    ... on GeneralSubmissionNode {
      outputDetail { codeOutput expectedOutput input compileError runtimeError lastTestcase }
    }
    ... on ContestSubmissionNode {
      outputDetail { codeOutput expectedOutput input compileError runtimeError lastTestcase }
    }
  }
}`;

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function extractSubmission(detail, submissionId) {
    if (!detail) return null;
    const od = detail.outputDetail || {};
    const hasCase =
      od.input != null && (od.codeOutput != null || od.expectedOutput != null || od.lastTestcase != null);

    return {
      submissionId: submissionId ?? null,
      verdict: detail.statusDisplay || null,
      passed: detail.passedTestCaseCnt ?? null,
      total: detail.totalTestCaseCnt ?? null,
      code: detail.code || null,
      lang: detail.langVerboseName || LANG_MAP[detail.lang] || detail.lang || null,
      langId: detail.lang || null,
      questionId: detail.question?.questionId ? Number(detail.question.questionId) : null,
      slug: detail.question?.titleSlug || null,
      runtimeError: od.runtimeError || od.compileError || null,
      testcase: hasCase
        ? {
            input: od.input || od.lastTestcase || "",
            output: od.codeOutput ?? "",
            expected: od.expectedOutput ?? "",
          }
        : null,
    };
  }

  async function fetchSubmissionDetail(submissionId) {
    try {
      const res = await window.__bl_origFetch("/graphql/", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrftoken": csrfToken() },
        body: JSON.stringify({
          query: Q_SUBMISSION_DETAIL,
          variables: { submissionId: String(submissionId) },
          operationName: "submissionDetails",
        }),
      });
      const j = await res.json();
      if (j && j.errors) {
        post("error", { where: "submissionDetail", detail: j.errors });
        return null;
      }
      return extractSubmission(j && j.data && j.data.submissionDetail, submissionId);
    } catch (e) {
      post("error", { where: "submissionDetail", detail: String(e) });
      return null;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 页面自己的判题轮询信号。
   *
   * 用户点提交时，力扣自己会轮询 `GET /submissions/detail/{id}/check/`。
   * 那个响应里就有判定结果 —— 复用它可以**零额外请求**地知道"判完了"。
   * 只当作加速信号：即使误判，代价也只是多查一次（下面还会校验 verdict 非空）。
   */
  const checkDone = new Set();

  function onCheckResponse(url, json) {
    try {
      const m = String(url).match(/\/submissions\/detail\/(\d+)\/check/);
      if (!m || !json) return;
      const done =
        json.state === "SUCCESS" ||
        (json.status_code != null && Number(json.status_code) !== 0) ||
        (typeof json.status_msg === "string" && json.status_msg && json.status_msg !== "Pending");
      if (done) checkDone.add(m[1]);
    } catch {}
  }

  /**
   * ★ 判题是**异步**的。submit 立刻返回 submission_id，但那一刻
   * statusDisplay 是**空字符串**（实测 +0ms 拿到 ""，+2000ms 才有 "Wrong Answer"）。
   * 所以必须轮询到判完为止，否则状态条永远不变。
   */
  async function waitForSubmissionResult(submissionId, timeoutMs = 90000) {
    const key = String(submissionId);
    const t0 = Date.now();
    let delay = 700;
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      // 页面已经告诉我们判完了 → 立刻查，不等退避
      if (checkDone.has(key)) {
        checkDone.delete(key);
        delay = 0;
      }
      const s = await fetchSubmissionDetail(submissionId);
      if (s) {
        last = s;
        if (s.verdict) return s; // verdict 非空 = 判完了
      }
      await sleep(delay);
      delay = delay === 0 ? 700 : Math.min(Math.round(delay * 1.35), 2500);
    }
    post("error", { where: "submissionDetail", detail: `等待判题超时（${timeoutMs}ms）` });
    return last;
  }

  // ───────────────────────── 包装 fetch ─────────────────────────

  const origFetch = window.fetch;
  window.__bl_origFetch = origFetch; // 我们自己的请求走原始 fetch，避免自触发

  function onSubmitResponse(json) {
    try {
      const id = json && (json.submission_id || json.submissionId);
      if (!id) return;
      post("submitted", { submissionId: id });
      // 先告诉 UI「判题中…」，判完再给结果 —— 否则中间这段时间界面是死的
      post("judging", { submissionId: id });
      waitForSubmissionResult(id).then((s) => {
        if (s && s.verdict) post("submission", s);
        else post("judge_failed", { submissionId: id });
      });
    } catch {}
  }

  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      const p = origFetch.apply(this, arguments);
      try {
        p.then((res) => {
          try {
            const ct = res.headers.get("content-type") || "";
            if (!ct.includes("json")) return;
            if (/\/submit\/?/.test(url)) {
              res.clone().json().then(onSubmitResponse).catch(() => {});
            } else if (/\/check\/?/.test(url)) {
              res.clone().json().then((j) => onCheckResponse(url, j)).catch(() => {});
            }
          } catch {}
        }).catch(() => {});
      } catch {}
      return p;
    };
  }

  // ───────────────────────── 包装 XHR ─────────────────────────
  //
  // 实测：力扣的 GraphQL 与提交都走 XHR，不是 fetch。

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR && OrigXHR.prototype) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function (method, url) {
      try {
        this.__bl_url = String(url);
        this.__bl_method = String(method || "").toUpperCase();
      } catch {}
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function () {
      try {
        this.addEventListener("load", () => {
          try {
            const url = this.__bl_url || "";
            const isSubmit = /\/submit\/?/.test(url);
            const isCheck = /\/check\/?/.test(url);
            if (!isSubmit && !isCheck) return;
            let j = null;
            try {
              j = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            } catch {}
            if (isSubmit) onSubmitResponse(j);
            else onCheckResponse(url, j);
          } catch {}
        });
      } catch {}
      return origSend.apply(this, arguments);
    };
  }

  // ───────────────────────── 响应 ISOLATED 的请求 ─────────────────────────

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.__bl !== TAG) return;

    // 握手：content script 在 ISOLATED world，读不到 window 上的变量，
    // 也听不到我们 document_start 时发的那条 ready。所以它主动 ping，
    // 我们回一条带 nonce 的 ready 让它把 nonce 学下来。
    // **只有这一种消息免校验** —— 它除了触发一条回包之外没有任何副作用。
    if (d.type === "hello") {
      post("ready", { url: location.href });
      return;
    }

    if (d.nonce !== NONCE) return;

    switch (d.type) {
      case "read_code": {
        const r = readEditor();
        post("code", r);
        break;
      }
      case "read_problem": {
        const p = readProblem();
        if (p) post("problem", p);
        break;
      }
      case "refetch_submission": {
        const id = d.payload && d.payload.submissionId;
        if (id) fetchSubmissionDetail(id).then((s) => s && post("submission", s));
        break;
      }
    }
  });

  // 首次尝试读题面（DOM 可能还没就绪，失败也无所谓 —— ISOLATED 会重试）
  post("ready", { url: location.href });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      const p = readProblem();
      if (p) post("problem", p);
    });
  } else {
    const p = readProblem();
    if (p) post("problem", p);
  }
})();
