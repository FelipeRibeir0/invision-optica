/* ============================================================
   InVision Ótica Personalizada — Scripts
   ============================================================ */

"use strict";

import { db, auth } from "./firebase.js";

import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

// ── CONSTANTES ──────────────────────────────────────────────

const LOGO_CLICKS_NEEDED = 5;
const LOGO_CLICK_TIMEOUT = 3000; // ms
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — limite de entrada antes de comprimir
const IMAGE_MAX_DIMENSION = 800; // px — lado máximo após redimensionamento
const IMAGE_QUALITY = 0.8; // 80 % de qualidade JPEG após compressão
const PRODUCTS_COLLECTION = "products";
const NOTICES_COLLECTION  = "notices";
const NOTICE_DOC_ID       = "active"; // ID fixo — garantia de documento único

// ── ESTADO DA APLICAÇÃO ─────────────────────────────────────

const state = {
  products: [],
  activeFilter: "Todos",
  editingId: null,
  isLoggedIn: false,
  logoClicks: 0,
  logoTimer: null,
  pendingImageBase64: null,
  pendingImagePreview: null,
  firestoreUnsubscribe: null,
  noticeUnsubscribe: null,
  currentNotice: null, // { text, visible } | null
};

// ── FIRESTORE — LISTENER EM TEMPO REAL ──────────────────────

/**
 * Abre um listener em tempo real no Firestore.
 * Qualquer adição, edição ou remoção atualiza a vitrine automaticamente.
 */
function startProductsListener() {
  const q = query(
    collection(db, PRODUCTS_COLLECTION),
    orderBy("createdAt", "desc"),
  );

  state.firestoreUnsubscribe = onSnapshot(
    q,
    (snapshot) => {
      state.products = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      }));

      renderVitrine();
      if (state.isLoggedIn) renderAdminList();
    },
    (error) => {
      console.error("Firestore listener error:", error);
      notify("Erro ao carregar produtos. Verifique a conexão.", "error");
    },
  );
}

// ── FIRESTORE — AVISO (documento único) ─────────────────────

/**
 * Listener em tempo real no documento único de aviso.
 * Atualiza o banner público e o painel admin automaticamente.
 */
function startNoticeListener() {
  const noticeRef = doc(db, NOTICES_COLLECTION, NOTICE_DOC_ID);

  state.noticeUnsubscribe = onSnapshot(noticeRef, (snap) => {
    if (snap.exists()) {
      state.currentNotice = snap.data();
    } else {
      state.currentNotice = null;
    }
    renderNoticeBanner();
    if (state.isLoggedIn) syncNoticeAdminForm();
  });
}

async function saveNotice(text) {
  const noticeRef = doc(db, NOTICES_COLLECTION, NOTICE_DOC_ID);
  // setDoc com merge:false substitui qualquer aviso anterior — garante 1 único
  await setDoc(noticeRef, {
    text: text,
    visible: true,
    updatedAt: serverTimestamp(),
  });
}

async function deleteNotice() {
  await deleteDoc(doc(db, NOTICES_COLLECTION, NOTICE_DOC_ID));
}

// ── BANNER DE AVISO (público) ────────────────────────────────

function renderNoticeBanner() {
  const banner = document.getElementById("notice-banner");
  if (!banner) return;

  const notice = state.currentNotice;

  if (notice && notice.text && notice.visible) {
    banner.textContent = notice.text;
    banner.classList.add("visible");
  } else {
    banner.classList.remove("visible");
    banner.textContent = "";
  }

  // Ajusta a variável CSS com a altura real do header (72px + banner se visível)
  requestAnimationFrame(() => {
    const h = document.getElementById("site-header")?.offsetHeight ?? 72;
    document.documentElement.style.setProperty("--header-h", h + "px");
  });
}

// ── PAINEL ADMIN — SEÇÃO DE AVISO ───────────────────────────

function syncNoticeAdminForm() {
  const textarea = document.getElementById("notice-text");
  const deleteBtn = document.getElementById("btn-delete-notice");
  const saveBtn = document.getElementById("btn-save-notice");

  if (!textarea) return;

  if (state.currentNotice && state.currentNotice.text) {
    textarea.value = state.currentNotice.text;
    deleteBtn.style.display = "inline-flex";
    saveBtn.textContent = "Atualizar aviso";
  } else {
    textarea.value = "";
    deleteBtn.style.display = "none";
    saveBtn.textContent = "Publicar aviso";
  }
}

