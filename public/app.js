// Marca Pagina Web — leitor de PDF que lembra onde você parou.
// Livros ficam no próprio aparelho (IndexedDB). Nada é enviado ao servidor.
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const LS = {
  open: "mpw:open",               // id do livro aberto (para reabrir direto nele)
  pos: (id) => `mpw:pos:${id}`,   // cópia de segurança da posição: {page, anchor, t}
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

/** Posição salva: usa a mais recente entre IndexedDB e a cópia no localStorage. */
function resolvePos(book) {
  let page = book.page || 1;
  let anchor = book.anchor || null;
  let t = book.pageSavedAt || 0;
  try {
    const backup = JSON.parse(lsGet(LS.pos(book.id)) || "null");
    if (backup && backup.t > t) { page = backup.page; anchor = backup.anchor || null; }
  } catch {}
  const max = book.pageCount || page;
  page = clamp(page, 1, max);
  if (anchor) anchor.page = clamp(anchor.page, 1, max);
  return { page, anchor };
}

async function savePosition(id, page, anchor) {
  const t = Date.now();
  lsSet(LS.pos(id), JSON.stringify({ page, anchor, t })); // síncrono: garante mesmo se o iOS matar o app
  try { await db.updateBook(id, { page, anchor, pageSavedAt: t }); } catch (e) { console.warn(e); }
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
    const { page } = resolvePos(book);
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
        anchor: null,
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
  const vp = page.getViewport({ scale: 300 / vp1.width });
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
    await savePosition(book.id, 1, null);
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
   Leitor — rolagem contínua (todas as páginas em sequência vertical),
   desenho sob demanda (só as páginas perto da tela) e zoom com dois dedos.
=================================================================== */
const stage = $("#stage");
const pagesEl = $("#pages");
const PAD = 6;   // margem lateral (px, em zoom 1)
const GAP = 10;  // espaço entre páginas (px, em zoom 1)
const MAX_PIXELS = 8_000_000; // limite de pixels por página desenhada (memória do iPhone)

const R = {
  book: null,
  doc: null,
  page: 1,         // página exibida (a que ocupa o meio superior da tela)
  zoom: 1,
  aspects: [],     // altura/largura de cada página
  tops: [],
  heights: [],
  els: [],
  pageW: 0,
  near: new Set(), // páginas perto da área visível (devem estar desenhadas)
  observer: null,
  pumping: null,   // documento cuja fila de desenho está rodando
  pinch: null,
  lastPinchEnd: 0,
};

let safeTop = 0, safeBottom = 0;
function measureSafeArea() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  safeTop = parseFloat(cs.paddingTop) || 0;
  safeBottom = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
}
const topPad = () => safeTop + 8;
const bottomPad = () => safeBottom + 96;

/** Posiciona todas as páginas para o zoom atual. */
function layout() {
  const sw = stage.clientWidth;
  const baseW = Math.min(sw - 2 * PAD, 900);
  const pageW = baseW * R.zoom;
  const left = Math.max(PAD * R.zoom, (sw - pageW) / 2);
  const gap = GAP * R.zoom;
  let y = topPad();
  for (let i = 0; i < R.els.length; i++) {
    const h = pageW * R.aspects[i];
    R.tops[i] = y;
    R.heights[i] = h;
    const s = R.els[i].style;
    s.left = `${left}px`;
    s.top = `${y}px`;
    s.width = `${pageW}px`;
    s.height = `${h}px`;
    y += h + gap;
  }
  pagesEl.style.width = `${pageW + 2 * left}px`;
  pagesEl.style.height = `${y - gap + bottomPad()}px`;
  R.pageW = pageW;
}

/** Última página cujo topo está acima de y (busca binária). */
function pageIndexAt(y) {
  let lo = 0, hi = R.tops.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (R.tops[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Ponto exato de leitura: página + fração da página no topo da tela. */
function getAnchor() {
  const y = stage.scrollTop + topPad();
  const i = pageIndexAt(y);
  const span = R.heights[i] + GAP * R.zoom;
  const sw = stage.scrollWidth;
  return {
    page: i + 1,
    frac: clamp((y - R.tops[i]) / span, 0, 1),
    x: sw > stage.clientWidth ? stage.scrollLeft / sw : 0,
  };
}
function applyAnchor(a) {
  const i = clamp((a.page || 1) - 1, 0, R.els.length - 1);
  const span = R.heights[i] + GAP * R.zoom;
  stage.scrollTop = R.tops[i] + (a.frac || 0) * span - topPad();
  stage.scrollLeft = (a.x || 0) * stage.scrollWidth;
}
function currentPage() {
  return pageIndexAt(stage.scrollTop + stage.clientHeight * 0.35) + 1;
}

async function openBook(id) {
  const book = await db.getBook(id);
  if (!book) { lsDel(LS.open); showLibrary(); return; }
  const file = await db.getFile(id);
  if (!file) { toast("Arquivo do livro não encontrado."); return; }

  const pos = resolvePos(book);
  R.book = book;
  R.page = pos.page;
  R.zoom = clamp(book.zoom || 1, MIN_ZOOM, MAX_ZOOM);
  lsSet(LS.open, id);

  $("#library").hidden = true;
  $("#reader").hidden = false;
  $("#reader").classList.remove("chrome-hidden");
  $("#reader-title").textContent = book.title;
  $("#page-indicator").textContent = `${R.page} / ${book.pageCount || "?"}`;
  pagesEl.replaceChildren();
  $("#loading").hidden = false;
  document.title = `${book.title} — Marca Pagina Web`;
  history.replaceState(null, "", "#ler");
  measureSafeArea();

  try {
    const data = file.data instanceof Blob ? new Uint8Array(await file.data.arrayBuffer()) : new Uint8Array(file.data);
    if (R.book !== book) return; // usuário saiu enquanto carregava
    const doc = await pdfjsLib.getDocument({ data }).promise;
    if (R.book !== book) { doc.destroy(); return; }
    R.doc = doc;
    const n = doc.numPages;
    if (book.pageCount !== n) await db.updateBook(id, { pageCount: n });
    book.pageCount = n;

    // Tamanho inicial de todas as páginas = tamanho da página 1 (corrigido ao desenhar cada uma).
    const first = await doc.getPage(1);
    const v1 = first.getViewport({ scale: 1 });
    R.aspects = new Array(n).fill(v1.height / v1.width);
    R.tops = new Array(n);
    R.heights = new Array(n);
    R.els = [];
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= n; i++) {
      const el = document.createElement("div");
      el.className = "pg";
      el.dataset.n = i;
      R.els.push(el);
      frag.appendChild(el);
    }
    pagesEl.appendChild(frag);
    layout();
    applyAnchor(pos.anchor || { page: pos.page, frac: 0, x: 0 });
    R.page = currentPage();
    $("#slider").max = n;
    updatePageUI();
    setupObserver();
    stage.focus({ preventScroll: true });
    $("#loading").hidden = true;

    await db.updateBook(id, { lastOpened: Date.now() });
    if (R.page > 1) toast(`Continuando na página ${R.page}`, 1800);
    setTimeout(() => { if (R.book === book) hideChrome(); }, 2200);
  } catch (err) {
    console.error(err);
    toast("Não foi possível abrir este PDF.", 3500);
    closeBook();
  }
}

function setupObserver() {
  if (R.observer) R.observer.disconnect();
  R.near.clear();
  const margin = Math.round(stage.clientHeight * 1.2);
  R.observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const n = Number(en.target.dataset.n);
        if (en.isIntersecting) R.near.add(n);
        else { R.near.delete(n); releasePage(n); }
      }
      pump();
    },
    { root: stage, rootMargin: `${margin}px 0px ${margin}px 0px` }
  );
  for (const el of R.els) R.observer.observe(el);
}

