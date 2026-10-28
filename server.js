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

function formatAfricanPhone(rawPhone) {
  let cleaned = String(rawPhone || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('229')) {
    let national = cleaned.slice(3);
    if (national.length === 9 && national.startsWith('1')) {
      national = '0' + national;
    }
    return '+229' + national;
  }
  if (cleaned.startsWith('225')) {
    let national = cleaned.slice(3);
    if (national.length === 9) {
      national = '0' + national;
    }
    return '+225' + national;
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
          value: order.amount || 2500,
          content_name: 'Programme Détox & Ventre Plat en 21 Jours',
          content_ids: [order.productDocumentId || process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606'],
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

    // 4. Construction de la redirectURL vers notre page intermédiaire /confirmation-achat
    const orderId = 'ORD_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const baseDomain = (process.env.APP_BASE_URL || (proto + '://' + host)).replace(/\/$/, '');

    let redirectURL = 'https://detox-21-jours.aurakadre.com/confirmation-achat';
    let webhookUrl = undefined;
    if (baseDomain.startsWith('https://') && !baseDomain.includes('localhost')) {
      redirectURL = `${baseDomain}/confirmation-achat`;
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

    // 7. Enregistrement en base locale
    const orderData = {
      orderId,
      cartId: cart.id || '',
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
      eventSourceUrl: redirectURL,
      clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      clientUserAgent: req.headers['user-agent']
    };

    ordersDB[orderId] = orderData;
    if (cart.id) {
      ordersDB[cart.id] = orderData;
      watchMaketouCartStatus(cart.id, apiKey);
    }
    saveDB();

    return res.status(200).json({
      cartId: cart.id,
      redirectUrl: redirectUrl,
      orderId: orderId
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
    const { cartId, setup_pixel } = req.query;

    // Permet à l'Outil de configuration d'événements Meta d'afficher la page et le bouton en mode configuration :
    if (setup_pixel === '1') {
      return res.status(200).json({ verified: true, setupMode: true, alreadyTracked: false });
    }

    if (!cartId) {
      return res.status(400).json({ verified: false, error: 'Identifiant cartId manquant.' });
    }

    const apiKey = process.env.MAKETOU_API_KEY || 'msk_c650508aa6e29d8d7da5a9c2ea05cd20d081f29a89566fe1e3da0b79c080a4c8';
    
    // Interrogation de l'API Maketou
    let cart = null;
    try {
      const r = await axios.get(`https://api.maketou.net/api/v1/stores/cart/${cartId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 8000
      });
      const cartData = r.data;
      cart = cartData?.cart || cartData;
    } catch (apiErr) {
      console.warn(`[Maketou Status Check Warning] Panier ${cartId}:`, apiErr.message);
    }

    let order = ordersDB[cartId] || Object.values(ordersDB).find(o => o.cartId === cartId);

    // Si Maketou retourne completed OU si notre webhook l'a déjà marqué completed
    const isCompleted = cart?.status === 'completed' || order?.status === 'completed';

    if (!isCompleted) {
      return res.status(200).json({
        verified: false,
        status: cart?.status || order?.status || 'waiting_payment'
      });
    }

    if (!order) {
      order = {
        cartId,
        orderId: 'ORD_' + cartId.slice(0, 12),
        email: cart?.email || '',
        phone: cart?.phone || '',
        firstName: cart?.firstName || '',
        lastName: cart?.lastName || '',
        productDocumentId: cart?.productDocumentId || process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606',
        amount: 2500,
        status: 'completed',
        purchaseTracked: false,
        purchase_tracked: 0
      };
      ordersDB[cartId] = order;
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

    // Récupération de toute URL de téléchargement ou reçu renvoyée par Maketou
    const maketouDownloadUrl = cart?.downloadUrl 
      || cart?.fileUrl 
      || cart?.receiptUrl 
      || cart?.orderUrl 
      || cart?.invoiceUrl 
      || process.env.MAKETOU_DOWNLOAD_URL 
      || (cart?.id ? `https://maketou.net/orders/${cart.id}` : null);

    return res.status(200).json({
      verified: true,
      alreadyTracked,
      eventId: `pur_${cartId}`,
      customerEmail: cart?.email || order.email,
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
      amount: 2500,
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

// Pages HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Page intermédiaire /confirmation-achat (Configuration manuelle Meta Pixel + Livraison Maketou)
app.get('/confirmation-achat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'confirmation-achat.html'));
});

// Alias rétro-compatible
app.get('/verify-purchase', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'confirmation-achat.html'));
});

if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Tunnel Détox 21 Jours en ligne sur le port ${PORT}`);
    console.log(`🌐 Accès local : http://localhost:${PORT}`);
    console.log(`📦 Produit ID : ${process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606'}`);
    console.log(`💰 Tarif promo : 2 500 FCFA (au lieu de 10 000 FCFA, -75 %)`);
    console.log(`🔒 Zéro emoji hors témoignages & API Maketou connectée`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
