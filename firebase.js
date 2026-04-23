/* ============================================================
   InVision Ótica Personalizada — Configuração Firebase
   ============================================================
   Substitua os valores abaixo pelas credenciais do seu projeto.
   Acesse: https://console.firebase.google.com
   → Seu projeto → Configurações → Adicionar app (Web) → SDK
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBjuaP3loxIkygCefFUiCuqf6ki0im6nDs",
  authDomain: "invisionoptica-e2e46.firebaseapp.com",
  projectId: "invisionoptica-e2e46",
  storageBucket: "invisionoptica-e2e46.firebasestorage.app",
  messagingSenderId: "599569431631",
  appId: "1:599569431631:web:cb2ce85bf4c776ba70fe3a",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);