window.saveNoticeAdmin = async function () {
  const textarea = document.getElementById("notice-text");
  const text = textarea ? textarea.value.trim() : "";

  if (!text) {
    notify("Digite o texto do aviso antes de publicar.", "error");
    return;
  }

  const saveBtn = document.getElementById("btn-save-notice");
  saveBtn.disabled = true;
  saveBtn.textContent = "Salvando...";

  try {
    await saveNotice(text);
    notify("Aviso publicado com sucesso!", "success");
  } catch (err) {
    console.error("saveNotice error:", err);
    notify("Erro ao salvar o aviso. Tente novamente.", "error");
  } finally {
    saveBtn.disabled = false;
    syncNoticeAdminForm();
  }
};

window.deleteNoticeAdmin = async function () {
  if (!confirm("Deseja remover o aviso do site?")) return;

  try {
    await deleteNotice();
    notify("Aviso removido.", "success");
  } catch (err) {
    console.error("deleteNotice error:", err);
    notify("Erro ao remover o aviso.", "error");
  }
};



/**
 * Salva um produto novo no Firestore.
 * A imagem já chega comprimida em base64 via state.pendingImageBase64.
 * @param {{ title, category, price, desc }} data
 */
async function addProductToFirestore(data) {
  await addDoc(collection(db, PRODUCTS_COLLECTION), {
    title: data.title,
    category: data.category,
    price: data.price,
    desc: data.desc,
    imageBase64: state.pendingImageBase64 ?? null,
    createdAt: serverTimestamp(),
  });
}

/**
 * Atualiza um produto existente no Firestore.
 * Se houver nova imagem pendente, substitui; caso contrário mantém a anterior.
 * @param {string} id
 * @param {{ title, category, price, desc }} data
 */
async function updateProductInFirestore(id, data) {
  const existing = state.products.find((p) => p.id === id);
  const imageBase64 = state.pendingImageBase64 ?? existing?.imageBase64 ?? null;

  await updateDoc(doc(db, PRODUCTS_COLLECTION, id), {
    title: data.title,
    category: data.category,
    price: data.price,
    desc: data.desc,
    imageBase64,
  });
}

/**
 * Remove um produto do Firestore pelo id.
 * @param {string} id
 */
async function deleteProductFromFirestore(id) {
  await deleteDoc(doc(db, PRODUCTS_COLLECTION, id));
}

// ── COMPRESSÃO DE IMAGEM ─────────────────────────────────────

/**
 * Recebe um File de imagem, redimensiona para no máximo IMAGE_MAX_DIMENSION px
 * e comprime para JPEG com IMAGE_QUALITY via Canvas API.
 * Retorna uma string base64 (data URL).
 *
 * @param {File} file
 * @returns {Promise<string>} data URL comprimida
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objUrl);

      // Calcula as dimensões mantendo a proporção original
      let { width, height } = img;
      if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
        if (width >= height) {
          height = Math.round((height / width) * IMAGE_MAX_DIMENSION);
          width = IMAGE_MAX_DIMENSION;
        } else {
          width = Math.round((width / height) * IMAGE_MAX_DIMENSION);
          height = IMAGE_MAX_DIMENSION;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      canvas.getContext("2d").drawImage(img, 0, 0, width, height);

      resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
    };

    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      reject(new Error("Falha ao carregar imagem para compressão."));
    };

    img.src = objUrl;
  });
}

// ── UTILITÁRIOS ─────────────────────────────────────────────

/**
 * Escapa caracteres HTML para evitar XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(str).replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * Exibe uma notificação temporária no canto da tela.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
function notify(message, type = "info") {
  const el = document.createElement("div");
  el.className = `notif notif--${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/**
 * Bloqueia ou desbloqueia o botão de salvar durante operações async.
 * @param {boolean} loading
 */
function setFormLoading(loading) {
  const btn = document.getElementById("btn-save-product");
  btn.disabled = loading;
  btn.textContent = loading
    ? "Salvando..."
    : state.editingId
      ? "Salvar alterações"
      : "Adicionar produto";
}

// ── SVG UTILITÁRIOS ─────────────────────────────────────────

