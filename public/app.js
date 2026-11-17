// Marca Pagina Web — leitor de PDF que lembra onde você parou.
// Livros ficam no próprio aparelho (IndexedDB). Nada é enviado ao servidor.
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const $ = (sel) => document.querySelector(sel);
const ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3];
const LS = {
  open: "mpw:open",               // id do livro aberto (para reabrir direto nele)
  pos: (id) => `mpw:pos:${id}`,   // cópia de segurança da página: {page, t}
  night: "mpw:night",
  hint: "mpw:hint-dismissed",
};

/* ===================================================================
   Armazenamento (IndexedDB)
   - books: metadados (título, página atual, total, capa...)
   - files: o PDF em si (separado para a lista carregar rápido)
=================================================================== */
const db = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("marca-pagina-web", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "id" });
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(stores, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("Transação abortada"));
    });
  }
  const req2p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  return {
    allBooks: () => tx(["books"], "readonly", (t) => req2p(t.objectStore("books").getAll())),
    getBook: (id) => tx(["books"], "readonly", (t) => req2p(t.objectStore("books").get(id))),
    putBook: (book) => tx(["books"], "readwrite", (t) => { t.objectStore("books").put(book); }),
    getFile: (id) => tx(["files"], "readonly", (t) => req2p(t.objectStore("files").get(id))),
    addBook: (book, data) =>
      tx(["books", "files"], "readwrite", (t) => {
        t.objectStore("books").put(book);
        t.objectStore("files").put({ id: book.id, data });
      }),
    deleteBook: (id) =>
      tx(["books", "files"], "readwrite", (t) => {
        t.objectStore("books").delete(id);
        t.objectStore("files").delete(id);
      }),
    updateBook(id, patch) {
      // callbacks diretos (sem await) para o Safari não fechar a transação antes do put
      return tx(["books"], "readwrite", (t) => {
        const store = t.objectStore("books");
        const r = store.get(id);
        r.onsuccess = () => { if (r.result) store.put(Object.assign(r.result, patch)); };
      });
    },
  };
})();

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

/** Página salva: usa a mais recente entre IndexedDB e a cópia no localStorage. */
function resolvePage(book) {
  let page = book.page || 1;
  let t = book.pageSavedAt || 0;
  try {
    const backup = JSON.parse(lsGet(LS.pos(book.id)) || "null");
    if (backup && backup.t > t) page = backup.page;
  } catch {}
  return Math.min(Math.max(1, page), book.pageCount || page);
}

/* ===================================================================
   Utilidades
=================================================================== */
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function cleanTitle(name) {
  return name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || "Sem título";
}
function fmtBytes(b) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function relDate(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < 60000) return "agora";
  if (diff < 3600000) return `há ${Math.round(diff / 60000)} min`;
  if (diff < day) return `há ${Math.round(diff / 3600000)} h`;
  if (diff < 2 * day) return "ontem";
  if (diff < 30 * day) return `há ${Math.round(diff / day)} dias`;
  return new Date(ts).toLocaleDateString("pt-BR");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
}

/* ===================================================================
   Biblioteca
=================================================================== */
async function renderLibrary() {
  const books = (await db.allBooks()).sort(
    (a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt)
  );
  const shelf = $("#shelf");
  shelf.innerHTML = "";
  $("#empty").hidden = books.length > 0;

  for (const book of books) {
    const page = resolvePage(book);
    const pct = book.pageCount ? Math.round((page / book.pageCount) * 100) : 0;
    const el = document.createElement("div");
    el.className = "book";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.dataset.id = book.id;
    el.innerHTML = `
      <div class="cover">
        ${book.cover ? `<img src="${book.cover}" alt="">` : `<div class="placeholder">${escapeHtml(book.title)}</div>`}
        ${page > 1 ? `<span class="ribbon-mark" aria-hidden="true"></span>` : ""}
      </div>
      <button class="book-more" aria-label="Opções de ${escapeHtml(book.title)}">•••</button>
      <p class="book-title">${escapeHtml(book.title)}</p>
      <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="book-meta">
        <span>Pág. ${page} de ${book.pageCount || "?"}</span>
        <span>${book.lastOpened ? relDate(book.lastOpened) : "novo"}</span>
      </div>`;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".book-more")) { e.stopPropagation(); openBookMenu(book); return; }
      openBook(book.id);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") openBook(book.id); });
    shelf.appendChild(el);
  }
  updateStorageInfo(books);
}

async function updateStorageInfo(books) {
  const total = books.reduce((s, b) => s + (b.size || 0), 0);
  let txt = books.length ? `${books.length} ${books.length === 1 ? "livro" : "livros"} · ${fmtBytes(total)} no aparelho` : "";
  try {
    if (navigator.storage && navigator.storage.estimate && books.length) {
      const { quota } = await navigator.storage.estimate();
      if (quota) txt += ` · espaço disponível ~${fmtBytes(quota)}`;
    }
  } catch {}
  $("#storage-info").textContent = txt;
}

