(function () {
  var style = document.createElement("style");
  style.textContent = [
    ".lc-privacy-overlay{position:fixed;inset:0;z-index:100;background:rgba(42,36,56,0.45);display:flex;align-items:center;justify-content:center;padding:18px;}",
    ".lc-privacy-dialog{background:#fffdf8;color:#2a2438;width:min(720px,100%);max-height:min(86vh,820px);border-radius:28px;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(42,36,56,0.18);font-family:Manrope,system-ui,sans-serif;}",
    ".lc-privacy-bar{display:flex;justify-content:flex-end;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(42,36,56,0.10);flex-shrink:0;}",
    ".lc-privacy-full,.lc-privacy-close{font-family:inherit;font-weight:600;font-size:13px;border-radius:999px;padding:8px 14px;cursor:pointer;}",
    ".lc-privacy-full{background:#6d4fd8;color:#fff;text-decoration:none;border:none;}",
    ".lc-privacy-full:hover{opacity:1;}",
    ".lc-privacy-close{background:#fff;color:#2a2438;border:1px solid rgba(42,36,56,0.10);}",
    ".lc-privacy-full:focus-visible,.lc-privacy-close:focus-visible{outline:3px solid #2a2438;outline-offset:3px;}",
    ".lc-privacy-body{overflow:auto;padding:4px 22px 22px;line-height:1.65;}",
    ".lc-privacy-body h1{font-size:26px;letter-spacing:-0.03em;margin:18px 0 8px;}",
    ".lc-privacy-body h2{font-size:18px;margin:22px 0 8px;}",
    ".lc-privacy-body p,.lc-privacy-body li{font-size:15px;}",
    ".lc-privacy-body .note{font-size:13px;color:#6a6178;}",
    ".lc-privacy-body .card{background:#fff;border:1px solid rgba(42,36,56,0.10);border-radius:18px;padding:8px 18px 18px;margin-top:12px;}",
    ".lc-privacy-body ul{padding-left:18px;}",
    "@media (max-width:767px){.lc-privacy-overlay{padding:10px;}.lc-privacy-dialog{border-radius:22px;max-height:92vh;}.lc-privacy-body{padding:4px 16px 16px;}}"
  ].join("");
  document.head.appendChild(style);

  var dialog = null;
  var lastFocus = null;
  var previousOverflow = "";

  function close() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    document.body.style.overflow = previousOverflow;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function open() {
    if (dialog) return;
    lastFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog = document.createElement("div");
    dialog.className = "lc-privacy-overlay";
    dialog.innerHTML = '<div class="lc-privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="lc-privacy-title" tabindex="-1"><div class="lc-privacy-bar"><a class="lc-privacy-full" href="/privacy" data-privacy-full>Full page</a><button type="button" class="lc-privacy-close">Close</button></div><div class="lc-privacy-body"><p class="note">Loading…</p></div></div>';
    document.body.appendChild(dialog);
    var panel = dialog.querySelector(".lc-privacy-dialog");
    panel.focus();
    dialog.querySelector(".lc-privacy-close").addEventListener("click", close);
    fetch("/privacy", { headers: { Accept: "text/html" } })
      .then(function (res) { if (!res.ok) throw new Error("missing"); return res.text(); })
      .then(function (html) {
        if (!dialog) return;
        var doc = new DOMParser().parseFromString(html, "text/html");
        var text = doc.getElementById("privacy-text");
        var body = dialog.querySelector(".lc-privacy-body");
        if (!text || !body) throw new Error("missing");
        body.innerHTML = text.innerHTML;
        var heading = body.querySelector("h1");
        if (heading) heading.id = "lc-privacy-title";
      })
      .catch(function () {
        if (!dialog) return;
        var body = dialog.querySelector(".lc-privacy-body");
        if (body) body.innerHTML = '<p>The privacy notice could not be loaded here. Use Full page.</p>';
      });
  }

  document.addEventListener("click", function (ev) {
    if (ev.target.closest("[data-privacy-full]")) return;
    var link = ev.target.closest('a[href="/privacy"]');
    if (!link) {
      if (dialog && ev.target === dialog) close();
      return;
    }
    ev.preventDefault();
    open();
  }, true);

  document.addEventListener("keydown", function (ev) {
    if (!dialog || ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    close();
  }, true);
})();
