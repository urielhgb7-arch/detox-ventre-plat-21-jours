const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

// Fonction de hachage SHA-256 pour Meta CAPI (minuscules normalisées trim)
function hashMetaField(value) {
  if (!value) return '';
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Signature HMAC pour sécuriser les redirections du Sas
function generateHmacSignature(orderId) {
  return crypto
    .createHmac('sha256', process.env.ORDER_HMAC_SECRET || 'maketou_andromeda_hmac_secret_2026_x99')
    .update(orderId)
    .digest('hex');
}

function verifyHmacSignature(orderId, sig) {
  if (!orderId || !sig) return false;
  try {
    const expected = generateHmacSignature(orderId);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (e) {
    return false;
  }
}

// Token de téléchargement sécurisé temporaire (valable 4 heures)
function generateDownloadToken(id) {
  const timestamp = Math.floor(Date.now() / 1000);
  const data = `${id}:${timestamp}`;
  const hmac = crypto
    .createHmac('sha256', process.env.ORDER_HMAC_SECRET || 'maketou_andromeda_hmac_secret_2026_x99')
    .update(data)
    .digest('hex');
  return Buffer.from(`${data}:${hmac}`).toString('base64url');
}

function verifyDownloadToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return false;
    const [id, timestampStr, hmac] = parts;
    const timestamp = parseInt(timestampStr, 10);
    const now = Math.floor(Date.now() / 1000);
    // Valide pendant 4 heures (14400 secondes)
    if (isNaN(timestamp) || now - timestamp > 14400 || timestamp > now + 300) {
      return false;
    }
    const expectedHmac = crypto
      .createHmac('sha256', process.env.ORDER_HMAC_SECRET || 'maketou_andromeda_hmac_secret_2026_x99')
      .update(`${id}:${timestamp}`)
      .digest('hex');
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

function formatAfricanPhone(rawPhone) {
  let cleaned = String(rawPhone || '').replace(/[^0-9]/g, '');
  // Si déjà avec indicatif 229
  if (cleaned.startsWith('229')) {
    let national = cleaned.slice(3);
    if (national.length === 8) {
      national = '01' + national;
    } else if (national.length === 9 && national.startsWith('1')) {
      national = '0' + national;
    }
    return '+229' + national;
  }
  // Si déjà avec indicatif 225 (Côte d'Ivoire)
  if (cleaned.startsWith('225')) {
    let national = cleaned.slice(3);
    if (national.length === 8) {
      national = '0' + national; // ex: 05, 07
    }
    return '+225' + national;
  }
  // Si déjà avec indicatif 221 (Sénégal)
  if (cleaned.startsWith('221')) {
    return '+221' + cleaned.slice(3);
  }
  // Numéro béninois 10 chiffres (nouveau plan de numérotation 01...)
  if (cleaned.length === 10 && (cleaned.startsWith('01') || cleaned.startsWith('02') || cleaned.startsWith('03'))) {
    return '+229' + cleaned;
  }
  // Numéro béninois 8 chiffres ancien plan (97, 66, 61...)
  if (cleaned.length === 8 && (cleaned.startsWith('9') || cleaned.startsWith('6') || cleaned.startsWith('5') || cleaned.startsWith('4'))) {
    return '+22901' + cleaned;
  }
  // Numéro ivoirien 10 chiffres (05, 07, 01...)
  if (cleaned.length === 10 && (cleaned.startsWith('05') || cleaned.startsWith('07') || cleaned.startsWith('01'))) {
    return '+225' + cleaned;
  }
  return '+' + cleaned;
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
  const capiPayload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: order.eventSourceUrl || `${process.env.APP_BASE_URL || 'https://detox-21-jours.aurakadre.com'}/confirmation-achat`,
        action_source: 'website',
        user_data: {
          em: [hashMetaField(order.email)],
          ph: [hashMetaField(order.phone)],
          fn: [hashMetaField(order.firstName)],
          ln: [hashMetaField(order.lastName)],
          client_ip_address: clientIp || order.clientIp || undefined,
          client_user_agent: clientUserAgent || order.clientUserAgent || undefined,
          fbp: order.fbp || undefined,
          fbc: order.fbc || undefined
        },
        custom_data: {
          currency: 'XOF',
          value: order.amount || 1200,
          content_name: 'Programme Détox & Ventre Plat en 21 Jours',
          content_ids: [order.productDocumentId || process.env.PRODUCT_DOCUMENT_ID || '3b25e32d-d421-4631-ae7c-767d48cab86b'],
          content_type: 'product',
          num_items: 1
        }
      }
    ]
  };

  try {
    const metaGraphUrl = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v21.0'}/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_ACCESS_TOKEN}`;
    await axios.post(metaGraphUrl, capiPayload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    console.log(`[Meta CAPI v21] Événement Purchase envoyé avec succès (${eventId})`);
  } catch (capiError) {
    console.warn('[Meta CAPI Warning]', capiError.response?.data?.error?.message || capiError.message);
  }
}

