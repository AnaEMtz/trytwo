(function () {
  "use strict";

  var script = document.currentScript;
  var ENDPOINT = (script && script.getAttribute("data-endpoint")) || "/api/chat";

  var SUGGESTIONS = [
    "How much crypto did DPRK hackers steal?",
    "What did the Libya Panel find about diesel smuggling?",
    "How were weapons hidden in shipments to Yemen?",
    "What is the MSMT?",
  ];

  var localIndex = null;
  var lastQuestion = "";
  var busy = false;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- DOM ----------
  var launcher = el("button", "ch-launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open the Panel of Experts assistant");
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg>';

  var panel = el("section", "ch-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Panel of Experts assistant");
  panel.hidden = true;

  var head = el("div", "ch-head");
  var titleWrap = el("div");
  titleWrap.appendChild(el("div", "ch-title", "Panel of Experts assistant"));
  var badge = el("div", "ch-badge", "Answers only from the database · no web access");
  titleWrap.appendChild(badge);
  var closeBtn = el("button", "ch-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close chat");
  head.appendChild(titleWrap);
  head.appendChild(closeBtn);

  var log = el("div", "ch-log");
  log.setAttribute("aria-live", "polite");

  var chips = el("div", "ch-chips");
  var form = el("form", "ch-form");
  var input = el("input", "ch-input");
  input.type = "text";
  input.maxLength = 500;
  input.placeholder = "Ask about the reports…";
  input.setAttribute("aria-label", "Your question");
  var send = el("button", "ch-send", "Ask");
  send.type = "submit";
  form.appendChild(input);
  form.appendChild(send);

  var foot = el("div", "ch-foot", "Educational demo. Figures are summaries — verify against the linked reports.");

  panel.appendChild(head);
  panel.appendChild(log);
  panel.appendChild(chips);
  panel.appendChild(form);
  panel.appendChild(foot);
  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  // ---------- rendering ----------
  function addMessage(who, text) {
    var m = el("div", "ch-msg ch-" + who);
    if (who === "user") m.textContent = text;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  function renderAnswer(container, data) {
    var lines = String(data.answer || "").split(/\n+/);
    var list = null;
    lines.forEach(function (line) {
      var isBullet = /^\s*[-•]\s+/.test(line);
      var t = line.replace(/^\s*[-•]\s+/, "");
      var node;
      if (isBullet) {
        if (!list) { list = el("ul", "ch-list"); container.appendChild(list); }
        node = el("li");
        list.appendChild(node);
      } else {
        list = null;
        node = el("p");
        container.appendChild(node);
      }
      t.split(/(\[\d+\])/).forEach(function (part) {
        var m = part.match(/^\[(\d+)\]$/);
        if (m) {
          var c = el("a", "ch-cite", m[1]);
          c.href = "#ch-src-" + m[1];
          c.addEventListener("click", function (ev) {
            ev.preventDefault();
            var target = container.querySelector("[data-n='" + m[1] + "']");
            if (target) { target.classList.add("ch-flash"); setTimeout(function () { target.classList.remove("ch-flash"); }, 1200); }
          });
          node.appendChild(c);
        } else if (part) {
          node.appendChild(document.createTextNode(part));
        }
      });
    });

    if (data.sources && data.sources.length) {
      var box = el("div", "ch-sources");
      box.appendChild(el("div", "ch-sources-title", "Sources"));
      data.sources.forEach(function (s) {
        var row = el("div", "ch-source");
        row.setAttribute("data-n", s.n);
        row.appendChild(el("span", "ch-num", String(s.n)));
        var body = el("div");
        var label = [s.symbol, s.date].filter(Boolean).join(" · ");
        var a = el("a", "ch-link", s.title);
        if (/^https?:\/\//.test(s.url)) { a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
        else if (s.url) { a.href = s.url; }
        body.appendChild(a);
        body.appendChild(el("div", "ch-meta", (label ? label + " — " : "") + s.section));
        if (s.note) body.appendChild(el("div", "ch-note", s.note));
        row.appendChild(body);
        box.appendChild(row);
      });
      container.appendChild(box);
    }
    if (data.mode) setBadge(data.mode);
  }

  function setBadge(mode) {
    var label = {
      claude: "Claude writes answers from the database only",
      ollama: "Local model writes answers from the database only",
      none: "Answers quote the database only",
      "retrieval-only": "Answers quote the database only",
      offline: "Offline demo · in-browser search of the database only",
    }[mode] || mode;
    badge.textContent = label + " · no web access";
  }

  // ---------- answering ----------
  function localAnswer(q) {
    if (!window.RAG || !window.UNSE_KB) {
      return { answer: "The chat server isn't reachable and the offline database didn't load.", sources: [], mode: "offline" };
    }
    if (!localIndex) localIndex = window.RAG.createIndex(window.UNSE_KB);
    var out = window.RAG.respondExtractive(localIndex, q, lastQuestion);
    out.mode = "offline";
    return out;
  }

  function ask(q) {
    if (busy || !q) return;
    busy = true;
    send.disabled = true;
    chips.hidden = true;
    addMessage("user", q);
    var pending = addMessage("bot", "");
    pending.classList.add("ch-typing");
    pending.textContent = "Searching the database…";

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 45000);

    // Opened straight from disk (file://) there is no server to call: use the in-browser database.
    var request = location.protocol === "file:"
      ? Promise.reject(new Error("no server"))
      : fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, previous: lastQuestion }),
          signal: ctrl.signal,
        });
    request
      .then(function (r) {
        if (r.status === 429) return r.json().then(function (j) { return { answer: j.error, sources: [] }; });
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .catch(function () { return localAnswer(q); })
      .then(function (data) {
        clearTimeout(timer);
        pending.classList.remove("ch-typing");
        pending.textContent = "";
        renderAnswer(pending, data);
        lastQuestion = q;
      })
      .then(function () {
        busy = false;
        send.disabled = false;
        log.scrollTop = log.scrollHeight;
        input.focus();
      });
  }

  // ---------- events ----------
  function open() {
    panel.hidden = false;
    launcher.classList.add("ch-hidden");
    if (!log.children.length) {
      var hi = addMessage("bot", "");
      hi.appendChild(el("p", null, "Hi! I answer questions using a small database built from UN Panel of Experts reports (DPRK, Libya, Yemen) and the Multilateral Sanctions Monitoring Team. I don't use the internet, and if the database doesn't cover something I'll say so."));
      SUGGESTIONS.forEach(function (s) {
        var b = el("button", "ch-chip", s);
        b.type = "button";
        b.addEventListener("click", function () { ask(s); });
        chips.appendChild(b);
      });
    }
    setTimeout(function () { input.focus(); }, 50);
  }
  function close() {
    panel.hidden = true;
    launcher.classList.remove("ch-hidden");
    launcher.focus();
  }

  launcher.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) close(); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value.trim();
    input.value = "";
    ask(q);
  });
})();