function releasePage(n) {
  const el = R.els[n - 1];
  if (!el) return;
  for (const c of el.querySelectorAll("canvas")) { c.width = c.height = 0; c.remove(); }
}

/** Desenha, uma por vez, as páginas próximas que ainda não estão na resolução certa. */
async function pump() {
  const doc = R.doc;
  // a fila é por documento: se um livro anterior travou no meio, não bloqueia o novo
  if (!doc || R.pumping === doc) return;
  R.pumping = doc;
  try {
    while (R.doc === doc) {
      const n = nextToRender();
      if (!n) break;
      await renderOne(doc, n);
    }
  } finally {
    if (R.pumping === doc) R.pumping = null;
  }
}
function nextToRender() {
  let best = 0, bestD = Infinity;
  for (const n of R.near) {
    const el = R.els[n - 1];
    if (!el || el.dataset.failed) continue;
    const c = el.querySelector("canvas");
    if (c && Math.abs(Number(c.dataset.w) - R.pageW) < 1) continue;
    const d = Math.abs(n - R.page);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}
async function renderOne(doc, n) {
  try {
    const page = await doc.getPage(n);
    if (R.doc !== doc) return;
    const v1 = page.getViewport({ scale: 1 });
    const aspect = v1.height / v1.width;
    if (Math.abs(aspect - R.aspects[n - 1]) > 0.002 && !R.pinch) {
      // página com tamanho diferente: reposiciona sem mover o ponto de leitura
      const a = getAnchor();
      R.aspects[n - 1] = aspect;
      layout();
      applyAnchor(a);
    }
    const cssW = R.pageW;
    const scale = cssW / v1.width;
    const cssH = v1.height * scale;
    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (cssW * cssH * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (cssW * cssH));
    const vp = page.getViewport({ scale: scale * dpr });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.dataset.w = cssW;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();

    const el = R.els[n - 1];
    if (R.doc !== doc || !R.near.has(n) || !el) { canvas.width = canvas.height = 0; return; }
    const old = el.querySelectorAll("canvas");
    el.appendChild(canvas);
    for (const c of old) { c.width = c.height = 0; c.remove(); }
  } catch (err) {
    if (R.doc !== doc) return;
    console.error(err);
    const el = R.els[n - 1];
    if (el) el.dataset.failed = "1";
  }
}

async function closeBook() {
  if (R.book && R.doc) await savePosition(R.book.id, R.page, getAnchor());
  clearTimeout(saveTimer);
  if (R.observer) R.observer.disconnect();
  R.observer = null;
  for (let i = 1; i <= R.els.length; i++) releasePage(i);
  const doc = R.doc;
  R.book = null; R.doc = null; R.els = []; R.near.clear();
  pagesEl.replaceChildren();
  if (doc) { try { await doc.destroy(); } catch {} }
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

function updatePageUI() {
  const total = R.book ? R.book.pageCount : 1;
  $("#page-indicator").textContent = `${R.page} / ${total}`;
  $("#slider").value = R.page;
}

function goTo(n) {
  if (!R.doc) return;
  n = clamp(Math.round(n), 1, R.els.length);
  stage.scrollTop = R.tops[n - 1] - topPad();
  R.page = n;
  updatePageUI();
  saveNow();
}

// ---- salvar posição durante a leitura
let saveTimer;
function saveNow() {
  clearTimeout(saveTimer);
  if (R.book && R.doc) savePosition(R.book.id, R.page, getAnchor());
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

// ---- rolagem
let scrollRaf = 0, chromeRefTop = 0;
stage.addEventListener("scroll", () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(onScroll);
}, { passive: true });
function onScroll() {
  scrollRaf = 0;
  if (!R.doc || R.pinch) return;
  const p = currentPage();
  if (p !== R.page) { R.page = p; updatePageUI(); }
  scheduleSave();
  if (!$("#reader").classList.contains("chrome-hidden") && Math.abs(stage.scrollTop - chromeRefTop) > 60) hideChrome();
}

function hideChrome() { $("#reader").classList.add("chrome-hidden"); }
function toggleChrome() {
  const r = $("#reader");
  const hidden = r.classList.toggle("chrome-hidden");
  if (!hidden) chromeRefTop = stage.scrollTop;
}

// ---- zoom
/** Aplica um novo zoom mantendo o ponto (cx, cy) do conteúdo sob a posição (fx, fy) da tela. */
function commitZoom(newZoom, cx, cy, fx, fy) {
  newZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  const s = newZoom / R.zoom;
  R.zoom = newZoom;
  layout();
  const T = topPad();
  stage.scrollLeft = cx * s - fx;
  stage.scrollTop = T + (cy - T) * s - fy;
  if (R.book) db.updateBook(R.book.id, { zoom: newZoom });
  R.page = currentPage();
  updatePageUI();
  scheduleSave();
  pump();
}

function stagePoint(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return { fx: clientX - r.left, fy: clientY - r.top };
}

// Pinça com dois dedos: durante o gesto só escala visualmente (rápido);
// ao soltar, refaz o layout no novo tamanho e redesenha nítido.
stage.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2 && R.doc) {
    e.preventDefault();
    const [a, b] = e.touches;
    const { fx, fy } = stagePoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    R.pinch = {
      d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      cx: stage.scrollLeft + fx,
      cy: stage.scrollTop + fy,
      z0: R.zoom,
      s: 1, fx, fy,
    };
    pagesEl.style.transformOrigin = "0 0";
    pagesEl.style.willChange = "transform";
  }
}, { passive: false });