function glassesIconSvg() {
  return `<svg viewBox="0 0 64 32" xmlns="http://www.w3.org/2000/svg"
    style="width:64px;height:32px;stroke:#00a9ce;fill:none;stroke-width:2">
    <rect x="2"  y="4" width="24" height="22" rx="7"/>
    <rect x="38" y="4" width="24" height="22" rx="7"/>
    <path d="M26 15 Q32 11 38 15"/>
    <line x1="2"  y1="13" x2="-4" y2="12"/>
    <line x1="62" y1="13" x2="68" y2="12"/>
  </svg>`;
}

function glassesIconSmallSvg() {
  return `<svg viewBox="0 0 24 24"
    style="width:28px;height:28px;stroke:#ccc;fill:none;stroke-width:1.5">
    <rect x="2"  y="7" width="8" height="7" rx="3"/>
    <rect x="14" y="7" width="8" height="7" rx="3"/>
    <path d="M10 10.5h4"/>
  </svg>`;
}

// ── VITRINE (seção pública) ──────────────────────────────────

/**
 * Renderiza os cards de produto conforme o filtro ativo.
 */
function renderVitrine() {
  const grid = document.getElementById("products-grid");
  const filtered =
    state.activeFilter === "Todos"
      ? state.products
      : state.products.filter((p) => p.category === state.activeFilter);

  updateBadgeCount();
  updateCategoryCounts();

  if (filtered.length === 0) {
    grid.innerHTML = buildEmptyState();
    return;
  }

  grid.innerHTML = filtered
    .map((product, index) => buildProductCard(product, index))
    .join("");
}

function updateBadgeCount() {
  const badge = document.getElementById("badge-count");
  const count = state.products.length;
  badge.textContent = `${count} ${count === 1 ? "item" : "itens"}`;
}

function updateCategoryCounts() {
  const categories = {
    Armação: "count-armacao",
    "Lente de Grau": "count-lente",
    "Óculos Solar": "count-solar",
    Acessórios: "count-acessorios",
  };

  for (const [cat, id] of Object.entries(categories)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const count = state.products.filter((p) => p.category === cat).length;
    el.textContent = `${count} ${count === 1 ? "produto" : "produtos"}`;
  }
}

function buildEmptyState() {
  const msg =
    state.activeFilter === "Todos"
      ? "Nenhum produto na vitrine ainda.<br>Acesse o painel do administrador para adicionar itens."
      : "Nenhum produto nesta categoria.";

  return `
    <div class="empty-state">
      <svg viewBox="0 0 24 24">
        <rect x="2"  y="8" width="8" height="8" rx="3"/>
        <rect x="14" y="8" width="8" height="8" rx="3"/>
        <path d="M10 12h4"/>
      </svg>
      <p>${msg}</p>
    </div>`;
}

function buildProductCard(product, index) {
  // imageBase64 é a data URL comprimida armazenada no campo do Firestore
  const image = product.imageBase64
    ? `<img src="${product.imageBase64}"
         alt="${escapeHtml(product.title)}"
         onerror="this.parentElement.innerHTML='<div class=&quot;product-placeholder&quot;>${glassesIconSvg().replace(/"/g, "&quot;")}</div>'">`
    : `<div class="product-placeholder">${glassesIconSvg()}</div>`;

  const description = product.desc
    ? `<p class="product-card__description">${escapeHtml(product.desc)}</p>`
    : "";

  return `
    <article class="product-card" style="animation-delay:${index * 0.07}s">
      <span class="product-card__badge">${escapeHtml(product.category)}</span>
      <div class="product-card__image">${image}</div>
      <div class="product-card__info">
        <h3 class="product-card__title">${escapeHtml(product.title)}</h3>
        ${description}
        <div class="product-card__footer">
          <div class="product-card__price">
            <small>R$</small> ${escapeHtml(product.price)}
          </div>
          <button class="btn-ask"
          style="color:white" target="_blank" rel="noopener noreferrer"
          onclick="openInterestModal('${product.id}')">
              Tenho interesse
          </button>
        </div>
      </div>
    </article>`;
}

// ── FILTROS DA VITRINE ───────────────────────────────────────

/**
 * Aplica filtro por categoria e rola até a vitrine.
 * @param {string} category
 */
