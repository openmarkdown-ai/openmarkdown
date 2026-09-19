/* Generated site runtime: theme toggle, navigation drawer, callout folding,
   search, hover previews, outline tracking and the graph renderer. Vanilla JS,
   no network access except same-site fetches of search-index.json and pages. */
(function () {
  "use strict";
  var body = document.body;
  var root = body.getAttribute("data-root") || "";

  // ---- theme -----------------------------------------------------------------
  function applyTheme(t) {
    var dark = t === "dark" || (t !== "light" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    body.classList.toggle("theme-dark", dark);
    body.classList.toggle("theme-light", !dark);
  }
  document.querySelectorAll(".theme-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var next = body.classList.contains("theme-dark") ? "light" : "dark";
      try { localStorage.setItem("vault-publish-theme", next); } catch (e) {}
      applyTheme(next);
      redrawGraphs();
    });
  });
  if (window.matchMedia) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      var stored = null;
      try { stored = localStorage.getItem("vault-publish-theme"); } catch (e) {}
      applyTheme(stored || body.getAttribute("data-default-theme") || "auto");
      redrawGraphs();
    });
  }

  // ---- navigation drawer ---------------------------------------------------------
  document.querySelectorAll(".site-header-menu").forEach(function (btn) {
    btn.addEventListener("click", function () { body.classList.toggle("nav-open"); });
  });
  document.addEventListener("click", function (e) {
    if (body.classList.contains("nav-open") && !e.target.closest(".site-body-left-column,.site-header-menu")) body.classList.remove("nav-open");
  });
  var active = document.querySelector(".site-body-left-column .nav-view-outer .is-active");
  var column = document.querySelector(".site-body-left-column");
  if (active && column) {
    var top = active.getBoundingClientRect().top - column.getBoundingClientRect().top;
    if (top > column.clientHeight - 40) column.scrollTop = top - column.clientHeight / 2;
  }

  // ---- callouts --------------------------------------------------------------------
  document.addEventListener("click", function (e) {
    var title = e.target.closest(".callout.is-collapsible > .callout-title");
    if (!title) return;
    var callout = title.parentElement;
    var content = callout.querySelector(":scope > .callout-content");
    var fold = title.querySelector(".callout-fold");
    var collapsed = callout.classList.toggle("is-collapsed");
    if (fold) fold.classList.toggle("is-collapsed", collapsed);
    if (content) content.style.display = collapsed ? "none" : "";
  });

  // ---- search ------------------------------------------------------------------------
  var index = null, loading = null;
  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = fetch(root + "search-index.json").then(function (r) { return r.json(); }).then(function (d) { index = d; return d; });
    }
    return loading;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function highlight(text, terms) {
    var out = escapeHtml(text);
    terms.forEach(function (t) {
      if (!t) return;
      var re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "&amp;").replace(/</g, "&lt;") + ")", "gi");
      out = out.replace(re, "<mark>$1</mark>");
    });
    return out;
  }
  function search(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    var results = [];
    index.forEach(function (p) {
      var score = 0, title = p.t.toLowerCase(), text = (p.x || "").toLowerCase(), snippetAt = -1;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i], s = 0;
        if (title === t) s += 100;
        if (title.indexOf(t) === 0) s += 40;
        else if (title.indexOf(t) >= 0) s += 25;
        if ((p.a || []).some(function (a) { return a.toLowerCase().indexOf(t) >= 0; })) s += 20;
        if ((p.h || []).some(function (h) { return h.toLowerCase().indexOf(t) >= 0; })) s += 10;
        if ((p.g || []).some(function (g) { return g.toLowerCase().indexOf(t) >= 0; })) s += 8;
        var at = text.indexOf(t);
        if (at >= 0) { s += 2 + Math.min(5, text.split(t).length - 1); if (snippetAt < 0) snippetAt = at; }
        if (!s) { score = 0; break; }
        score += s;
      }
      if (score) results.push({ p: p, score: score, at: snippetAt });
    });
    results.sort(function (a, b) { return b.score - a.score || a.p.t.localeCompare(b.p.t); });
    return results.slice(0, 30).map(function (r) {
      var snippet = "";
      if (r.at >= 0) {
        var start = Math.max(0, r.at - 50);
        snippet = (start > 0 ? "…" : "") + r.p.x.slice(start, r.at + 110) + "…";
      }
      return { page: r.p, snippet: snippet, terms: terms };
    });
  }
  document.querySelectorAll(".search-view-outer").forEach(function (outer) {
    var input = outer.querySelector("input");
    var box = outer.querySelector(".search-results");
    var selected = -1, items = [];
    function select(i) {
      items.forEach(function (el, j) { el.classList.toggle("is-selected", i === j); });
      selected = i;
      if (items[i]) items[i].scrollIntoView({ block: "nearest" });
    }
    function run() {
      var q = input.value.trim();
      if (!q) { box.hidden = true; return; }
      loadIndex().then(function () {
        var res = search(q);
        box.innerHTML = res.length ? res.map(function (r) {
          return '<a class="search-result" href="' + escapeHtml(root + r.page.u) + '"><div class="search-result-title">' + highlight(r.page.t, r.terms) +
            '</div><div class="search-result-path">' + escapeHtml(r.page.p || "") + "</div>" +
            (r.snippet ? '<div class="search-result-snippet">' + highlight(r.snippet, r.terms) + "</div>" : "") + "</a>";
        }).join("") : '<div class="search-empty">No results</div>';
        items = Array.prototype.slice.call(box.querySelectorAll(".search-result"));
        var r = input.getBoundingClientRect();
        box.style.left = Math.max(8, r.left - 8) + "px";
        box.style.top = r.bottom + 6 + "px";
        box.style.width = Math.min(440, window.innerWidth - Math.max(8, r.left - 8) - 8) + "px";
        box.hidden = false;
        select(items.length ? 0 : -1);
      }).catch(function () {
        box.innerHTML = '<div class="search-empty">Search needs the site to be served over HTTP.</div>';
        box.hidden = false;
      });
    }
    input.addEventListener("input", run);
    input.addEventListener("focus", function () { if (input.value.trim()) run(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) select((selected + 1) % items.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) select((selected - 1 + items.length) % items.length); }
      else if (e.key === "Enter") { if (items[selected]) { e.preventDefault(); location.href = items[selected].href; } }
      else if (e.key === "Escape") { box.hidden = true; input.blur(); }
    });
    document.addEventListener("click", function (e) { if (!outer.contains(e.target)) box.hidden = true; });
  });
  document.addEventListener("keydown", function (e) {
    if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName))) {
      var input = document.querySelector(".search-view-outer input");
      if (input) { e.preventDefault(); body.classList.add("nav-open"); input.focus(); input.select(); }
    }
  });

  // ---- hover previews -------------------------------------------------------------------
  if (body.hasAttribute("data-hover-preview")) {
    var cache = {}, popover = null, showTimer = 0, hideTimer = 0;
    function hide() { if (popover) { popover.remove(); popover = null; } }
    function place(pop, link) {
      var r = link.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
      var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      var top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      pop.style.left = left + "px";
      pop.style.top = top + "px";
    }
    function show(link) {
      var url = link.href.split("#")[0], hash = link.href.split("#")[1];
      var p = cache[url] || (cache[url] = fetch(url).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var c = doc.querySelector(".render-container");
        return c ? c.innerHTML : "";
      }));
      p.then(function (html) {
        if (!html) return;
        hide();
        popover = document.createElement("div");
        popover.className = "popover hover-popover";
        popover.innerHTML = html;
        popover.querySelectorAll(".breadcrumbs,.mobile-right,.page-tags").forEach(function (el) { el.remove(); });
        // Links inside the preview are relative to the previewed page.
        popover.querySelectorAll("a[href],img[src]").forEach(function (el) {
          var attr = el.tagName === "A" ? "href" : "src", v = el.getAttribute(attr);
          if (v && !/^(#|[a-z]+:)/i.test(v)) el.setAttribute(attr, new URL(v, url).href);
        });
        document.body.appendChild(popover);
        place(popover, link);
        if (hash) {
          var target = popover.querySelector('[id="' + decodeURIComponent(hash).replace(/"/g, '\\"') + '"]');
          if (target) popover.scrollTop = target.offsetTop - 8;
        }
        popover.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
        popover.addEventListener("mouseleave", function () { hideTimer = setTimeout(hide, 250); });
      }).catch(function () {});
    }
    document.addEventListener("mouseover", function (e) {
      var link = e.target.closest && e.target.closest(".markdown-rendered a.internal-link[href], .backlink-item");
      if (!link || (popover && popover.contains(link)) || link.getAttribute("href").charAt(0) === "#") return;
      if (/\.(png|jpe?g|gif|svg|webp|pdf|mp3|mp4|webm)$/i.test(link.href.split("#")[0])) return;
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(function () { show(link); }, 350);
      link.addEventListener("mouseleave", function leave() {
        clearTimeout(showTimer);
        hideTimer = setTimeout(hide, 250);
        link.removeEventListener("mouseleave", leave);
      });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
  }

  // ---- outline tracking ------------------------------------------------------------------------
  var outlineLinks = Array.prototype.slice.call(document.querySelectorAll(".site-body-right-column .outline-view-outer a"));
  if (outlineLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    outlineLinks.forEach(function (a) { byId[decodeURIComponent(a.getAttribute("href").slice(1))] = a; });
    var visible = {};
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      var first = outlineLinks.find(function (a) { return visible[decodeURIComponent(a.getAttribute("href").slice(1))]; });
      if (first) outlineLinks.forEach(function (a) { a.classList.toggle("is-active", a === first); });
    }, { rootMargin: "0px 0px -60% 0px" });
    Object.keys(byId).forEach(function (id) { var el = document.getElementById(id); if (el) obs.observe(el); });
  }

  // ---- graph ---------------------------------------------------------------------------------------
  var graphs = [];
  function redrawGraphs() { graphs.forEach(function (g) { g(); }); }
  function cssVar(el, name, fallback) {
    var v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  }
  function Graph(container, data) {
    var canvas = document.createElement("canvas");
    container.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    var nodes = data.nodes, links = data.links, local = container.hasAttribute("data-local");
    var neighbors = nodes.map(function () { return []; });
    links.forEach(function (l) { neighbors[l[0]].push(l[1]); neighbors[l[1]].push(l[0]); });
    var view = { k: 1, x: 0, y: 0 }, hover = -1, width = 0, height = 0, dpr = 1;
    function fit() {
      if (!nodes.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (n) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); });
      var pad = local ? 40 : 30;
      var k = Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY));
      view.k = Math.min(Math.max(k, 0.02), local ? 1.2 : 2);
      view.x = width / 2 - ((minX + maxX) / 2) * view.k;
      view.y = height / 2 - ((minY + maxY) / 2) * view.k;
    }
    function resize() {
      var r = container.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      var first = width === 0;
      width = r.width; height = r.height;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      if (first) fit();
      draw();
    }
    function radius(n) { return Math.max(3, Math.min(14, 3 + Math.sqrt(n.weight || 0) * 1.4)); }
    function screen(n) { return [n.x * view.k + view.x, n.y * view.k + view.y]; }
    function draw() {
      if (!width) return;
      var line = cssVar(container, "--background-modifier-border", "#ccc");
      var fill = cssVar(container, "--text-muted", "#888");
      var accent = cssVar(container, "--interactive-accent", "#7c3aed");
      var text = cssVar(container, "--text-normal", "#222");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      var hl = hover >= 0 ? neighbors[hover].concat([hover]) : null;
      ctx.lineWidth = 1;
      links.forEach(function (l) {
        var a = screen(nodes[l[0]]), b = screen(nodes[l[1]]);
        var on = hl && (l[0] === hover || l[1] === hover);
        ctx.strokeStyle = on ? accent : line;
        ctx.globalAlpha = hl && !on ? 0.35 : 1;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
      var zoomScale = Math.max(0.6, Math.min(1.6, Math.sqrt(view.k * (local ? 1 : 3))));
      nodes.forEach(function (n, i) {
        var p = screen(n), r = radius(n) * zoomScale;
        ctx.globalAlpha = hl && hl.indexOf(i) < 0 ? 0.3 : 1;
        ctx.fillStyle = n.current || i === hover ? accent : fill;
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
      });
      ctx.font = "12px " + cssVar(body, "--font-text", "sans-serif");
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      nodes.forEach(function (n, i) {
        var show = n.current || i === hover || (hl && hl.indexOf(i) >= 0) || view.k > (local ? 0.75 : 0.9) || (local && nodes.length <= 6);
        if (!show) return;
        var p = screen(n);
        ctx.globalAlpha = hl && hl.indexOf(i) < 0 ? 0.3 : 1;
        ctx.fillStyle = text;
        ctx.fillText(n.label, p[0], p[1] + radius(n) * zoomScale + 3);
      });
      ctx.globalAlpha = 1;
    }
    function nodeAt(x, y) {
      var best = -1, bestD = Infinity;
      nodes.forEach(function (n, i) {
        var p = screen(n), dx = p[0] - x, dy = p[1] - y, d = dx * dx + dy * dy, r = radius(n) + 6;
        if (d < r * r && d < bestD) { best = i; bestD = d; }
      });
      return best;
    }
    var drag = null;
    canvas.addEventListener("pointerdown", function (e) {
      var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      drag = { x: x, y: y, node: nodeAt(x, y), moved: false, vx: view.x, vy: view.y };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag) {
        if (Math.abs(x - drag.x) + Math.abs(y - drag.y) > 3) drag.moved = true;
        if (drag.node >= 0 && drag.moved) {
          nodes[drag.node].x = (x - view.x) / view.k; nodes[drag.node].y = (y - view.y) / view.k;
        } else if (drag.node < 0) {
          view.x = drag.vx + x - drag.x; view.y = drag.vy + y - drag.y;
        }
        draw();
        return;
      }
      var h = nodeAt(x, y);
      if (h !== hover) { hover = h; canvas.style.cursor = h >= 0 ? "pointer" : "grab"; draw(); }
    });
    canvas.addEventListener("pointerup", function () {
      if (drag && !drag.moved && drag.node >= 0 && nodes[drag.node].url != null) location.href = root + nodes[drag.node].url;
      drag = null;
    });
    canvas.addEventListener("pointerleave", function () { if (!drag && hover >= 0) { hover = -1; draw(); } });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      var f = Math.exp(-e.deltaY * 0.0015), k = Math.min(8, Math.max(0.02, view.k * f));
      view.x = x - ((x - view.x) * k) / view.k; view.y = y - ((y - view.y) * k) / view.k; view.k = k;
      draw();
    }, { passive: false });
    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(container);
    resize();
    return draw;
  }
  document.querySelectorAll(".graph-view-container").forEach(function (container) {
    var script = container.parentElement.querySelector('script[type="application/json"]');
    if (!script) return;
    try { graphs.push(Graph(container, JSON.parse(script.textContent))); } catch (e) {}
  });
})();