stage.addEventListener("touchmove", (e) => {
  const p = R.pinch;
  if (!p || e.touches.length < 2) return;
  if (e.cancelable) e.preventDefault();
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const { fx, fy } = stagePoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  p.s = clamp(d / p.d0, MIN_ZOOM / p.z0, MAX_ZOOM / p.z0);
  p.fx = fx; p.fy = fy;
  const tx = fx + stage.scrollLeft - p.cx * p.s;
  const ty = fy + stage.scrollTop - p.cy * p.s;
  pagesEl.style.transform = `translate(${tx}px, ${ty}px) scale(${p.s})`;
}, { passive: false });

function endPinch() {
  const p = R.pinch;
  if (!p) return;
  R.pinch = null;
  R.lastPinchEnd = Date.now();
  pagesEl.style.transform = "";
  pagesEl.style.willChange = "";
  commitZoom(p.z0 * p.s, p.cx, p.cy, p.fx, p.fy);
}
stage.addEventListener("touchend", (e) => { if (R.pinch && e.touches.length < 2) endPinch(); });
stage.addEventListener("touchcancel", () => endPinch());
// impede o zoom nativo do Safari (que ampliaria a tela inteira, barras incluídas)
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// Toque simples: mostra/esconde as barras. Toque duplo: amplia/reduz naquele ponto.
let lastTap = null, tapTimer = 0;
stage.addEventListener("click", (e) => {
  if (!R.doc || Date.now() - R.lastPinchEnd < 400) return;
  const now = Date.now();
  if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
    clearTimeout(tapTimer);
    lastTap = null;
    const { fx, fy } = stagePoint(e.clientX, e.clientY);
    const target = R.zoom > 1.05 ? 1 : 2;
    commitZoom(target, stage.scrollLeft + fx, stage.scrollTop + fy, fx, fy);
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  clearTimeout(tapTimer);
  tapTimer = setTimeout(toggleChrome, 300);
});

// Computador: Ctrl + roda do mouse (ou pinça no trackpad) faz zoom
stage.addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !R.doc) return;
  e.preventDefault();
  const { fx, fy } = stagePoint(e.clientX, e.clientY);
  commitZoom(R.zoom * Math.exp(-e.deltaY * 0.01), stage.scrollLeft + fx, stage.scrollTop + fy, fx, fy);
}, { passive: false });

// ---- controles
$("#btn-back").addEventListener("click", closeBook);
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

document.addEventListener("keydown", (e) => {
  if ($("#reader").hidden || $("#book-menu").open) return;
  if (e.key === "Escape") closeBook();
});

// girar a tela / redimensionar → refaz o layout mantendo o ponto de leitura
let resizeTimer, lastSize = `${innerWidth}x${innerHeight}`;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const size = `${innerWidth}x${innerHeight}`;
    if (size === lastSize || !R.doc) { lastSize = size; return; }
    lastSize = size;
    const a = getAnchor();
    measureSafeArea();
    layout();
    applyAnchor(a);
    setupObserver();
  }, 200);
});

// salvar ao sair do app (fechar, trocar de app, bloquear o iPhone)
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });
window.addEventListener("pagehide", saveNow);

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