function filterProducts(category) {
  state.activeFilter = category;

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    const isActive =
      btn.textContent.trim() === category ||
      (category === "Todos" && btn.textContent.trim() === "Todos");
    btn.classList.toggle("active", isActive);
  });

  renderVitrine();
  document.getElementById("vitrine").scrollIntoView({ behavior: "smooth" });
}

// ── ACESSO ADMIN (5 cliques discretos no logo) ───────────────

/**
 * Detecta 5 cliques rápidos no logo para abrir o painel admin.
 * @param {MouseEvent} event
 */
function handleLogoClick(event) {
  state.logoClicks++;

  if (state.logoTimer) clearTimeout(state.logoTimer);

  if (state.logoClicks >= LOGO_CLICKS_NEEDED) {
    event.preventDefault();
    state.logoClicks = 0;
    openAdmin();
    return;
  }

  state.logoTimer = setTimeout(() => {
    state.logoClicks = 0;
  }, LOGO_CLICK_TIMEOUT);
}

// ── PAINEL ADMIN ─────────────────────────────────────────────

function openAdmin() {
  document.getElementById("admin-overlay").classList.add("open");
  document.body.classList.add("admin-open");
}

function closeAdmin() {
  document.getElementById("admin-overlay").classList.remove("open");
  document.body.classList.remove("admin-open");
}

function handleOverlayClick(event) {
  if (event.target === document.getElementById("admin-overlay")) {
    closeAdmin();
  }
}

function renderAdminView() {
  const loginView = document.getElementById("admin-login-view");
  const contentView = document.getElementById("admin-content-view");

  loginView.style.display = state.isLoggedIn ? "none" : "block";
  contentView.style.display = state.isLoggedIn ? "flex" : "none";

  if (state.isLoggedIn) renderAdminList();
}

// ── AUTENTICAÇÃO ─────────────────────────────────────────────

function initAuthListener() {
  onAuthStateChanged(auth, (user) => {
    state.isLoggedIn = !!user;
    renderAdminView();
  });
}

async function doLogin() {
  const email = document.getElementById("l-user").value.trim();
  const password = document.getElementById("l-pass").value;
  const errorEl = document.getElementById("login-error");
  const btn = document.querySelector("#admin-login-view .btn-save");

  if (!email || !password) {
    errorEl.classList.add("visible");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Entrando...";

  try {
    await signInWithEmailAndPassword(auth, email, password);
    errorEl.classList.remove("visible");
  } catch (error) {
    console.error(error);
    errorEl.classList.add("visible");
  }

  btn.disabled = false;
  btn.textContent = "Entrar";
}

function doLogout() {
  signOut(auth);
  closeAdmin();
}

// ── LISTA DE PRODUTOS NO ADMIN ───────────────────────────────

function renderAdminList() {
  document.getElementById("admin-count").textContent = state.products.length;
  const list = document.getElementById("admin-list");

  if (state.products.length === 0) {
    list.innerHTML =
      '<p style="font-size:.82rem;color:var(--gray-text);text-align:center;padding:1.5rem">Nenhum produto cadastrado.</p>';
    return;
  }

  list.innerHTML = state.products.map(buildAdminItem).join("");
}

function buildAdminItem(product) {
  const thumb = product.imageBase64
    ? `<img src="${product.imageBase64}" alt="" onerror="this.src=''">`
    : glassesIconSmallSvg();

  return `
    <div class="admin-item">
      <div class="admin-item__thumb">${thumb}</div>
      <div class="admin-item__info">
        <div class="admin-item__name">${escapeHtml(product.title)}</div>
        <div class="admin-item__category">${escapeHtml(product.category)}</div>
      </div>
      <div class="admin-item__price">R$ ${escapeHtml(product.price)}</div>
      <div class="admin-item__actions">
        <button class="btn-icon btn-icon--edit"
          onclick="editProduct('${product.id}')" title="Editar">
          <svg viewBox="0 0 24 24">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-icon btn-icon--delete"
          onclick="deleteProduct('${product.id}')" title="Remover">
          <svg viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
    </div>`;
}

// ── UPLOAD & COMPRESSÃO DE IMAGEM ────────────────────────────

/**
 * Captura o arquivo do input e inicia o pipeline de validação + compressão.
 * @param {Event} event
 */
function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  applyImageFile(file);
}

