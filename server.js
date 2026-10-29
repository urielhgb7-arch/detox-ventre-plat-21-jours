const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const HMAC_SECRET = process.env.ORDER_HMAC_SECRET || 'maketou_andromeda_hmac_secret_2026_x99';

// Stockage persistant léger JSON pour les commandes et l'idempotence
const DB_FILE = process.env.VERCEL 
  ? path.join('/tmp', 'orders_db.json') 
  : path.join(__dirname, 'orders_db.json');
let ordersDB = {};

function readDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      ordersDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      ordersDB = ordersDB || {};
    }
  }
  return ordersDB;
}

readDB();

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(ordersDB, null, 2), 'utf8');
  } catch (err) {
    console.error('Erreur sauvegarde base de données:', err.message);
  }
}

// Fonction de hachage SHA-256 pour Meta CAPI & TikTok (minuscules normalisées trim)
function hashMetaField(value) {
  if (!value) return '';
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ============================================================================
// SÉCURITÉ CRYPTOGRAPHIQUE : JETONS SHA-256 HMAC INFALSIFIABLES
// ============================================================================

// Génère un jeton HMAC SHA-256 unique associé de manière stricte au panier payé
function generatePaidToken(cartId) {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`PAID_CART:${cartId}:completed`)
    .digest('hex');
}

// Vérifie si le jeton fourni correspond exactement au hash cryptographique du panier payé
function verifyPaidToken(cartId, token) {
  if (!cartId || !token) return false;
  try {
    const expected = generatePaidToken(cartId);
    if (expected.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch (e) {
    return false;
  }
}

// Token de téléchargement temporaire (valable 4 heures)
function generateDownloadToken(cartId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const data = `${cartId}:${timestamp}`;
  const hmac = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`DL:${data}`)
    .digest('hex');
  return Buffer.from(`${data}:${hmac}`).toString('base64url');
}

function verifyDownloadToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return false;
    const [cartId, timestampStr, hmac] = parts;
    const timestamp = parseInt(timestampStr, 10);
    const now = Math.floor(Date.now() / 1000);
    // Valide pendant 4 heures (14400 secondes)
    if (isNaN(timestamp) || now - timestamp > 14400 || timestamp > now + 300) {
      return false;
    }
    const expectedHmac = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(`DL:${cartId}:${timestamp}`)
      .digest('hex');
    if (expectedHmac.length !== hmac.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(hmac));
  } catch (e) {
    return false;
  }
}

function getCookieFromHeader(header, name) {
  if (!header) return '';
  const match = header.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1].trim()) : '';
}

function clearAuthCookies(res) {
  const cookiesToClear = [
    'paid_token',
    'paid_cart_id',
    'download_token',
    'maketou_sig',
    'maketou_cart_id',
    'maketou_order_id',
    'pending_cart_id',
    'pending_order_id'
  ];
  cookiesToClear.forEach(name => {
    try {
      res.clearCookie(name, { path: '/' });
      res.cookie(name, '', { maxAge: 0, path: '/' });
    } catch (e) {}
  });
}

function formatAfricanPhone(rawPhone) {
  let cleaned = String(rawPhone || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('229')) {
    let national = cleaned.slice(3);
    if (national.length === 8) {
      national = '01' + national;
    } else if (national.length === 9 && national.startsWith('1')) {
      national = '0' + national;
    }
    return '+229' + national;
  }
  if (cleaned.startsWith('225')) {
    let national = cleaned.slice(3);
    if (national.length === 8) {
      national = '0' + national;
    }
    return '+225' + national;
  }
  if (cleaned.startsWith('221')) {
    return '+221' + cleaned.slice(3);
  }
  if (cleaned.length === 10 && (cleaned.startsWith('01') || cleaned.startsWith('02') || cleaned.startsWith('03'))) {
    return '+229' + cleaned;
  }
  if (cleaned.length === 8 && (cleaned.startsWith('9') || cleaned.startsWith('6') || cleaned.startsWith('5') || cleaned.startsWith('4'))) {
    return '+22901' + cleaned;
  }
  if (cleaned.length === 10 && (cleaned.startsWith('05') || cleaned.startsWith('07') || cleaned.startsWith('01'))) {
    return '+225' + cleaned;
  }
  return '+' + cleaned;
}