async function addFiles(files) {
  const list = [...files].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!list.length) { toast("Escolha um arquivo PDF."); return; }
  requestPersistence();
  const existing = await db.allBooks();
  let added = 0, lastId = null;

  for (const file of list) {
    const dup = existing.find((b) => b.fileName === file.name && b.size === file.size);
    if (dup) {
      toast(`"${dup.title}" já está na estante.`);
      lastId = dup.id;
      continue;
    }
    // cartão provisório
    const temp = document.createElement("div");
    temp.className = "book adding";
    temp.innerHTML = `<div class="cover"><div class="placeholder">${escapeHtml(cleanTitle(file.name))}</div></div><p class="book-title">${escapeHtml(cleanTitle(file.name))}</p>`;
    $("#empty").hidden = true;
    $("#shelf").prepend(temp);

    try {
      const buf = await file.arrayBuffer();
      // pdf.js transfere o buffer para o worker, por isso passamos uma cópia.
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      const cover = await makeCover(doc).catch(() => null);
      const book = {
        id: uid(),
        title: cleanTitle(file.name),
        fileName: file.name,
        size: file.size,
        pageCount: doc.numPages,
        page: 1,
        pageSavedAt: Date.now(),
        zoom: 1,
        addedAt: Date.now(),
        lastOpened: 0,
        cover,
      };
      await doc.destroy();
      await db.addBook(book, new Blob([buf], { type: "application/pdf" }));
      existing.push(book);
      added++;
      lastId = book.id;
    } catch (err) {
      console.error(err);
      temp.remove();
      if (err && err.name === "PasswordException") toast(`"${file.name}" é protegido por senha e não pode ser aberto.`, 4000);
      else if (err && err.name === "QuotaExceededError") toast("Sem espaço no aparelho para este livro.", 4000);
      else toast(`Não foi possível abrir "${file.name}".`, 4000);
    }
  }
  await renderLibrary();
  if (added === 1 && list.length === 1 && lastId) openBook(lastId);
  else if (added > 1) toast(`${added} livros adicionados.`);
}

async function makeCover(doc) {
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = 300 / vp1.width;
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const url = c.toDataURL("image/jpeg", 0.72);
  c.width = c.height = 0;
  page.cleanup();
  return url;
}

let menuBook = null;
function openBookMenu(book) {
  menuBook = book;
  $("#book-menu-title").textContent = book.title;
  const dlg = $("#book-menu");
  dlg.returnValue = "";
  dlg.showModal();
}
$("#book-menu").addEventListener("close", async () => {
  const action = $("#book-menu").returnValue;
  const book = menuBook;
  menuBook = null;
  if (!book) return;
  if (action === "open") openBook(book.id);
  if (action === "rename") {
    const name = prompt("Novo nome do livro:", book.title);
    if (name && name.trim()) { await db.updateBook(book.id, { title: name.trim() }); renderLibrary(); }
  }
  if (action === "reset") {
    await savePosition(book.id, 1);
    renderLibrary();
    toast("Marcador voltou para a página 1.");
  }
  if (action === "delete") {
    if (confirm(`Remover "${book.title}" da estante? O PDF será apagado deste aparelho.`)) {
      await db.deleteBook(book.id);
      lsDel(LS.pos(book.id));
      renderLibrary();
      toast("Livro removido.");
    }
  }
});
// toque fora do menu fecha
$("#book-menu").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close("cancel"); });

$("#file-input").addEventListener("change", (e) => {
  const files = e.target.files;
  if (files && files.length) addFiles(files);
  e.target.value = "";
});

// arrastar e soltar (computador)
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!$("#library").hidden && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

/* ===================================================================
   Leitor
=================================================================== */
const R = {
  book: null,
  doc: null,
  page: 1,
  zoom: 1,
  renderTask: null,
  renderSeq: 0,
};

async function savePosition(id, page) {
  const t = Date.now();
  lsSet(LS.pos(id), JSON.stringify({ page, t })); // síncrono: garante mesmo se o iOS matar o app
  try { await db.updateBook(id, { page, pageSavedAt: t }); } catch (e) { console.warn(e); }
}