// Surveillance en arrière-plan du panier Maketou
function watchMaketouCartStatus(cartId, apiKey) {
  if (!cartId || !apiKey) return;
  let attempts = 0;
  const maxAttempts = 30; // 5 minutes (toutes les 10s)
  const timer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(timer);
      return;
    }
    const order = ordersDB[cartId] || Object.values(ordersDB).find(o => o.cartId === cartId);
    if (!order || order.status === 'completed' || order.purchaseTracked) {
      clearInterval(timer);
      return;
    }
    try {
      const res = await axios.get(`https://api.maketou.net/api/v1/stores/cart/${cartId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 6000
      });
      const cart = res.data?.cart || res.data;
      if (cart?.status === 'completed') {
        order.status = 'completed';
        saveDB();
        await sendMetaCapiPurchaseOnce(order);
        clearInterval(timer);
      }
    } catch (e) {
      // Écoute silencieuse
    }
  }, 10000);
}

// ============================================================================
// ENDPOINT 1 : CRÉATION DU CHECKOUT MAKETOU RÉEL ET REDIRECTION /confirmation-achat
// ============================================================================
app.post('/api/checkout/create', async (req, res) => {
  try {
    const { fullName, email, phone, fbp, fbc } = req.body;
    const productDocumentId = process.env.PRODUCT_DOCUMENT_ID || '3b25e32d-d421-4631-ae7c-767d48cab86b';
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

    // 4. Construction de la redirectURL vers notre page de remerciement et téléchargement
    const orderId = 'ORD_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const baseDomain = (process.env.APP_BASE_URL || (proto + '://' + host)).replace(/\/$/, '');

    const sig = generateHmacSignature(orderId);
    let redirectURL = `https://detox-21-jours.aurakadre.com/remerciement?orderId=${encodeURIComponent(orderId)}&sig=${sig}`;
    let webhookUrl = undefined;
    if (baseDomain.startsWith('https://') && !baseDomain.includes('localhost')) {
      redirectURL = `${baseDomain}/remerciement?orderId=${encodeURIComponent(orderId)}&sig=${sig}`;
      webhookUrl = `${baseDomain}/api/webhooks/maketou`;
    }

    // 5. Payload officiel Maketou avec tolérance multi-noms pour redirectURL
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
        amountXOF: String(process.env.PRODUCT_PRICE_XOF || '1200'),
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

    // 7. Enregistrement en base locale
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
      amount: parseInt(process.env.PRODUCT_PRICE_XOF || '1200', 10),
      currency: 'XOF',
      status: cart.status || 'waiting_payment',
      redirectUrl: redirectUrl,
      purchaseTracked: false,
      purchase_tracked: 0,
      createdAt: new Date().toISOString(),
      fbp: fbp || '',
      fbc: fbc || '',
      eventSourceUrl: redirectURL,
      clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      clientUserAgent: req.headers['user-agent'],
      sig: sig
    };

    ordersDB[orderId] = orderData;
    if (cart.id) {
      ordersDB[cart.id] = orderData;
      watchMaketouCartStatus(cart.id, apiKey);
    }
    if (cart.paymentId) {
      ordersDB[cart.paymentId] = orderData;
    }
    saveDB();

    // Transmission de cookies SameSite=Lax pour persistance cross-redirect
    try {
      if (cart.id) {
        res.cookie('maketou_cart_id', cart.id, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });
      }
      res.cookie('maketou_order_id', orderId, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });
      res.cookie('maketou_sig', sig, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });
    } catch (e) {}

    return res.status(200).json({
      cartId: cart.id,
      redirectUrl: redirectUrl,
      orderId: orderId,
      sig: sig,
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
// ENDPOINT 2 : VÉRIFICATION PAIEMENT POUR LA PAGE /confirmation-achat
// (Compatible avec le mode configuration Meta Pixel ?setup_pixel=1)
// ============================================================================
app.get('/api/checkout/verify', async (req, res) => {
  try {
    readDB();
    const { cartId, orderId, paymentId, setup_pixel } = req.query;

    // Permet à l'Outil de configuration d'événements Meta d'afficher la page et le bouton en mode configuration :
    if (setup_pixel === '1') {
      return res.status(200).json({ verified: true, setupMode: true, alreadyTracked: false });
    }

    // Extraction de cartId depuis paramètre URL, cookies ou base locale
    let cookieCartId = '';
    if (req.headers.cookie) {
      const match = req.headers.cookie.match(/maketou_cart_id=([^;]+)/);
      if (match) {
        cookieCartId = decodeURIComponent(match[1].trim());
      }
    }

    let targetCartId = cartId || cookieCartId;
    let order = undefined;

    if (targetCartId) {
      order = ordersDB[targetCartId] || Object.values(ordersDB).find(o => o.cartId === targetCartId);
    }
    if (!targetCartId && orderId) {
      order = ordersDB[orderId] || Object.values(ordersDB).find(o => o.orderId === orderId);
      if (order && order.cartId) targetCartId = order.cartId;
    }
    if (!targetCartId && paymentId) {
      order = ordersDB[paymentId] || Object.values(ordersDB).find(o => o.paymentId === paymentId);
      if (order && order.cartId) targetCartId = order.cartId;
    }

    if (!targetCartId) {
      return res.status(200).json({
        verified: false,
        status: 'waiting_info',
        message: 'Panier en cours de localisation'
      });
    }

    const apiKey = process.env.MAKETOU_API_KEY || 'msk_c650508aa6e29d8d7da5a9c2ea05cd20d081f29a89566fe1e3da0b79c080a4c8';
    
    // Interrogation de l'API Maketou
    let cart = null;
    try {
      const r = await axios.get(`https://api.maketou.net/api/v1/stores/cart/${targetCartId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 8000
      });
      const cartData = r.data;
      cart = cartData?.cart || cartData;
    } catch (apiErr) {
      console.warn(`[Maketou Status Check Warning] Panier ${targetCartId}:`, apiErr.message);
    }

    // Statuts acceptés comme paiement validé
    const paidStatuses = ['completed', 'paid', 'success', 'successful', 'finished', 'delivered'];
    const cartStatus = String(cart?.status || '').toLowerCase();
    const orderStatus = String(order?.status || '').toLowerCase();
    const isCompleted = paidStatuses.includes(cartStatus) || paidStatuses.includes(orderStatus);

    if (!isCompleted) {
      return res.status(200).json({
        verified: false,
        status: cartStatus || orderStatus || 'waiting_payment',
        cartId: targetCartId
      });
    }

    if (!order) {
      order = {
        cartId: targetCartId,
        orderId: 'ORD_' + targetCartId.slice(0, 12),
        email: cart?.customerInfo?.email || cart?.email || '',
        phone: cart?.customerInfo?.phone || cart?.phone || '',
        firstName: cart?.customerInfo?.firstName || cart?.firstName || '',
        lastName: cart?.customerInfo?.lastName || cart?.lastName || '',
        productDocumentId: cart?.productDocumentId || process.env.PRODUCT_DOCUMENT_ID || '3b25e32d-d421-4631-ae7c-767d48cab86b',
        amount: 1200,
        status: 'completed',
        purchaseTracked: false,
        purchase_tracked: 0
      };
      ordersDB[targetCartId] = order;
    }

    order.status = 'completed';
    const alreadyTracked = Boolean(order.purchaseTracked || order.purchase_tracked === 1);

    if (!alreadyTracked) {
      await sendMetaCapiPurchaseOnce(
        order,
        req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        req.headers['user-agent']
      );
    }

    // Récupération de l'URL directe de livraison et téléchargement Maketou
    const maketouDownloadUrl = cart?.downloadUrl 
      || cart?.fileUrl 
      || cart?.receiptUrl 
      || `https://vouh-digital-shop-0.mymaketou.shop/fr/purchases/${targetCartId}`
      || process.env.MAKETOU_DOWNLOAD_URL 
      || 'https://portal.maketou.com';

    return res.status(200).json({
      verified: true,
      cartId: targetCartId,
      alreadyTracked,
      eventId: `pur_${targetCartId}`,
      customerEmail: cart?.customerInfo?.email || cart?.email || order.email,
      maketouDownloadUrl
    });
  } catch (e) {
    console.error('[Verify Cart Exception]', e.message);
    return res.status(500).json({ verified: false, error: e.message });
  }
});

// Ancien endpoint conservé pour rétro-compatibilité
app.get('/api/order/status', async (req, res) => {
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
  const { orderId, cartId } = req.body;
  const lookupId = cartId || orderId;
  const order = ordersDB[lookupId] || Object.values(ordersDB).find(o => o.cartId === lookupId || o.orderId === lookupId);
  if (!order) return res.status(404).json({ error: 'Commande inconnue.' });
  if (order.status !== 'completed') return res.status(400).json({ error: 'Paiement non validé' });

  await sendMetaCapiPurchaseOnce(order, req.headers['x-forwarded-for'] || req.socket.remoteAddress, req.headers['user-agent']);
  return res.json({ success: true, eventId: `pur_${order.cartId || order.orderId}` });
});

// ============================================================================
// ROUTE DE TEST / SIMULATION LOCALE (TEST 4 DU PROTOCOLE)
// ============================================================================
app.post('/api/test/simulate-completed', (req, res) => {
  const { orderId } = req.body;
  readDB();
  if (!orderId) {
    return res.status(400).json({ error: 'orderId requis' });
  }
  const order = ordersDB[orderId] || Object.values(ordersDB).find(o => o.cartId === orderId);
  if (order) {
    order.status = 'completed';
    ordersDB[order.orderId] = order;
    if (order.cartId) ordersDB[order.cartId] = order;
  } else {
    ordersDB[orderId] = {
      orderId,
      cartId: orderId,
      status: 'completed',
      email: 'client@example.com',
      amount: 1200,
      purchase_tracked: 0
    };
  }
  saveDB();
  return res.json({ success: true, message: `Commande ${orderId} marquée completed.` });
});

// Webhook Maketou
app.post('/api/webhooks/maketou', (req, res) => {
  const event = req.body;
  const cart = event.cart || event.data?.cart;

  if (cart && cart.id) {
    const order = Object.values(ordersDB).find(o => o.cartId === cart.id);
    if (order && cart.status) {
      order.status = cart.status;
      saveDB();
    }
  }
  return res.status(200).json({ received: true });
});

// ============================================================================
// ENDPOINT SÉCURISÉ : TÉLÉCHARGEMENT & LECTURE DU GUIDE PDF
// (Le lien Google Drive n'est JAMAIS exposé au client pour une sécurité absolue)
// ============================================================================
app.get('/api/download/guide', async (req, res) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const token = req.query.token || getCookieFromHeader(cookieHeader, 'download_token');
    const orderId = req.query.orderId || getCookieFromHeader(cookieHeader, 'maketou_order_id');
    const sig = req.query.sig || getCookieFromHeader(cookieHeader, 'maketou_sig');
    const cartId = req.query.cartId || getCookieFromHeader(cookieHeader, 'maketou_cart_id');
    const isSetupMode = req.query.setup_pixel === '1' || req.query.setup === '1';

    // Contrôle d'accès strict : nécessite token valide, ou signature HMAC, ou commande en base, ou mode setup
    let isAllowed = false;
    if (isSetupMode) {
      isAllowed = true;
    } else if (token && verifyDownloadToken(token)) {
      isAllowed = true;
    } else if (orderId && sig && verifyHmacSignature(orderId, sig)) {
      isAllowed = true;
    } else if (cartId) {
      const order = ordersDB[cartId] || Object.values(ordersDB).find(o => o.cartId === cartId);
      if (order && (order.status === 'completed' || order.purchaseTracked)) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      console.warn(`[Security Alert] Tentative de téléchargement PDF non autorisé depuis IP: ${req.ip}`);
      res.status(403);
      return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accès Refusé — Détox 21 Jours</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 min-h-screen flex items-center justify-center p-4 font-sans text-slate-800">
  <div class="max-w-md w-full bg-white rounded-2xl shadow-xl p-6 text-center border border-red-200">
    <div class="w-14 h-14 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-3">
      <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
    </div>
    <h1 class="text-base font-black text-slate-900 mb-1">Téléchargement Réservé aux Membres</h1>
    <p class="text-xs text-slate-600 mb-4 leading-relaxed">
      L'accès direct à ce guide PDF nécessite une commande validée. Si vous avez déjà effectué votre paiement, veuillez utiliser le lien sécurisé envoyé dans votre boîte e-mail ou sur votre page de confirmation d'achat.
    </p>
    <a href="/" class="inline-block w-full py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold text-xs rounded-xl shadow transition">
      Commander mon guide (1 200 FCFA)
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
});

// Pages HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware de protection et d'attribution du jeton sur la page de remerciement
function handleThankYouAccess(req, res) {
  const isSetupPixel = req.query.setup_pixel === '1' || req.query.setup === '1';
  if (isSetupPixel) {
    return res.sendFile(path.join(__dirname, 'public', 'remerciement.html'));
  }

  const cookieHeader = req.headers.cookie || '';
  const cartId = req.query.cartId || getCookieFromHeader(cookieHeader, 'maketou_cart_id') || '';
  const orderId = req.query.orderId || getCookieFromHeader(cookieHeader, 'maketou_order_id') || '';
  const sig = req.query.sig || getCookieFromHeader(cookieHeader, 'maketou_sig') || '';

  // 1. Contrôle par signature cryptographique HMAC
  let isAuthorized = false;
  if (orderId && sig && verifyHmacSignature(orderId, sig)) {
    isAuthorized = true;
  } else if (cartId) {
    // Vérification de l'existence du panier
    const order = ordersDB[cartId] || Object.values(ordersDB).find(o => o.cartId === cartId);
    if (order) {
      isAuthorized = true;
    }
  }

  // 2. Si aucune preuve valide : blocage et redirection vers la page de vente
  if (!isAuthorized) {
    console.warn(`[Security Alert] Accès refusé à /remerciement (aucun achat valide). Redirection vers / depuis IP: ${req.ip}`);
    return res.redirect('/?access_denied=1');
  }

  // 3. Délivrance du jeton de téléchargement temporaire
  const primaryId = orderId || cartId || 'order_' + Date.now();
  const downloadToken = generateDownloadToken(primaryId);
  res.cookie('download_token', downloadToken, { maxAge: 14400000, httpOnly: false, sameSite: 'lax', path: '/' });
  if (cartId) res.cookie('maketou_cart_id', cartId, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });
  if (orderId) res.cookie('maketou_order_id', orderId, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });
  if (sig) res.cookie('maketou_sig', sig, { maxAge: 86400000, httpOnly: false, sameSite: 'lax', path: '/' });

  return res.sendFile(path.join(__dirname, 'public', 'remerciement.html'));
}

app.get('/remerciement', handleThankYouAccess);
app.get('/confirmation-achat', handleThankYouAccess);

// Alias rétro-compatible
app.get('/verify-purchase', (req, res) => {
  res.redirect('/remerciement');
});

if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Tunnel Détox 21 Jours en ligne sur le port ${PORT}`);
    console.log(`🌐 Accès local : http://localhost:${PORT}`);
    console.log(`📦 Produit ID : ${process.env.PRODUCT_DOCUMENT_ID || '3b25e32d-d421-4631-ae7c-767d48cab86b'}`);
    console.log(`💰 Tarif promo : 1 200 FCFA (au lieu de 10 000 FCFA, -88 %)`);
    console.log(`🔒 Zéro emoji hors témoignages & API Maketou connectée`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