/**
 * Valida, comprime e armazena a imagem em state.pendingImageBase64.
 * Exibe preview imediato via object URL enquanto a compressão ocorre.
 * @param {File} file
 */
async function applyImageFile(file) {
  if (!file.type.startsWith("image/")) {
    notify(
      "Selecione um arquivo de imagem válido (JPG, PNG ou WEBP).",
      "error",
    );
    return;
  }

  if (file.size > MAX_IMAGE_BYTES) {
    notify("A imagem não pode ultrapassar 5 MB.", "error");
    return;
  }

  // Mostra preview imediato enquanto processa em background
  const previewUrl = URL.createObjectURL(file);
  showImagePreview(previewUrl);

  try {
    const compressed = await compressImage(file);
    state.pendingImageBase64 = compressed;

    // Substitui o preview pelo base64 final e libera o object URL
    showImagePreview(compressed);
    URL.revokeObjectURL(previewUrl);
  } catch (error) {
    notify("Erro ao processar a imagem. Tente outro arquivo.", "error");
    URL.revokeObjectURL(previewUrl);
    clearImageUpload();
  }
}

/**
 * Exibe a imagem na área de preview do formulário.
 * @param {string} src — object URL temporária ou data URL base64
 */
function showImagePreview(src) {
  document.getElementById("img-upload-placeholder").style.display = "none";
  document.getElementById("img-upload-preview").src = src;
  document.getElementById("img-upload-preview").style.display = "block";
  document.getElementById("btn-img-clear").style.display = "inline-block";
}

/**
 * Descarta a imagem pendente e restaura a área de upload ao estado inicial.
 */
function clearImageUpload() {
  state.pendingImageBase64 = null;

  document.getElementById("a-img-file").value = "";
  document.getElementById("img-upload-preview").src = "";
  document.getElementById("img-upload-preview").style.display = "none";
  document.getElementById("img-upload-placeholder").style.display = "flex";
  document.getElementById("btn-img-clear").style.display = "none";
}

/**
 * Inicializa drag-and-drop na área de upload.
 */
function initImageUploadDragDrop() {
  const area = document.getElementById("img-upload-area");
  if (!area) return;

  area.addEventListener("dragover", (e) => {
    e.preventDefault();
    area.classList.add("drag-over");
  });

  area.addEventListener("dragleave", () => {
    area.classList.remove("drag-over");
  });

  area.addEventListener("drop", (e) => {
    e.preventDefault();
    area.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) applyImageFile(file);
  });
}

// ── CRUD DE PRODUTOS ─────────────────────────────────────────

async function saveProduct() {
  const title = document.getElementById("a-title").value.trim();
  const category = document.getElementById("a-category").value;
  const price = document.getElementById("a-price").value.trim();
  const desc = document.getElementById("a-desc").value.trim();

  if (!title || !category || !price) {
    notify("Preencha os campos obrigatórios (*)", "error");
    return;
  }

  setFormLoading(true);

  try {
    if (state.editingId) {
      await updateProductInFirestore(state.editingId, {
        title,
        category,
        price,
        desc,
      });
      notify("Produto atualizado!", "success");
      cancelEdit();
    } else {
      await addProductToFirestore({ title, category, price, desc });
      notify("Produto adicionado!", "success");
      clearAdminForm();
    }
  } catch (error) {
    console.error("saveProduct error:", error);
    notify("Erro ao salvar o produto. Tente novamente.", "error");
  } finally {
    setFormLoading(false);
  }
}

function editProduct(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;

  state.editingId = id;
  state.pendingImageBase64 = null; // reset — mantém imagem existente até nova seleção

  document.getElementById("a-title").value = product.title;
  document.getElementById("a-category").value = product.category;
  document.getElementById("a-price").value = product.price;
  document.getElementById("a-desc").value = product.desc || "";

  if (product.imageBase64) {
    showImagePreview(product.imageBase64);
  } else {
    clearImageUpload();
  }

  document.getElementById("form-mode-label").textContent =
    "✏️ Editando produto";
  document.getElementById("btn-save-product").textContent = "Salvar alterações";
  document.getElementById("btn-cancel-edit").style.display = "block";
  document.getElementById("admin-body").scrollTop = 0;
}