// ============================================================================
// VÉRIFICATION EN TEMPS RÉEL DU STATUT DU PAIEMENT VIA L'API MAKETOU
// ============================================================================
async function verifyCartPaymentWithMaketou(cartId) {
  if (!cartId) return { paid: false, cart: null, status: 'missing_id' };
  const apiKey = process.env.MAKETOU_API_KEY || 'msk_c650508aa6e29d8d7da5a9c2ea05cd20d081f29a89566fe1e3da0b79c080a4c8';
  const paidStatuses = ['completed', 'paid', 'success', 'successful', 'finished', 'delivered'];

  // Interrogation en direct avec un second essai rapide pour résister à la latence de callback
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`https://api.maketou.net/api/v1/stores/cart/${cartId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 7000
      });
      const cart = res.data?.cart || res.data;
      const status = String(cart?.status || '').toLowerCase();
      console.log(`[Maketou Status Check] Panier ${cartId} -> statut: "${status}" (essai ${attempt})`);
      if (paidStatuses.includes(status)) {
        return { paid: true, cart, status };
      }
    } catch (err) {
      console.warn(`[Maketou Status Check Warning] Panier ${cartId}:`, err.message);
    }
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Vérification de secours dans la base de données locale (ex: mise à jour par Webhook)
  readDB();
  const order = ordersDB[cartId] || Object.values(ordersDB).find(o => o.cartId === cartId);
  if (order && paidStatuses.includes(String(order.status).toLowerCase())) {
    return { paid: true, cart: null, status: order.status, fromDb: true };
  }

  return { paid: false, cart: null, status: 'unpaid' };
}

// ============================================================================
// HELPER CAPI : ENVOI ATOMIQUE PURCHASE DÉDOUBLÉ (SERVEUR META V21)
// ============================================================================
async function sendMetaCapiPurchaseOnce(order, clientIp, clientUserAgent) {
  if (!order || order.purchaseTracked || order.purchase_tracked === 1) return;
  order.purchaseTracked = true;
  order.purchase_tracked = 1;
  order.trackedAt = new Date().toISOString();
  saveDB();

  const eventId = `pur_${order.cartId || order.orderId}`;
  const pixelId = process.env.META_PIXEL_ID || '1697536258749199';
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v21.0';

  if (!accessToken) {
    console.warn('[Meta CAPI Warning] META_CAPI_ACCESS_TOKEN non configuré. Événement ignoré.');
    return;
  }

  const userData = {
    client_ip_address: clientIp || order.clientIp || undefined,
    client_user_agent: clientUserAgent || order.clientUserAgent || undefined
  };
  if (order.email) userData.em = [hashMetaField(order.email)];
  if (order.phone) userData.ph = [hashMetaField(order.phone)];
  if (order.firstName) userData.fn = [hashMetaField(order.firstName)];
  if (order.lastName) userData.ln = [hashMetaField(order.lastName)];
  if (order.fbp) userData.fbp = order.fbp;
  if (order.fbc) userData.fbc = order.fbc;

  const eventPayload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: order.eventSourceUrl || 'https://detox-21-jours.aurakadre.com/remerciement',
        action_source: 'website',
        user_data: userData,
        custom_data: {
          currency: 'XOF',
          value: order.amount || 2500,
          content_type: 'product',
          content_ids: ['57b7e371-6c0c-4262-bc58-e4cfe48da606'],
          content_name: 'Programme Détox & Ventre Plat en 21 Jours',
          num_items: 1,
          order_id: order.orderId || order.cartId
        }
      }
    ]
  };

  try {
    const res = await axios.post(
      `https://graph.facebook.com/${apiVersion}/${pixelId}/events?access_token=${accessToken}`,
      eventPayload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    console.log(`[Meta CAPI] Événement Purchase envoyé avec succès (${eventId}) :`, res.data);
  } catch (err) {
    console.warn('[Meta CAPI Warning]', err.response?.data?.error?.message || err.message);
  }
}