async function openBook(id) {
  const book = await db.getBook(id);
  if (!book) { lsDel(LS.open); showLibrary(); return; }
  const file = await db.getFile(id);
  if (!file) { toast("Arquivo do livro não encontrado."); return; }

  R.book = book;
  R.page = resolvePage(book);
  R.zoom = book.zoom || 1;
  lsSet(LS.open, id);

  $("#library").hidden = true;
  $("#reader").hidden = false;
  $("#reader").classList.remove("chrome-hidden");
  $("#reader-title").textContent = book.title;
  $("#page-indicator").textContent = `${R.page} / ${book.pageCount || "?"}`;
  $("#page-wrap").innerHTML = "";
  $("#loading").hidden = false;
  document.title = `${book.title} — Marca Pagina Web`;
  history.replaceState(null, "", "#ler");

  try {
    const data = file.data instanceof Blob ? new Uint8Array(await file.data.arrayBuffer()) : new Uint8Array(file.data);
    if (R.book !== book) return; // usuário saiu enquanto carregava
    R.doc = await pdfjsLib.getDocument({ data }).promise;
    if (R.book !== book) { R.doc.destroy(); return; }
    if (book.pageCount !== R.doc.numPages) await db.updateBook(id, { pageCount: R.doc.numPages });
    book.pageCount = R.doc.numPages;
    R.page = Math.min(R.page, book.pageCount);
    $("#slider").max = book.pageCount;
    await renderPage();
    await db.updateBook(id, { lastOpened: Date.now() });
    if (R.page > 1) toast(`Continuando na página ${R.page}`, 1800);
    // esconde as barras depois de um tempo para leitura limpa
    setTimeout(() => { if (R.book === book) $("#reader").classList.add("chrome-hidden"); }, 2200);
  } catch (err) {
    console.error(err);
    toast("Não foi possível abrir este PDF.", 3500);
    closeBook();
  }
}

async function closeBook() {
  if (R.book) await savePosition(R.book.id, R.page);
  if (R.renderTask) { try { R.renderTask.cancel(); } catch {} }
  if (R.doc) { try { await R.doc.destroy(); } catch {} }
  R.book = null; R.doc = null; R.renderTask = null;
  for (const c of document.querySelectorAll("#page-wrap canvas")) { c.width = c.height = 0; }
  $("#page-wrap").innerHTML = "";
  lsDel(LS.open);
  showLibrary();
}

function showLibrary() {
  $("#reader").hidden = true;
  $("#library").hidden = false;
  document.title = "Marca Pagina Web";
  if (location.hash) history.replaceState(null, "", location.pathname);
  renderLibrary();
}