function cancelEdit() {
  state.editingId = null;
  clearAdminForm();
  document.getElementById("form-mode-label").textContent =
    "+ Adicionar novo produto";
  document.getElementById("btn-save-product").textContent = "Adicionar produto";
  document.getElementById("btn-cancel-edit").style.display = "none";
}

async function deleteProduct(id) {
  if (!confirm("Deseja remover este produto da vitrine?")) return;

  try {
    await deleteProductFromFirestore(id);
    notify("Produto removido.", "success");
  } catch (error) {
    console.error("deleteProduct error:", error);
    notify("Erro ao remover o produto. Tente novamente.", "error");
  }
}

function clearAdminForm() {
  ["a-title", "a-category", "a-price", "a-desc"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  clearImageUpload();
}


// ── MENU MOBILE ──────────────────────────────────────────────

function toggleMobileNav() {
  const nav = document.getElementById("main-nav");
  const btn = document.querySelector(".menu-toggle");
  const isOpen = nav.dataset.open === "true";

  if (isOpen) {
    nav.removeAttribute("style");
    nav.dataset.open = "false";
    btn.setAttribute("aria-expanded", "false");
  } else {
    Object.assign(nav.style, {
      display: "flex",
      flexDirection: "column",
      position: "fixed",
      top: "72px",
      left: "0",
      right: "0",
      background: "var(--white)",
      padding: "1.5rem 5vw",
      borderTop: "1px solid #eee",
      gap: "1.25rem",
      boxShadow: "0 8px 24px rgba(0,0,0,.1)",
      zIndex: "99",
    });
    nav.dataset.open = "true";
    btn.setAttribute("aria-expanded", "true");
  }
}

// ── MODAL DE INTERESSE ───────────────────────────────────────

const WHATSAPP_NUMBER = '5511982604460'; // DDI + DDD + número, sem símbolos
 
/**
 * Abre o modal preenchido com os dados do produto selecionado
 * e monta o link do WhatsApp com o nome do produto na mensagem.
 * @param {string} productId
 */
function openInterestModal(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;
 
  // Imagem
  const imageEl = document.getElementById('modal-product-image');
  imageEl.innerHTML = product.imageBase64
    ? `<img src="${product.imageBase64}" alt="${escapeHtml(product.title)}">`
    : glassesIconSvg();
 
  // Textos
  document.getElementById('modal-product-category').textContent = product.category;
  document.getElementById('modal-product-title').textContent    = product.title;
  document.getElementById('modal-product-price').textContent    = `R$ ${product.price}`;
 
  // Descrição — ocultada quando vazia
  const descEl = document.getElementById('modal-product-description');
  if (product.desc) {
    descEl.textContent = product.desc;
    descEl.classList.add('visible');
  } else {
    descEl.textContent = '';
    descEl.classList.remove('visible');
  }
 
  // Link do WhatsApp com nome do produto interpolado na mensagem
  const message = `Olá! Vim pelo site e tenho interesse no produto: *${product.title}*`;
  document.getElementById('modal-whatsapp-btn').href =
    `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
 
  document.getElementById('modal-contact').classList.add('open');
  document.body.style.overflow = 'hidden';
}
 
function closeInterestModal() {
  document.getElementById('modal-contact').classList.remove('open');
  document.body.style.overflow = '';
}
 
function handleModalOverlayClick(event) {
  if (event.target === document.getElementById('modal-contact')) {
    closeInterestModal();
  }
}
 
// ── EXPOR FUNÇÕES AO ESCOPO GLOBAL ──────────────────────────
// Necessário pois o HTML usa onclick="..." e o módulo ES é isolado

Object.assign(window, {
  handleLogoClick,
  toggleMobileNav,
  filterProducts,
  handleOverlayClick,
  closeAdmin,
  doLogin,
  doLogout,
  saveProduct,
  editProduct,
  cancelEdit,
  deleteProduct,
  handleImageUpload,
  clearImageUpload,
  handleModalOverlayClick,
  closeInterestModal,
  openInterestModal
});

// ── INICIALIZAÇÃO ────────────────────────────────────────────

function init() {
  startProductsListener();
  startNoticeListener();
  initImageUploadDragDrop();
  initAuthListener();
}

document.addEventListener("DOMContentLoaded", init);