// ============================================================================
// HELPER TIKTOK EVENTS API : ENVOI SERVEUR COMPLETEPAYMENT (CONVERSIONS API)
// ============================================================================
async function sendTikTokEventsApiPurchaseOnce(order, clientIp, clientUserAgent) {
  if (!order || order.tiktokTracked || order.tiktok_tracked === 1) return;
  order.tiktokTracked = true;
  order.tiktok_tracked = 1;
  order.tiktokTrackedAt = new Date().toISOString();
  saveDB();

  const eventId = `pur_${order.cartId || order.orderId}`;
  const pixelId = process.env.TIKTOK_PIXEL_ID || 'DBHO283C77U8I4RJ1KK0';
  const accessToken = process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN || '768bb41690ef8c180f32ffa08d411063236a87d2';

  const userObj = {
    ip: clientIp || order.clientIp || undefined,
    user_agent: clientUserAgent || order.clientUserAgent || undefined
  };
  if (order.email) userObj.email = hashMetaField(order.email);
  if (order.phone) userObj.phone = hashMetaField(order.phone);
  if (order.ttp) userObj.ttp = order.ttp;
  if (order.ttclid) userObj.ttclid = order.ttclid;

  const tiktokPayload = {
    event_source: 'web',
    event_source_id: pixelId,
    data: [
      {
        event: 'CompletePayment',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        user: userObj,
        properties: {
          contents: [
            {
              content_id: order.productDocumentId || process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606',
              content_type: 'product',
              content_name: 'Programme Détox & Ventre Plat en 21 Jours',
              quantity: 1,
              price: order.amount || 2500
            }
          ],
          value: order.amount || 2500,
          currency: 'XOF'
        }
      }
    ]
  };

  try {
    const ttRes = await axios.post(
      'https://business-api.tiktok.com/open_api/v1.3/event/track/',
      tiktokPayload,
      {
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );
    console.log(`[TikTok Events API] Événement CompletePayment envoyé avec succès (${eventId}) :`, ttRes.data?.message || 'OK');
  } catch (ttErr) {
    console.warn('[TikTok Events API Warning]', ttErr.response?.data?.message || ttErr.message);
  }
}

// Configuration Express
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// ROUTES D'ACCÈS À LA PAGE DE REMERCIEMENT ET CONFIRMATION D'ACHAT
// (Enregistrées AVANT express.static pour empêcher tout bypass statique)
// ============================================================================

async function handleThankYouAccess(req, res) {
  const isSetupPixel = req.query.setup_pixel === '1' || req.query.setup === '1';
  if (isSetupPixel) {
    return res.sendFile(path.join(__dirname, 'public', 'remerciement.html'));
  }

  const cookieHeader = req.headers.cookie || '';
  const queryCartId = req.query.cartId;
  const queryOrderId = req.query.orderId;
  const queryToken = req.query.token;

  const cookiePaidToken = getCookieFromHeader(cookieHeader, 'paid_token');
  const cookiePaidCartId = getCookieFromHeader(cookieHeader, 'paid_cart_id');
  const cookiePendingCartId = getCookieFromHeader(cookieHeader, 'pending_cart_id') || getCookieFromHeader(cookieHeader, 'maketou_cart_id');
  const cookiePendingOrderId = getCookieFromHeader(cookieHeader, 'pending_order_id') || getCookieFromHeader(cookieHeader, 'maketou_order_id');

  // Identifier le panier
  let cartId = queryCartId || cookiePaidCartId || cookiePendingCartId || '';
  const orderId = queryOrderId || cookiePendingOrderId || '';

  readDB();
  if (!cartId && orderId) {
    const order = ordersDB[orderId] || Object.values(ordersDB).find(o => o.orderId === orderId);
    if (order && order.cartId) {
      cartId = order.cartId;
    }
  }

  // 1. Si aucun cartId n'est fourni : blocage absolu et redirection vers l'accueil
  if (!cartId) {
    console.warn(`[Security Alert] Accès direct refusé à ${req.path} (aucun panier fourni). Redirection.`);
    clearAuthCookies(res);
    return res.redirect('/?access_denied=1');
  }

  // 2. Si un jeton SHA-256 HMAC valide est déjà présent, vérifier sa signature cryptographique
  const candidateToken = queryToken || cookiePaidToken;
  if (candidateToken && verifyPaidToken(cartId, candidateToken)) {
    console.log(`[Security OK] Accès autorisé via jeton SHA-256 valide pour cartId: ${cartId}`);
    res.cookie('paid_token', candidateToken, { maxAge: 14400000, httpOnly: true, sameSite: 'lax', path: '/' });
    res.cookie('paid_cart_id', cartId, { maxAge: 14400000, httpOnly: false, sameSite: 'lax', path: '/' });
    const downloadToken = generateDownloadToken(cartId);
    res.cookie('download_token', downloadToken, { maxAge: 14400000, httpOnly: false, sameSite: 'lax', path: '/' });

    // Si le token n'était pas dans la query de l'URL, rediriger avec le token dans l'URL pour clarté
    if (!req.query.token) {
      return res.redirect(`/remerciement?cartId=${encodeURIComponent(cartId)}&token=${encodeURIComponent(candidateToken)}`);
    }

    return res.sendFile(path.join(__dirname, 'public', 'remerciement.html'));
  }

  // 3. Pas de jeton valide : vérifier en temps réel auprès de l'API Maketou si le paiement est COMPLETED
  console.log(`[Security Check] Vérification en temps réel du paiement Maketou pour le panier ${cartId}...`);
  const verification = await verifyCartPaymentWithMaketou(cartId);

  if (!verification.paid) {
    console.warn(`[Security Alert] Accès refusé : Panier ${cartId} NON COMPLÉTÉ (statut: "${verification.status}"). Purge et redirection.`);
    clearAuthCookies(res);
    return res.redirect('/?access_denied=1');
  }

  // 4. Paiement vérifié avec succès sur Maketou !
  console.log(`[Security Success] Paiement vérifié pour le panier ${cartId} ! Génération du jeton SHA-256 unique...`);
  const paidToken = generatePaidToken(cartId);
  const downloadToken = generateDownloadToken(cartId);

  // Mise à jour de la commande en base locale
  let order = ordersDB[cartId] || Object.values(ordersDB).find(o => o.cartId === cartId);
  if (!order) {
    const c = verification.cart;
    order = {
      orderId: orderId || ('ORD_' + cartId.slice(0, 12)),
      cartId: cartId,
      email: c?.customerInfo?.email || c?.email || '',
      phone: c?.customerInfo?.phone || c?.phone || '',
      firstName: c?.customerInfo?.firstName || c?.firstName || 'Client',
      lastName: c?.customerInfo?.lastName || c?.lastName || '',
      productDocumentId: c?.productDocumentId || process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606',
      amount: 2500,
      currency: 'XOF',
      status: 'completed',
      purchaseTracked: false,
      purchase_tracked: 0,
      paidToken: paidToken
    };
    ordersDB[cartId] = order;
  } else {
    order.status = 'completed';
    order.paidToken = paidToken;
  }
  saveDB();

  // Envoi dédoublé des conversions serveur CAPI Meta & TikTok
  if (!order.purchaseTracked && order.purchase_tracked !== 1) {
    await sendMetaCapiPurchaseOnce(
      order,
      req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      req.headers['user-agent']
    );
    await sendTikTokEventsApiPurchaseOnce(
      order,
      req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      req.headers['user-agent']
    );
  }

  // Positionner les cookies sécurisés
  res.cookie('paid_token', paidToken, { maxAge: 14400000, httpOnly: true, sameSite: 'lax', path: '/' });
  res.cookie('paid_cart_id', cartId, { maxAge: 14400000, httpOnly: false, sameSite: 'lax', path: '/' });
  res.cookie('download_token', downloadToken, { maxAge: 14400000, httpOnly: false, sameSite: 'lax', path: '/' });

  // Rediriger vers l'URL officielle unique avec token SHA-256
  return res.redirect(`/remerciement?cartId=${encodeURIComponent(cartId)}&token=${encodeURIComponent(paidToken)}`);
}

// Enregistrement des routes de confirmation
app.get('/remerciement', handleThankYouAccess);
app.get('/remerciement.html', handleThankYouAccess);
app.get('/confirmation-achat', handleThankYouAccess);
app.get('/confirmation-achat.html', handleThankYouAccess);
app.get('/verify-purchase', (req, res) => res.redirect('/remerciement'));

// ============================================================================
// ENDPOINT SÉCURISÉ : TÉLÉCHARGEMENT & LECTURE DU GUIDE PDF
// (Le lien Google Drive n'est JAMAIS exposé au client pour une sécurité absolue)
// ============================================================================
async function handleGuideDownload(req, res) {
  try {
    const cookieHeader = req.headers.cookie || '';
    const token = req.query.token || getCookieFromHeader(cookieHeader, 'paid_token');
    const downloadToken = req.query.downloadToken || getCookieFromHeader(cookieHeader, 'download_token');
    const cartId = req.query.cartId || getCookieFromHeader(cookieHeader, 'paid_cart_id') || getCookieFromHeader(cookieHeader, 'maketou_cart_id');
    const isSetupMode = req.query.setup_pixel === '1' || req.query.setup === '1';

    let isAllowed = false;

    if (isSetupMode) {
      isAllowed = true;
    } else if (cartId && token && verifyPaidToken(cartId, token)) {
      isAllowed = true;
    } else if (downloadToken && verifyDownloadToken(downloadToken)) {
      isAllowed = true;
    } else if (cartId) {
      // Vérification Maketou en direct si le token manque
      const verification = await verifyCartPaymentWithMaketou(cartId);
      if (verification.paid) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      console.warn(`[Security Alert] Tentative de téléchargement PDF non autorisé depuis IP: ${req.ip} (cartId: ${cartId || 'none'})`);
      res.status(403);
      return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accès Refusé — Détox 21 Jours</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[#FAFDF7] min-h-screen flex items-center justify-center p-4 font-sans text-slate-800">
  <div class="max-w-md w-full bg-white rounded-3xl shadow-xl p-6 text-center border border-red-200">
    <div class="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-300">
      <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
    </div>
    <h1 class="text-lg font-black text-slate-900 mb-2">Téléchargement Réservé aux Membres</h1>
    <p class="text-xs text-slate-600 mb-5 leading-relaxed">
      L'accès à ce document PDF officiel nécessite une commande avec paiement validé par Mobile Money. Si vous avez déjà payé, veuillez utiliser le lien sécurisé reçu par e-mail ou recharger votre page de confirmation.
    </p>
    <a href="/" class="inline-block w-full py-3.5 bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold text-xs uppercase rounded-xl shadow-lg transition">
      Commander mon guide (2 500 FCFA)
    </a>
  </div>
</body>
</html>`);
    }

    const localPdfPath = path.join(__dirname, 'storage', 'guide_detox_21_jours.pdf');
    const isDownload = req.query.download === '1';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      isDownload
        ? 'attachment; filename="Programme_Detox_Ventre_Plat_21_Jours.pdf"'
        : 'inline; filename="Programme_Detox_Ventre_Plat_21_Jours.pdf"'
    );
    res.setHeader('Cache-Control', 'private, no-transform, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (fs.existsSync(localPdfPath)) {
      const stream = fs.createReadStream(localPdfPath);
      return stream.pipe(res);
    }

    // Secours dynamique via Google Drive si le fichier local n'est pas trouvé (côté serveur uniquement)
    const driveFileId = process.env.GOOGLE_DRIVE_FILE_ID || '1hltSYrpr5EoDWMl5gj7mx2TGGfiu1AlK';
    const driveUrl = `https://drive.google.com/uc?export=download&id=${driveFileId}`;
    console.log('[Download Secure] Streaming de secours depuis Google Drive (interne)...');
    
    const driveRes = await axios.get(driveUrl, {
      responseType: 'stream',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    return driveRes.data.pipe(res);
  } catch (err) {
    console.error('[Download Guide Exception]', err.message);
    return res.status(500).send('Erreur lors du téléchargement du guide. Veuillez réessayer ou contacter le support.');
  }
}

app.get('/api/download/guide', handleGuideDownload);

// Fichiers statiques publics (images, css, videos, etc.)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ============================================================================
// ENDPOINT 1 : CRÉATION DU CHECKOUT MAKETOU RÉEL
// ============================================================================
app.post('/api/checkout/create', async (req, res) => {
  try {
    const { fullName, email, phone, fbp, fbc, ttp, ttclid } = req.body;
    const productDocumentId = process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606';
    const apiKey = process.env.MAKETOU_API_KEY || 'msk_c650508aa6e29d8d7da5a9c2ea05cd20d081f29a89566fe1e3da0b79c080a4c8';

    if (!fullName || !email || !phone) {
      return res.status(400).json({ error: 'Champs obligatoires manquants (Nom, Email, Téléphone).' });
    }

    // 1. Découpage du Nom Complet en firstName + lastName
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || 'Client';
    const lastName = parts.slice(1).join(' ') || 'Acheteur';

    // 2. Nettoyage strict et normalisation du téléphone
    let cleanPhone = formatAfricanPhone(phone);
    const cleanEmail = String(email || '').trim().toLowerCase();

    // 3. Verrou d'idempotence (fenêtre 10 min)
    readDB();
    const timeWindow = Math.floor(Date.now() / (10 * 60 * 1000));
    const idempotencyHash = crypto
      .createHash('sha256')
      .update(`${productDocumentId}_${cleanEmail}_${cleanPhone}_${timeWindow}`)
      .digest('hex');

    const existingOrder = Object.values(ordersDB).find(o => o.idempotencyHash === idempotencyHash);
    if (existingOrder && existingOrder.redirectUrl) {
      console.log(`[Idempotence] Commande réutilisée : ${existingOrder.orderId}`);
      return res.json({
        cartId: existingOrder.cartId,
        redirectUrl: existingOrder.redirectUrl,
        orderId: existingOrder.orderId,
        cached: true
      });
    }

    // 4. Construction de la redirectURL vers notre Sas de remerciement (AUCUN jeton secret n'est donné avant paiement !)
    const orderId = 'ORD_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const baseDomain = (process.env.APP_BASE_URL || (proto + '://' + host)).replace(/\/$/, '');

    let redirectURL = `https://detox-21-jours.aurakadre.com/remerciement?orderId=${encodeURIComponent(orderId)}`;
    let webhookUrl = undefined;
    if (baseDomain.startsWith('https://') && !baseDomain.includes('localhost')) {
      redirectURL = `${baseDomain}/remerciement?orderId=${encodeURIComponent(orderId)}`;
      webhookUrl = `${baseDomain}/api/webhooks/maketou`;
    }

    // 5. Payload officiel Maketou
    const payload = {
      productDocumentId,
      email: cleanEmail,
      firstName,
      lastName,
      phone: cleanPhone,
      redirectURL,
      redirectUrl: redirectURL,
      returnUrl: redirectURL,
      meta: {
        productSlug: 'detox-21-jours',
        internalOrderId: String(orderId),
        source: 'custom_sales_page',
        amountXOF: String(process.env.PRODUCT_PRICE_XOF || '2500'),
        fbp: fbp || '',
        fbc: fbc || ''
      }
    };

    if (webhookUrl) {
      payload.webhookUrl = webhookUrl;
    }

    // 6. Appel direct à l'API Maketou
    console.log('[Maketou API] Envoi du panier vers POST /api/v1/stores/cart/checkout...');
    const maketouRes = await axios.post(
      `${process.env.MAKETOU_API_BASE_URL || 'https://api.maketou.net'}/api/v1/stores/cart/checkout`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const data = maketouRes.data;
    const cart = data.cart || {};
    const redirectUrl = data.redirectUrl;

    if (!redirectUrl) {
      console.error('[Maketou API Error] Aucune redirectUrl retournée:', data);
      return res.status(400).json({ error: 'Erreur Maketou : pas d’URL de paiement retournée', details: data });
    }

    console.log(`[Maketou API] Succès : panier ${cart.id} créé, redirectUrl reçue`);

    // 7. Enregistrement en base locale (statut waiting_payment)
    const orderData = {
      orderId,
      cartId: cart.id || '',
      paymentId: cart.paymentId || '',
      idempotencyHash,
      email: cleanEmail,
      phone: cleanPhone,
      firstName,
      lastName,
      productDocumentId,
      amount: parseInt(process.env.PRODUCT_PRICE_XOF || '2500', 10),
      currency: 'XOF',
      status: cart.status || 'waiting_payment',
      redirectUrl: redirectUrl,
      purchaseTracked: false,
      purchase_tracked: 0,
      createdAt: new Date().toISOString(),
      fbp: fbp || '',
      fbc: fbc || '',
      ttp: ttp || '',
      ttclid: ttclid || '',
      eventSourceUrl: redirectURL,
      clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      clientUserAgent: req.headers['user-agent']
    };

    ordersDB[orderId] = orderData;
    if (cart.id) {
      ordersDB[cart.id] = orderData;
    }
    if (cart.paymentId) {
      ordersDB[cart.paymentId] = orderData;
    }
    saveDB();

    // Nettoyer tous les anciens cookies d'accès non autorisés
    clearAuthCookies(res);

    // Enregistrer uniquement les identifiants de panier en attente de paiement
    if (cart.id) {
      res.cookie('pending_cart_id', cart.id, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });
    }
    res.cookie('pending_order_id', orderId, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });

    return res.status(200).json({
      cartId: cart.id,
      redirectUrl: redirectUrl,
      orderId: orderId,
      paymentId: cart.paymentId || ''
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const errorDetails = err.response?.data || err.message;
    console.error(`[Checkout Exception ${status}]`, errorDetails);
    return res.status(status).json({
      error: 'Erreur lors de la création du panier Maketou.',
      details: errorDetails
    });
  }
});

// ============================================================================
// ENDPOINT 2 : VÉRIFICATION PAIEMENT API POUR LE CLIENT
// ============================================================================
app.get('/api/checkout/verify', async (req, res) => {
  try {
    readDB();
    const { cartId, orderId, paymentId, setup_pixel } = req.query;

    if (setup_pixel === '1') {
      return res.status(200).json({ verified: true, setupMode: true, alreadyTracked: false });
    }

    const cookieHeader = req.headers.cookie || '';
    let targetCartId = cartId || getCookieFromHeader(cookieHeader, 'paid_cart_id') || getCookieFromHeader(cookieHeader, 'pending_cart_id');
    let order = undefined;

    if (targetCartId) {
      order = ordersDB[targetCartId] || Object.values(ordersDB).find(o => o.cartId === targetCartId);
    }
    if (!targetCartId && orderId) {
      order = ordersDB[orderId] || Object.values(ordersDB).find(o => o.orderId === orderId);
      if (order && order.cartId) targetCartId = order.cartId;
    }

    if (!targetCartId) {
      return res.status(200).json({
        verified: false,
        status: 'waiting_info',
        message: 'Panier introuvable'
      });
    }

    const verification = await verifyCartPaymentWithMaketou(targetCartId);
    if (!verification.paid) {
      return res.status(200).json({
        verified: false,
        status: verification.status || 'waiting_payment',
        cartId: targetCartId
      });
    }

    const paidToken = generatePaidToken(targetCartId);

    if (!order) {
      const cart = verification.cart;
      order = {
        cartId: targetCartId,
        orderId: 'ORD_' + targetCartId.slice(0, 12),
        email: cart?.customerInfo?.email || cart?.email || '',
        phone: cart?.customerInfo?.phone || cart?.phone || '',
        firstName: cart?.customerInfo?.firstName || cart?.firstName || '',
        lastName: cart?.customerInfo?.lastName || cart?.lastName || '',
        productDocumentId: cart?.productDocumentId || process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606',
        amount: 2500,
        status: 'completed',
        purchaseTracked: false,
        purchase_tracked: 0,
        paidToken
      };
      ordersDB[targetCartId] = order;
    } else {
      order.status = 'completed';
      order.paidToken = paidToken;
    }
    saveDB();

    const alreadyTracked = Boolean(order.purchaseTracked || order.purchase_tracked === 1);
    if (!alreadyTracked) {
      await sendMetaCapiPurchaseOnce(order, req.headers['x-forwarded-for'] || req.socket.remoteAddress, req.headers['user-agent']);
      await sendTikTokEventsApiPurchaseOnce(order, req.headers['x-forwarded-for'] || req.socket.remoteAddress, req.headers['user-agent']);
    }

    return res.status(200).json({
      verified: true,
      cartId: targetCartId,
      token: paidToken,
      alreadyTracked,
      eventId: `pur_${targetCartId}`,
      customerEmail: order.email
    });
  } catch (e) {
    console.error('[Verify Cart Exception]', e.message);
    return res.status(500).json({ verified: false, error: e.message });
  }
});

// Endpoint status
app.get('/api/order/status', async (req, res) => {
  readDB();
  const { orderId, cartId } = req.query;
  const lookupId = cartId || orderId;
  const order = ordersDB[lookupId] || Object.values(ordersDB).find(o => o.cartId === lookupId || o.orderId === lookupId);
  if (!order) {
    return res.status(404).json({ error: 'Commande introuvable.' });
  }
  return res.json({
    success: true,
    status: order.status,
    purchase_tracked: order.purchase_tracked,
    cartId: order.cartId,
    orderId: order.orderId
  });
});

app.post('/api/order/confirm-tracking', async (req, res) => {
  readDB();
  const { orderId, cartId } = req.body;
  const lookupId = cartId || orderId;
  const order = ordersDB[lookupId] || Object.values(ordersDB).find(o => o.cartId === lookupId || o.orderId === lookupId);
  if (!order) return res.status(404).json({ error: 'Commande inconnue.' });
  if (order.status !== 'completed') return res.status(400).json({ error: 'Paiement non validé' });

  await sendMetaCapiPurchaseOnce(order, req.headers['x-forwarded-for'] || req.socket.remoteAddress, req.headers['user-agent']);
  await sendTikTokEventsApiPurchaseOnce(order, req.headers['x-forwarded-for'] || req.socket.remoteAddress, req.headers['user-agent']);
  return res.json({ success: true, eventId: `pur_${order.cartId || order.orderId}` });
});

// ============================================================================
// ROUTE DE TEST / SIMULATION PAIEMENT RÉUSSI
// ============================================================================
app.post('/api/test/simulate-completed', (req, res) => {
  readDB();
  const { cartId, orderId } = req.body;
  const targetId = cartId || orderId || ('test_cart_' + Date.now());
  const paidToken = generatePaidToken(targetId);

  let order = ordersDB[targetId] || Object.values(ordersDB).find(o => o.cartId === targetId || o.orderId === targetId);
  if (order) {
    order.status = 'completed';
    order.paidToken = paidToken;
    ordersDB[order.orderId] = order;
    if (order.cartId) ordersDB[order.cartId] = order;
  } else {
    order = {
      orderId: 'ORD_' + targetId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12),
      cartId: targetId,
      status: 'completed',
      paidToken: paidToken,
      email: 'client@example.com',
      amount: 2500,
      currency: 'XOF',
      purchase_tracked: 0
    };
    ordersDB[targetId] = order;
    ordersDB[order.orderId] = order;
  }
  saveDB();

  return res.json({
    success: true,
    cartId: targetId,
    token: paidToken,
    thankYouUrl: `/remerciement?cartId=${encodeURIComponent(targetId)}&token=${encodeURIComponent(paidToken)}`,
    downloadUrl: `/api/download/guide?download=1&cartId=${encodeURIComponent(targetId)}&token=${encodeURIComponent(paidToken)}`
  });
});

// Webhook Maketou
app.post('/api/webhooks/maketou', (req, res) => {
  readDB();
  const event = req.body;
  const cart = event.cart || event.data?.cart;

  if (cart && cart.id) {
    const order = ordersDB[cart.id] || Object.values(ordersDB).find(o => o.cartId === cart.id);
    if (order && cart.status) {
      order.status = cart.status;
      if (['completed', 'paid', 'success'].includes(cart.status.toLowerCase())) {
        order.paidToken = generatePaidToken(cart.id);
      }
      saveDB();
    }
  }
  return res.status(200).json({ received: true });
});

// Page d'accueil officielle
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Tunnel Détox 21 Jours en ligne sur le port ${PORT}`);
    console.log(`🌐 Accès local : http://localhost:${PORT}`);
    console.log(`📦 Produit ID : ${process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606'}`);
    console.log(`💰 Tarif promo : 2 500 FCFA (au lieu de 10 000 FCFA, -75 %)`);
    console.log(`🔒 Protection anti-fraude SHA-256 HMAC activée`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
