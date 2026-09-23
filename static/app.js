"use strict";

(function () {
  const $ = (selector) => document.querySelector(selector);

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } },
  };

  const TITLES = {
    notes: "📝 Your notes", summary: "📋 Summary", explain: "💡 Explanation",
    quiz: "❓ Quiz", flashcards: "🃏 Flashcards", chat: "💬 Ask a tutor",
  };
  // How a finished text answer is described when it's turned into a follow-up chat.
  const MODE_REQUESTS = {
    notes: "Please make study notes from my material.",
    summary: "Please summarise my material.",
    explain: "Please explain this to me.",
  };
  const MAX_CHAT = 40;

  const DEFAULT_CONFIG = {
    demo: false, needsCode: false, defaultLevel: "middle", maxFiles: 10, maxMegabytes: 20,
    accept: [".csv", ".docx", ".gif", ".jpeg", ".jpg", ".md", ".pdf", ".png", ".pptx", ".txt", ".webp"],
    levels: [
      { id: "year6", label: "Year 6" }, { id: "middle", label: "Years 7-9" },
      { id: "senior", label: "Years 10-12" }, { id: "uni", label: "University" },
    ],
  };

  const state = {
    config: DEFAULT_CONFIG,
    level: store.get("sb-level"),
    code: store.get("sb-code") || "",
    files: [],
    busy: false,
    controller: null,
    mode: null,
    lastText: "",
    lastData: null,
    chat: [],
    chatSeeded: false,
  };

  const els = {
    levels: $("#level-buttons"), demo: $("#demo-banner"), dropzone: $("#dropzone"),
    fileInput: $("#file-input"), photoInput: $("#photo-input"), fileList: $("#file-list"),
    fileError: $("#file-error"), topic: $("#topic"), tools: $("#tools"), count: $("#count"),
    output: $("#output"), title: $("#output-title"), status: $("#status"), error: $("#error"),
    result: $("#result"), chat: $("#chat"), chatLog: $("#chat-log"), chatForm: $("#chat-form"),
    chatInput: $("#chat-input"), chatHint: $("#chat-files-hint"), nextSteps: $("#next-steps"),
    stop: $("#stop-btn"), copy: $("#copy-btn"), download: $("#download-btn"), print: $("#print-btn"),
    newChat: $("#newchat-btn"), codeDialog: $("#code-dialog"), codeInput: $("#code-input"), codeError: $("#code-error"),
  };

  class FriendlyError extends Error {}

  // ---------------------------------------------------------------------------
  // Markdown + maths rendering

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let purifyReady = false;
  function libsReady() {
    if (!window.marked || !window.DOMPurify) return false;
    if (!purifyReady) {
      window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
      });
      purifyReady = true;
    }
    return true;
  }

  const MATH_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)/g;

  function renderMarkdown(src, inline) {
    if (!libsReady()) {
      return inline ? escapeHtml(src) : escapeHtml(src).replace(/\n/g, "<br>");
    }
    const maths = [];
    const protectedSrc = src.replace(MATH_RE, (match, code, d1, d2, i1) => {
      if (code) return match;
      const display = d1 !== undefined || d2 !== undefined;
      maths.push({ tex: display ? (d1 !== undefined ? d1 : d2) : i1, display });
      return "KXMATH" + (maths.length - 1) + "XK";
    });
    const raw = inline ? window.marked.parseInline(protectedSrc) : window.marked.parse(protectedSrc);
    const safe = window.DOMPurify.sanitize(raw);
    return safe.replace(/KXMATH(\d+)XK/g, (_, i) => {
      const m = maths[Number(i)];
      if (!m) return "";
      if (!window.katex) return escapeHtml(m.display ? "\\[" + m.tex + "\\]" : "\\(" + m.tex + "\\)");
      try {
        return window.katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false });
      } catch (e) {
        return escapeHtml(m.tex);
      }
    });
  }

  // Re-rendering on every streamed chunk is wasteful; do it at most once per frame.
  function throttledRenderer(target) {
    let pending = null;
    return (text) => {
      const first = pending === null;
      pending = text;
      if (first) {
        requestAnimationFrame(() => { target.innerHTML = renderMarkdown(pending); pending = null; });
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Levels

  function renderLevels() {
    const levels = state.config.levels;
    if (!levels.some((l) => l.id === state.level)) state.level = state.config.defaultLevel;
    els.levels.innerHTML = "";
    levels.forEach((level) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "level-btn";
      btn.textContent = level.label;
      btn.setAttribute("aria-pressed", String(level.id === state.level));
      btn.addEventListener("click", () => {
        state.level = level.id;
        store.set("sb-level", level.id);
        els.levels.querySelectorAll(".level-btn").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      });
      els.levels.appendChild(btn);
    });
  }

  // ---------------------------------------------------------------------------
  // Files

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function extensionOf(name) {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
  }

  function showFileError(message) {
    els.fileError.textContent = message;
    els.fileError.hidden = !message;
  }

  function addFiles(fileList) {
    const accept = new Set(state.config.accept);
    const maxBytes = state.config.maxMegabytes * 1024 * 1024;
    const problems = [];
    Array.from(fileList).forEach((file) => {
      const ext = extensionOf(file.name);
      if (!accept.has(ext)) {
        const hint = ext === ".heic" || ext === ".heif" ? " Please use a JPG or PNG photo." :
          (ext === ".doc" || ext === ".ppt" || ext === ".pages" || ext === ".key") ? " Please save it as a PDF first." :
          " Try a PDF, Word, PowerPoint, text file or photo.";
        problems.push("StudyBuddy can't open “" + file.name + "”." + hint);
        return;
      }
      if (state.files.some((f) => f.name === file.name && f.size === file.size)) return;
      if (state.files.length >= state.config.maxFiles) {
        problems.push("You can add up to " + state.config.maxFiles + " files.");
        return;
      }
      const total = state.files.reduce((sum, f) => sum + f.size, 0);
      if (total + file.size > maxBytes) {
        problems.push("“" + file.name + "” is too big – all your files together need to be under " + state.config.maxMegabytes + " MB.");
        return;
      }
      state.files.push(file);
    });
    showFileError(Array.from(new Set(problems)).join(" "));
    renderFiles();
  }

  function renderFiles() {
    els.fileList.innerHTML = "";
    state.files.forEach((file, index) => {
      const li = document.createElement("li");
      li.className = "file-chip";
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = /\.(png|jpe?g|gif|webp)$/i.test(file.name) ? "🖼️" : "📄";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = file.name;
      name.title = file.name;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = formatSize(file.size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", "Remove " + file.name);
      remove.addEventListener("click", () => {
        state.files.splice(index, 1);
        showFileError("");
        renderFiles();
        els.topic.focus();
      });
      li.append(icon, name, size, remove);
      els.fileList.appendChild(li);
    });
    updateChatHint();
  }

  // ---------------------------------------------------------------------------
  // Talking to the server

  function baseForm(mode) {
    const form = new FormData();
    form.append("mode", mode);
    form.append("level", state.level);
    state.files.forEach((file) => form.append("files", file, file.name));
    return form;
  }

  function askForCode(wasWrong) {
    return new Promise((resolve) => {
      els.codeError.hidden = !wasWrong;
      els.codeInput.value = "";
      const onClose = () => {
        els.codeDialog.removeEventListener("close", onClose);
        const code = els.codeInput.value.trim();
        if (els.codeDialog.returnValue === "ok" && code) {
          state.code = code;
          store.set("sb-code", code);
          resolve(true);
        } else {
          resolve(false);
        }
      };
      els.codeDialog.returnValue = "";
      els.codeDialog.addEventListener("close", onClose);
      els.codeDialog.showModal();
      els.codeInput.focus();
    });
  }

  async function apiFetch(url, form, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetch(url, { method: "POST", body: form, signal, headers: state.code ? { "X-Access-Code": state.code } : {} });
      } catch (err) {
        if (err.name === "AbortError") throw err;
        throw new FriendlyError("Can't connect to StudyBuddy. Check your internet and try again.");
      }
      if (response.ok) return response;

      let body = {};
      try { body = await response.json(); } catch (e) { /* not JSON */ }
      if (response.status === 401 && body.needs_code) {
        const hadCode = Boolean(state.code);
        if (await askForCode(hadCode)) continue;
        throw new FriendlyError("You need a class code to use StudyBuddy.");
      }
      if (body.error) throw new FriendlyError(body.error);
      if (response.status === 413) throw new FriendlyError("Your files are too big. Try fewer or smaller files.");
      throw new FriendlyError("Something went wrong (error " + response.status + "). Please try again.");
    }
    throw new FriendlyError("You need a class code to use StudyBuddy.");
  }

  // Streams newline-delimited JSON events from /api/generate, calling onText with the full text so far.
  async function streamText(form, onText, signal) {
    const response = await apiFetch("/api/generate", form, signal);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "", done = false;

    const handle = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch (e) { return; }
      if (event.type === "delta") { full += event.text; onText(full); }
      else if (event.type === "error") { const err = new FriendlyError(event.message); err.partial = full; throw err; }
      else if (event.type === "done") { done = true; }
    };

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    handle(buffer + decoder.decode());
    if (!done) {
      const err = new FriendlyError("The answer got cut off. Please try again.");
      err.partial = full;
      throw err;
    }
    return full;
  }

  // ---------------------------------------------------------------------------
  // Output area

  function setStatus(message, thinking) {
    els.status.innerHTML = "";
    if (!message) return;
    const span = document.createElement("span");
    span.textContent = message;
    if (thinking) span.className = "dots";
    els.status.appendChild(span);
  }

  function showError(message) {
    els.error.textContent = message || "";
    els.error.hidden = !message;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.tools.querySelectorAll(".tool").forEach((b) => { b.disabled = busy; });
    els.nextSteps.querySelectorAll("button").forEach((b) => { b.disabled = busy; });
    els.chatForm.querySelector("button").disabled = busy;
    els.stop.hidden = !busy;
    [els.copy, els.download, els.print].forEach((b) => { b.disabled = busy; });
    els.output.setAttribute("aria-busy", String(busy));
    if (!busy) state.controller = null;
  }

  function newController() {
    state.controller = new AbortController();
    return state.controller.signal;
  }

  function openOutput(mode) {
    state.mode = mode;
    state.lastText = "";
    state.lastData = null;
    els.output.hidden = false;
    els.title.textContent = TITLES[mode];
    els.result.innerHTML = "";
    els.result.hidden = mode === "chat";
    els.chat.hidden = mode !== "chat";
    els.newChat.hidden = mode !== "chat";
    els.nextSteps.hidden = true;
    showError("");
    setStatus("");
    els.tools.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    els.output.scrollIntoView({ behavior: "smooth", block: "start" });
    els.title.focus({ preventScroll: true });
  }

  function hasInput() {
    return state.files.length > 0 || els.topic.value.trim().length > 0;
  }

  function run(mode) {
    if (state.busy) return;
    if (mode !== "chat" && !hasInput()) {
      showFileError("Add a file or type a topic first 👆");
      els.topic.focus();
      return;
    }
    showFileError("");
    openOutput(mode);
    if (mode === "chat") startChat(null);
    else if (mode === "quiz" || mode === "flashcards") runPractice(mode);
    else runText(mode);
  }

  async function runText(mode) {
    const form = baseForm(mode);
    form.append("text", els.topic.value.trim());
    setBusy(true);
    setStatus(state.files.length ? "StudyBuddy is reading your files" : "StudyBuddy is thinking", true);
    const render = throttledRenderer(els.result);
    let text = "";
    try {
      text = await streamText(form, (full) => {
        if (!text) setStatus("StudyBuddy is writing", true);
        text = full;
        render(full);
      }, newController());
      els.result.innerHTML = renderMarkdown(text);
      state.lastText = text;
      setStatus("Done ✅");
      els.nextSteps.hidden = false;
    } catch (err) {
      if (err.name === "AbortError") {
        setStatus("Stopped.");
        state.lastText = text;
        if (text) els.nextSteps.hidden = false;
      } else {
        setStatus("");
        showError(err.message || "Something went wrong. Please try again.");
        state.lastText = err.partial || text;
      }
      if (state.lastText) els.result.innerHTML = renderMarkdown(state.lastText);
    } finally {
      setBusy(false);
    }
  }

  async function runPractice(mode) {
    const form = baseForm(mode);
    form.append("text", els.topic.value.trim());
    form.append("count", els.count.value);
    setBusy(true);
    setStatus(mode === "quiz" ? "Writing your quiz – this can take a minute" : "Making your flashcards – this can take a minute", true);
    try {
      const response = await apiFetch("/api/practice", form, newController());
      let data;
      try { data = await response.json(); } catch (e) { throw new FriendlyError("Something went wrong. Please try again."); }
      state.lastData = data;
      setStatus("");
      if (mode === "quiz") renderQuiz(data); else renderCards(data);
    } catch (err) {
      if (err.name === "AbortError") setStatus("Stopped.");
      else { setStatus(""); showError(err.message || "Something went wrong. Please try again."); }
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Quiz

  function renderQuiz(data) {
    els.title.textContent = "❓ " + data.title;
    els.result.innerHTML = "";
    const total = data.questions.length;
    let answered = 0, score = 0;

    const progress = () => setStatus(answered < total ? "Answered " + answered + " of " + total + " · Score: " + score : "");

    data.questions.forEach((q, qi) => {
      const box = document.createElement("div");
      box.className = "quiz-q";
      const heading = document.createElement("h3");
      heading.innerHTML = '<span class="quiz-num">' + (qi + 1) + ".</span> " + renderMarkdown(q.question, true);
      const choices = document.createElement("div");
      choices.className = "choices";
      choices.setAttribute("role", "group");
      choices.setAttribute("aria-label", "Answers for question " + (qi + 1));
      const feedback = document.createElement("div");
      feedback.setAttribute("aria-live", "polite");

      q.choices.forEach((choice, ci) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "choice";
        btn.innerHTML = '<span class="letter">' + "ABCDEFGH"[ci] + "</span><span>" + renderMarkdown(choice, true) + "</span>";
        btn.addEventListener("click", () => {
          const correct = ci === q.answer_index;
          answered += 1;
          if (correct) score += 1;
          choices.querySelectorAll("button").forEach((b, bi) => {
            b.disabled = true;
            if (bi === q.answer_index) b.classList.add("correct");
          });
          if (!correct) btn.classList.add("wrong");
          feedback.className = "feedback " + (correct ? "good" : "bad");
          feedback.innerHTML = "<strong>" + (correct ? "✅ Correct!" : "❌ Not quite – the answer is " + "ABCDEFGH"[q.answer_index] + ".") + "</strong>" +
            (q.explanation ? renderMarkdown(q.explanation) : "");
          progress();
          if (answered === total) showScore(score, total);
        });
        choices.appendChild(btn);
      });

      box.append(heading, choices, feedback);
      els.result.appendChild(box);
    });

    const scoreBox = document.createElement("div");
    scoreBox.id = "quiz-score";
    scoreBox.className = "score";
    scoreBox.hidden = true;
    els.result.appendChild(scoreBox);
    progress();
  }

  function showScore(score, total) {
    const box = $("#quiz-score");
    const ratio = score / total;
    const message = ratio === 1 ? "Perfect score! 🏆" : ratio >= 0.8 ? "Brilliant work! 🌟" : ratio >= 0.5 ? "Good effort! Keep practising 💪" : "Keep going – every try helps you learn! 🌱";
    box.innerHTML = "";
    const big = document.createElement("div");
    big.className = "big";
    big.textContent = score + " / " + total;
    const text = document.createElement("p");
    text.textContent = message;
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn btn-soft";
    again.textContent = "🔁 Try this quiz again";
    again.addEventListener("click", () => { renderQuiz(state.lastData); els.result.scrollIntoView({ behavior: "smooth" }); });
    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.className = "btn btn-primary";
    fresh.textContent = "✨ New questions";
    fresh.addEventListener("click", () => run("quiz"));
    const buttons = document.createElement("div");
    buttons.className = "drop-buttons";
    buttons.append(again, fresh);
    box.append(big, text, buttons);
    box.hidden = false;
    setStatus("Quiz finished: " + score + " out of " + total);
  }

  // ---------------------------------------------------------------------------
  // Flashcards

  function renderCards(data) {
    els.title.textContent = "🃏 " + data.title;
    els.result.innerHTML = "";
    let order = data.cards.map((_, i) => i);
    let index = 0;

    const wrap = document.createElement("div");
    wrap.className = "cards-wrap";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "flashcard";
    const inner = document.createElement("div");
    inner.className = "flashcard-inner";
    const front = document.createElement("div");
    front.className = "face face-front";
    const back = document.createElement("div");
    back.className = "face face-back";
    inner.append(front, back);
    card.appendChild(inner);

    const controls = document.createElement("div");
    controls.className = "card-controls";
    const makeButton = (label, aria, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-soft";
      b.textContent = label;
      if (aria) b.setAttribute("aria-label", aria);
      b.addEventListener("click", onClick);
      return b;
    };
    const count = document.createElement("span");
    count.className = "card-count";
    count.setAttribute("aria-live", "polite");

    const show = () => {
      const c = data.cards[order[index]];
      card.classList.remove("flipped");
      front.innerHTML = "<div>" + renderMarkdown(c.front, true) + '</div><div class="hint">Tap to flip</div>';
      back.innerHTML = "<div>" + renderMarkdown(c.back, true) + '</div><div class="hint">Tap to flip back</div>';
      front.setAttribute("aria-hidden", "false");
      back.setAttribute("aria-hidden", "true");
      count.textContent = (index + 1) + " / " + order.length;
    };
    const flip = () => {
      const flipped = card.classList.toggle("flipped");
      front.setAttribute("aria-hidden", String(flipped));
      back.setAttribute("aria-hidden", String(!flipped));
    };
    const move = (step) => { index = (index + step + order.length) % order.length; show(); };

    card.addEventListener("click", flip);
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { move(1); e.preventDefault(); }
      if (e.key === "ArrowLeft") { move(-1); e.preventDefault(); }
    });

    controls.append(
      makeButton("⬅️ Back", "Previous card", () => move(-1)),
      count,
      makeButton("Next ➡️", "Next card", () => move(1)),
      makeButton("🔀 Shuffle", "Shuffle cards", () => {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        index = 0;
        show();
      }),
    );
    wrap.append(card, controls);
    const tip = document.createElement("p");
    tip.className = "chat-hint";
    tip.textContent = "Tip: tap the card to flip it. On a keyboard, use Space to flip and the arrow keys to move.";
    wrap.appendChild(tip);
    els.result.appendChild(wrap);
    show();
  }

  // ---------------------------------------------------------------------------
  // Chat

  function updateChatHint() {
    const n = state.files.length;
    els.chatHint.textContent = n ? "StudyBuddy can see your " + n + " file" + (n > 1 ? "s" : "") + " above." : "Tip: add files above and StudyBuddy can read them too.";
  }

  function addBubble(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + role + (role === "assistant" ? " markdown" : "");
    if (role === "user") div.textContent = text;
    else div.innerHTML = renderMarkdown(text);
    els.chatLog.appendChild(div);
    return div;
  }

  function startChat(seed) {
    state.chat = seed || [];
    state.chatSeeded = Boolean(seed);
    els.chatLog.innerHTML = "";
    state.chat.forEach((m, i) => {
      // The seeded first message is our own wording; show the answer it produced.
      if (!(seed && i === 0)) addBubble(m.role, m.content);
    });
    updateChatHint();
    if (!seed && !els.chatInput.value.trim()) els.chatInput.value = els.topic.value.trim();
    els.chatInput.focus();
  }

  async function sendChat() {
    const text = els.chatInput.value.trim();
    if (!text || state.busy) return;
    if (state.chat.length >= MAX_CHAT - 1) {
      showError("This chat is getting very long. Press “New chat” to keep going.");
      return;
    }
    showError("");
    state.chat.push({ role: "user", content: text });
    els.chatInput.value = "";
    addBubble("user", text);
    const bubble = addBubble("assistant", "");
    const form = baseForm("chat");
    form.append("history", JSON.stringify(state.chat));
    setBusy(true);
    setStatus("StudyBuddy is thinking", true);
    const render = throttledRenderer(bubble);
    let reply = "";
    try {
      reply = await streamText(form, (full) => { reply = full; setStatus(""); render(full); }, newController());
      bubble.innerHTML = renderMarkdown(reply);
      state.chat.push({ role: "assistant", content: reply });
      setStatus("");
    } catch (err) {
      const partial = reply || err.partial || "";
      if (partial) {
        bubble.innerHTML = renderMarkdown(partial);
        state.chat.push({ role: "assistant", content: partial });
      } else {
        // Nothing came back: undo the question so it can be sent again.
        bubble.remove();
        els.chatLog.lastChild && els.chatLog.lastChild.remove();
        state.chat.pop();
        els.chatInput.value = text;
      }
      if (err.name === "AbortError") setStatus("Stopped.");
      else { setStatus(""); showError(err.message || "Something went wrong. Please try again."); }
    } finally {
      setBusy(false);
      els.chatInput.focus();
    }
  }

  function followUp() {
    if (!state.lastText) return run("chat");
    const topic = els.topic.value.trim();
    const request = (MODE_REQUESTS[state.mode] || "Please help me study my material.") + (topic ? "\n\n" + topic : "");
    const seed = [{ role: "user", content: request }, { role: "assistant", content: state.lastText }];
    openOutput("chat");
    startChat(seed);
  }

  // ---------------------------------------------------------------------------
  // Copy, save, print

  function exportText() {
    if (state.mode === "chat") {
      return state.chat.filter((m, i) => !(state.chatSeeded && i === 0))
        .map((m) => (m.role === "user" ? "You: " : "StudyBuddy: ") + m.content).join("\n\n");
    }
    const data = state.lastData;
    if (state.mode === "quiz" && data) {
      const questions = data.questions.map((q, i) => (i + 1) + ". " + q.question + "\n" + q.choices.map((c, ci) => "   " + "ABCDEFGH"[ci] + ") " + c).join("\n")).join("\n\n");
      const answers = data.questions.map((q, i) => (i + 1) + ". " + "ABCDEFGH"[q.answer_index] + " – " + q.explanation).join("\n");
      return data.title + "\n\n" + questions + "\n\nAnswers\n" + answers;
    }
    if (state.mode === "flashcards" && data) {
      return data.title + "\n\n" + data.cards.map((c) => "Q: " + c.front + "\nA: " + c.back).join("\n\n");
    }
    return state.lastText;
  }

  async function copyOutput() {
    const text = exportText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied ✅");
    } catch (e) {
      setStatus("Couldn't copy – try selecting the text instead.");
    }
  }

  function saveOutput() {
    const text = exportText();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "studybuddy-" + (state.mode || "notes") + ".txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------------------------------------------------------------------------
  // Wiring

  function wire() {
    $("#choose-files").addEventListener("click", () => els.fileInput.click());
    $("#take-photo").addEventListener("click", () => els.photoInput.click());
    [els.fileInput, els.photoInput].forEach((input) => input.addEventListener("change", () => {
      addFiles(input.files);
      input.value = "";
    }));

    ["dragenter", "dragover"].forEach((type) => els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((type) => els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      if (type === "dragleave" && els.dropzone.contains(e.relatedTarget)) return;
      els.dropzone.classList.remove("dragging");
    }));
    els.dropzone.addEventListener("drop", (e) => { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
    // Dropping a file anywhere else shouldn't navigate away from the page.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length && !els.dropzone.contains(e.target)) addFiles(e.dataTransfer.files);
    });
    // Pasting a screenshot adds it as a file.
    document.addEventListener("paste", (e) => {
      const data = e.clipboardData;
      const pasted = Array.from((data && data.files) || []);
      if (!pasted.length) return;
      // Text copied from Word can carry a picture of itself; keep normal text pastes working.
      if (data.getData("text/plain") && e.target.closest && e.target.closest("textarea, input")) return;
      e.preventDefault();
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
      addFiles(pasted.map((f, i) => (f.name && f.name !== "image.png") ? f : new File([f], "screenshot-" + stamp + (i ? "-" + i : "") + extensionOf(f.name || ".png"), { type: f.type })));
    });

    els.tools.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool");
      if (btn) run(btn.dataset.mode);
    });
    els.nextSteps.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.dataset.next === "followup") followUp();
      else run(btn.dataset.next);
    });

    els.chatForm.addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
    els.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
    });
    els.newChat.addEventListener("click", () => {
      if (state.busy) return;
      showError("");
      setStatus("");
      els.chatInput.value = "";
      startChat(null);
    });

    els.stop.addEventListener("click", () => { if (state.controller) state.controller.abort(); });
    els.copy.addEventListener("click", copyOutput);
    els.download.addEventListener("click", saveOutput);
    els.print.addEventListener("click", () => window.print());
  }

  async function loadConfig() {
    try {
      const response = await fetch("/api/config");
      if (response.ok) state.config = Object.assign({}, DEFAULT_CONFIG, await response.json());
    } catch (e) { /* use defaults; errors show when the student tries something */ }
    els.demo.hidden = !state.config.demo;
    $("#max-files").textContent = state.config.maxFiles;
    els.fileInput.setAttribute("accept", state.config.accept.join(","));
    renderLevels();
  }

  wire();
  renderLevels();
  loadConfig();
})();