async function renderPage() {
  if (!R.doc) return;
  const seq = ++R.renderSeq;
  const pageNum = R.page;
  updatePageUI();

  if (R.renderTask) { try { R.renderTask.cancel(); } catch {} }
  const slow = setTimeout(() => { if (seq === R.renderSeq) $("#loading").hidden = false; }, 150);

  try {
    const page = await R.doc.getPage(pageNum);
    if (seq !== R.renderSeq) return;
    const stage = $("#stage");
    const base = page.getViewport({ scale: 1 });
    const availW = stage.clientWidth;
    const availH = stage.clientHeight;
    // Ajusta à largura; em telas largas (paisagem/iPad) limita pela altura para caber a página.
    let fit = availW / base.width;
    if (availW > availH && base.height * fit > availH * 1.6) fit = (availH * 1.6) / base.height;
    if (availW >= 700) fit = Math.min(fit, (availH - 16) / base.height);
    const cssScale = fit * R.zoom;
    const cssVp = page.getViewport({ scale: cssScale });

    // resolução: devicePixelRatio, limitada para não estourar a memória do iPhone
    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    const MAX_PIXELS = 9_000_000;
    if (cssVp.width * cssVp.height * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (cssVp.width * cssVp.height));
    const vp = page.getViewport({ scale: cssScale * dpr });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${Math.floor(cssVp.width)}px`;
    canvas.style.height = `${Math.floor(cssVp.height)}px`;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    R.renderTask = page.render({ canvasContext: ctx, viewport: vp });
    await R.renderTask.promise;
    R.renderTask = null;
    if (seq !== R.renderSeq) { canvas.width = canvas.height = 0; return; }

    const wrap = $("#page-wrap");
    for (const old of wrap.querySelectorAll("canvas")) { old.width = old.height = 0; }
    wrap.replaceChildren(canvas);
    stage.classList.toggle("zoomed", R.zoom > 1);
    stage.scrollTo(0, 0);
    page.cleanup();
    prefetch(pageNum + 1);
  } catch (err) {
    if (err && err.name === "RenderingCancelledException") return;
    console.error(err);
    toast("Erro ao desenhar a página.");
  } finally {
    clearTimeout(slow);
    if (seq === R.renderSeq) $("#loading").hidden = true;
  }
}

function prefetch(n) {
  // pede ao pdf.js para já interpretar a próxima página (deixa a virada mais rápida)
  if (R.doc && n <= R.doc.numPages) R.doc.getPage(n).catch(() => {});
}

function updatePageUI() {
  const total = R.book ? R.book.pageCount : 1;
  $("#page-indicator").textContent = `${R.page} / ${total}`;
  $("#slider").value = R.page;
  $("#btn-prev").disabled = R.page <= 1;
  $("#btn-next").disabled = R.page >= total;
  $("#btn-zoom-out").disabled = R.zoom <= ZOOMS[0];
  $("#btn-zoom-in").disabled = R.zoom >= ZOOMS[ZOOMS.length - 1];
}

let savedFlashTimer;
function goTo(n) {
  if (!R.book || !R.doc) return;
  const total = R.book.pageCount;
  n = Math.min(Math.max(1, Math.round(n)), total);
  if (n === R.page) return;
  R.page = n;
  savePosition(R.book.id, n);
  const el = $("#saved-toast");
  el.classList.add("show");
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => el.classList.remove("show"), 700);
  renderPage();
}
const next = () => goTo(R.page + 1);
const prev = () => goTo(R.page - 1);

function setZoom(z) {
  if (!R.book) return;
  R.zoom = z;
  db.updateBook(R.book.id, { zoom: z });
  renderPage();
}
function zoomStep(dir) {
  const i = ZOOMS.indexOf(R.zoom);
  const ni = Math.min(Math.max(0, (i < 0 ? 0 : i) + dir), ZOOMS.length - 1);
  setZoom(ZOOMS[ni]);
}

// ---- controles
$("#btn-back").addEventListener("click", closeBook);
$("#btn-next").addEventListener("click", next);
$("#btn-prev").addEventListener("click", prev);
$("#btn-zoom-in").addEventListener("click", () => zoomStep(1));
$("#btn-zoom-out").addEventListener("click", () => zoomStep(-1));
$("#slider").addEventListener("input", (e) => {
  $("#page-indicator").textContent = `${e.target.value} / ${R.book ? R.book.pageCount : 1}`;
});
$("#slider").addEventListener("change", (e) => goTo(Number(e.target.value)));
$("#page-indicator").addEventListener("click", () => {
  if (!R.book) return;
  const v = prompt(`Ir para a página (1 a ${R.book.pageCount}):`, String(R.page));
  const n = parseInt(v, 10);
  if (!isNaN(n)) goTo(n);
});
$("#btn-night").addEventListener("click", () => {
  const on = !$("#reader").classList.contains("night");
  $("#reader").classList.toggle("night", on);
  lsSet(LS.night, on ? "1" : "0");
});
if (lsGet(LS.night) === "1") $("#reader").classList.add("night");

// ---- gestos: toque nas bordas vira a página, toque no meio mostra/esconde barras, deslizar vira a página
(() => {
  const stage = $("#stage");
  let start = null;
  stage.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) { start = null; return; }
    start = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  stage.addEventListener("pointercancel", () => { start = null; });
  stage.addEventListener("pointerup", (e) => {
    if (!start || !e.isPrimary) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = Date.now() - start.t;
    start = null;
    const reader = $("#reader");

    if (R.zoom === 1 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 800) {
      dx < 0 ? next() : prev();
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 450) {
      const w = stage.clientWidth;
      const x = e.clientX;
      if (x < w * 0.28) prev();
      else if (x > w * 0.72) next();
      else reader.classList.toggle("chrome-hidden");
    }
  });
})();

// teclado (iPad com teclado / computador)
document.addEventListener("keydown", (e) => {
  if ($("#reader").hidden || $("#book-menu").open) return;
  if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); next(); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); prev(); }
  else if (e.key === "Escape") closeBook();
});

// girar a tela / redimensionar → redesenhar
let resizeTimer, lastSize = `${innerWidth}x${innerHeight}`;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const size = `${innerWidth}x${innerHeight}`;
    if (size !== lastSize && R.doc) { lastSize = size; renderPage(); }
    lastSize = size;
  }, 200);
});

// salvar ao sair do app (fechar, trocar de app, bloquear o iPhone)
function flush() { if (R.book) savePosition(R.book.id, R.page); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
window.addEventListener("pagehide", flush);

/* ===================================================================
   Inicialização
=================================================================== */
function setupInstallHint() {
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (isIOS && !standalone && lsGet(LS.hint) !== "1") $("#install-hint").hidden = false;
  $("#install-hint-close").addEventListener("click", () => { $("#install-hint").hidden = true; lsSet(LS.hint, "1"); });
}

async function init() {
  setupInstallHint();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW:", e));
  }
  // Reabre direto no livro que estava aberto quando o app foi fechado.
  const openId = lsGet(LS.open);
  if (openId && (await db.getBook(openId))) {
    openBook(openId);
  } else {
    lsDel(LS.open);
    renderLibrary();
  }
}

init();
