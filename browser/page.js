// Evaluated in an isolated world of each page the Browser pane's agent tools touch (tools.mjs
// calls these by name). Page scripts can't see or tamper with it. From Deft's page.js.

globalThis.__herdrBrowser = (() => {
  const S = (window.__herdrBrowserAgent ??= {}); // survives re-injection: refs and cursor state for this document

  // Refs live in a Map, not attributes: they reach into shadow roots and never touch the page's DOM.
  function getRef(ref) {
    const el = S.refs?.get(ref);
    return el?.isConnected ? el : null;
  }

  // The agent's visible pointer: glides to the target, outlines it, and pulses on click.
  // Built with CSSOM and the Web Animations API, not <style>, so page CSP can't block it.
  function agentCursor(el, kind) {
    const ACCENT = "#1348dc";
    const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
    if (!S.host?.isConnected) {
      const hostEl = document.createElement("div");
      hostEl.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      const root = hostEl.attachShadow({ mode: "closed" });
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;border:2px solid ${ACCENT};border-radius:4px;box-shadow:0 2px 8px ${ACCENT}33;opacity:0;` +
        `transition:opacity .25s,left .5s ${EASE},top .5s ${EASE},width .5s ${EASE},height .5s ${EASE};`;
      const ring = document.createElement("div");
      ring.style.cssText = `position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid ${ACCENT};opacity:0;`;
      const pointer = document.createElement("div");
      pointer.style.cssText = `position:absolute;left:0;top:0;opacity:0;transition:transform .5s ${EASE},opacity .3s;` +
        "filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));will-change:transform;";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "22");
      svg.setAttribute("height", "24");
      svg.setAttribute("viewBox", "0 0 22 24");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      for (const [k, v] of Object.entries({ d: "M2.5 2.5 19 11.6l-7.3 1.8-3.6 7.1z", fill: ACCENT, stroke: "#fff", "stroke-width": "1.6", "stroke-linejoin": "round" })) path.setAttribute(k, v);
      svg.append(path);
      const tag = document.createElement("span");
      tag.textContent = "Agent";
      tag.style.cssText = `position:absolute;left:15px;top:19px;padding:2px 6px 3px;border-radius:0 3px 3px 3px;background:${ACCENT};color:#fff;` +
        'font:500 11px/1.2 ui-monospace,"Cascadia Mono",Consolas,monospace;white-space:nowrap;';
      pointer.append(svg, tag);
      root.append(box, ring, pointer);
      document.documentElement.append(hostEl);
      Object.assign(S, { host: hostEl, box, ring, pointer, x: innerWidth * 0.62, y: innerHeight * 0.72 });
      pointer.style.transition = "none";
      pointer.style.transform = `translate(${S.x}px,${S.y}px)`;
      pointer.getBoundingClientRect(); // commit the start position before re-enabling the glide
      pointer.style.transition = `transform .5s ${EASE},opacity .3s`;
    }
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    S.x = Math.min(r.left + Math.min(r.width / 2, 48), innerWidth - 24);
    S.y = r.top + Math.min(r.height / 2, 24);
    Object.assign(S.box.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px`, opacity: "1" });
    S.pointer.style.opacity = "1";
    S.pointer.style.transform = `translate(${S.x}px,${S.y}px)`;
    clearTimeout(S.fade);
    S.fade = setTimeout(() => { S.pointer.style.opacity = "0"; S.box.style.opacity = "0"; }, 4000);
    return new Promise((done) => setTimeout(() => {
      if (kind === "click" && !reduce) {
        Object.assign(S.ring.style, { left: `${S.x}px`, top: `${S.y}px` });
        S.ring.animate([{ opacity: 0.9, transform: "scale(.3)" }, { opacity: 0, transform: "scale(1.7)" }], { duration: 550, easing: EASE });
      }
      done();
    }, reduce ? 60 : 520));
  }

  function readPage() {
    S.refs = new Map();
    const SEL = "a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=\"\"],[contenteditable=true]," +
      "[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=textbox],[role=combobox]";
    const lines = [];
    let n = 1;
    const add = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") return;
      S.refs.set(n, el);
      const value = el.type === "password" || el.type === "file" ? "" : el.value;
      const label = (el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.innerText || el.placeholder || value || el.title || el.alt || el.name || "")
        .trim().replace(/\s+/g, " ").slice(0, 80);
      const kind = el.tagName.toLowerCase() + (el.tagName === "INPUT" ? `[${el.type}]` : "") + (el.getAttribute("role") ? `(${el.getAttribute("role")})` : "");
      const href = el.getAttribute("href");
      const offscreen = r.bottom < 0 || r.top > innerHeight;
      const state = el.type === "checkbox" || el.type === "radio" ? (el.checked ? " [checked]" : " [unchecked]")
        : value && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && value !== label ? ` = "${String(value).slice(0, 80)}"` : "";
      lines.push(`[${n}] ${kind} "${label}"${state}${href ? ` -> ${href.slice(0, 100)}` : ""}${offscreen ? " (offscreen)" : ""}`);
      n++;
    };
    const visit = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (lines.length >= 400) return;
        if (el === S.host) continue; // our own cursor overlay
        if (el.matches(SEL)) add(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 20000);
    return { title: document.title, url: location.href, text, lines };
  }

  // false = stale ref
  function describe(ref) {
    const el = getRef(ref);
    if (!el) return false;
    return (el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.innerText || el.value || el.title || el.name || "")
      .trim().replace(/\s+/g, " ").slice(0, 80);
  }

  async function clickRef(ref) {
    const el = getRef(ref);
    await agentCursor(el, "click");
    el.focus?.();
    el.click();
    return true;
  }

  async function typeRef(ref, text, submit) {
    const el = getRef(ref);
    await agentCursor(el, "type");
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll");
      document.execCommand("insertText", false, text);
    } else if (el instanceof HTMLSelectElement) {
      el.value = text;
    } else {
      // Native setter, so React/Vue value trackers see the change.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit && el.form) el.form.requestSubmit();
    else if (submit) for (const type of ["keydown", "keypress", "keyup"])
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    return true;
  }

  function scroll(direction) {
    const y = { up: -innerHeight * 0.8, down: innerHeight * 0.8 }[direction];
    y === undefined ? scrollTo(0, direction === "top" ? 0 : document.body.scrollHeight) : scrollBy(0, y);
    return `Scrolled ${direction}.`;
  }

  return { readPage, describe, clickRef, typeRef, scroll };
})();
true;
