// netlify/functions/shopify-order.js
//
// Reçoit la notification Shopify à chaque commande payée.
//
// Si la commande contient l'accès SwiftyPharm (7,90 €), on crée
// automatiquement une invitation et on envoie au pharmacien son lien
// personnel de création de compte. Il choisit lui-même son mot de passe :
// aucun identifiant ne transite jamais en clair par email.
//
// Les autres articles de la commande (plaques NFC, stickers, présentoirs…)
// sont enregistrés pour information mais ne déclenchent aucune création
// de compte : ce sont des ventes additionnelles.
//
// ═══════════════════════════════════════════════════
//  1. CONFIGURATION SHOPIFY (à faire une fois)
// ═══════════════════════════════════════════════════
//
//  a) Sur la fiche produit « Accès SwiftyPharm », ajoutez deux champs
//     personnalisés OBLIGATOIRES via les line item properties de votre thème :
//        · "Nom de la pharmacie"
//        · "Ville"
//     Bloquez l'ajout au panier tant qu'ils ne sont pas remplis : le webhook
//     n'a alors jamais à deviner une valeur.
//
//  b) Relevez le handle du produit (visible dans son URL) et renseignez-le
//     dans PRODUIT_HANDLE ci-dessous.
//
//  c) Shopify → Paramètres → Notifications → Webhooks :
//     Événement  : « Commande payée » (orders/paid)
//     Format     : JSON
//     URL        : https://swiftypharm.fr/api/shopify-order
//     Copiez la clé secrète affichée dans la variable SHOPIFY_WEBHOOK_SECRET.
//
// ═══════════════════════════════════════════════════
//  2. VARIABLES D'ENVIRONNEMENT NETLIFY
// ═══════════════════════════════════════════════════
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SHOPIFY_WEBHOOK_SECRET
//   BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME
//   SITE_URL
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (facultatif — alertes d'erreur)

const crypto = require('crypto');

const PRODUIT_HANDLE = 'acces-swiftypharm';   // ← handle exact du produit Shopify
const MOTS_CLES      = ['swiftypharm', 'accès swiftypharm', 'acces swiftypharm'];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const BREVO_KEY    = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'contact@swiftup.fr';
const SENDER_NAME  = process.env.BREVO_SENDER_NAME  || 'SwiftyPharm';
const SITE_URL     = process.env.SITE_URL || 'https://swiftypharm.fr';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Alerte Telegram en cas de problème ──
async function alerte(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.error(message); return; }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: message, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('Telegram indisponible :', e.message);
  }
}

// ── Vérification de la signature Shopify ──
function signatureValide(rawBody, signature) {
  if (!SHOPIFY_SECRET || !signature) return false;
  const calcule = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(calcule), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function sb(path, options = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const texte = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ' : ' + texte.slice(0, 200));
  return texte ? JSON.parse(texte) : null;
}

// ── Récupération des champs personnalisés ──
function champsPersonnalises(order, lineItem) {
  const props = {};
  (lineItem?.properties || []).forEach((p) => {
    if (p?.name) props[p.name.toLowerCase().trim()] = p.value;
  });
  (order?.note_attributes || []).forEach((p) => {
    const cle = p?.name?.toLowerCase().trim();
    if (cle && !props[cle]) props[cle] = p.value;
  });

  const nom = props['nom de la pharmacie'] || props['nom pharmacie']
           || props['pharmacie'] || props['nom'] || '';
  const ville = props['ville'] || props['commune'] || '';
  return { nom: (nom || '').trim(), ville: (ville || '').trim() };
}

// ── Email de bienvenue + lien de création de compte ──
async function envoyerBienvenue({ email, nom, ville, lien, extras }) {
  if (!BREVO_KEY) { console.warn('BREVO_API_KEY absente'); return false; }

  const blocExtras = extras.length
    ? `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:15px 17px;margin-bottom:22px;">
         <p style="font-size:13px;font-weight:700;color:#0c4a6e;margin:0 0 8px;">Également dans votre commande</p>
         <p style="font-size:13px;color:#334155;line-height:1.7;margin:0;">
           ${extras.map(esc).join('<br>')}<br>
           <span style="color:#64748b;font-size:12px;">Expédition sous 48 h ouvrées, suivi par email.</span>
         </p>
       </div>`
    : '';

  const html = `
<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,70,.07);">

        <tr><td style="background:linear-gradient(135deg,#000046,#1cb5e0);padding:32px 34px;">
          <div style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-.4px;">Bienvenue sur SwiftyPharm</div>
          <div style="color:rgba(255,255,255,.68);font-size:13px;margin-top:5px;">Votre accès est actif — à vie</div>
        </td></tr>

        <tr><td style="padding:32px 34px;">
          <p style="font-size:15px;color:#334155;line-height:1.7;margin:0 0 18px;">
            Merci pour votre commande. L'accès SwiftyPharm de
            <strong>${esc(nom)}</strong>${ville ? ' à ' + esc(ville) : ''} est réglé et actif.
          </p>

          <p style="font-size:14.5px;color:#334155;line-height:1.7;margin:0 0 26px;">
            Dernière étape : créez votre espace en choisissant votre mot de passe.
            Votre page sera en ligne dans la foulée.
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 26px;">
            <tr><td align="center" style="border-radius:11px;background:#000046;">
              <a href="${lien}" style="display:inline-block;padding:15px 38px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                Créer mon espace
              </a>
            </td></tr>
          </table>

          ${blocExtras}

          <div style="background:#f8fafc;border-radius:10px;padding:15px 17px;margin-bottom:22px;">
            <p style="font-size:12.5px;color:#64748b;line-height:1.6;margin:0;">
              Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
              <span style="color:#1cb5e0;word-break:break-all;">${lien}</span>
            </p>
          </div>

          <p style="font-size:13px;color:#64748b;line-height:1.7;margin:0;">
            Ce lien est personnel et ne fonctionne qu'une seule fois.
            <strong>Aucun abonnement ne sera prélevé</strong> : votre accès est acquis définitivement.
          </p>
        </td></tr>

        <tr><td style="padding:22px 34px;background:#f8fafc;border-top:1px solid #e8edf5;">
          <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0;">
            Une question ? Répondez simplement à cet email.<br>
            SwiftyPharm — une solution Swiftup
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email, name: nom }],
      subject: 'Bienvenue sur SwiftyPharm — créez votre espace',
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    console.error('Brevo', res.status, (await res.text()).slice(0, 300));
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════
//  HANDLER
// ═══════════════════════════════════════════════════
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── Authenticité de la requête ──
  const signature = event.headers['x-shopify-hmac-sha256'];
  if (!signatureValide(event.body, signature)) {
    console.warn('Signature Shopify invalide');
    return { statusCode: 401, body: JSON.stringify({ error: 'signature_invalide' }) };
  }

  let order;
  try {
    order = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'json_invalide' }) };
  }

  try {
    const items = order.line_items || [];

    // ── L'accès SwiftyPharm est-il dans la commande ? ──
    const ligneAcces = items.find((li) =>
      li.product_handle === PRODUIT_HANDLE ||
      MOTS_CLES.some((m) => (li.title || '').toLowerCase().includes(m))
    );

    // Commande d'accessoires seuls (plaques, stickers…) : rien à créer.
    if (!ligneAcces) {
      return { statusCode: 200, body: JSON.stringify({ skipped: 'pas_d_acces_dans_la_commande' }) };
    }

    // ── Rejeu du même webhook : on ne recrée rien ──
    const orderId = String(order.id || order.order_number || '');
    const dejaTraite = await sb(
      'invitations?note=eq.' + encodeURIComponent('shopify:' + orderId) + '&select=token&limit=1'
    );
    if (dejaTraite && dejaTraite.length) {
      return { statusCode: 200, body: JSON.stringify({ skipped: 'commande_deja_traitee' }) };
    }

    const email = (order.email || order.customer?.email || '').trim().toLowerCase();
    if (!email) {
      await alerte(
        `⚠️ <b>COMMANDE SHOPIFY SANS EMAIL</b>\n\n`
        + `Commande #${esc(order.order_number)} contient l'accès SwiftyPharm `
        + `mais aucune adresse email n'est disponible. Création de compte impossible.`
      );
      return { statusCode: 200, body: JSON.stringify({ error: 'email_absent' }) };
    }

    // ── Champs personnalisés, avec repli sur l'adresse de facturation ──
    let { nom, ville } = champsPersonnalises(order, ligneAcces);
    if (!nom) {
      nom = order.billing_address?.company
         || order.shipping_address?.company
         || `Pharmacie ${order.customer?.last_name || ''}`.trim()
         || 'Ma pharmacie';
      await alerte(
        `⚠️ <b>NOM DE PHARMACIE MANQUANT</b>\n\n`
        + `Commande #${esc(order.order_number)} — champ non rempli sur Shopify.\n`
        + `Valeur retenue : <b>${esc(nom)}</b>\nÀ vérifier dans le back office admin.`
      );
    }
    if (!ville) {
      ville = order.billing_address?.city || order.shipping_address?.city || '';
    }

    // ── Compte déjà existant pour cette adresse ? ──
    const dejaInscrit = await sb(
      'pharmacies?email_contact=eq.' + encodeURIComponent(email) + '&select=slug&limit=1'
    );
    if (dejaInscrit && dejaInscrit.length) {
      await alerte(
        `ℹ️ <b>CLIENT DÉJÀ INSCRIT</b>\n\n`
        + `Commande #${esc(order.order_number)} — ${esc(email)} possède déjà le compte `
        + `« ${esc(dejaInscrit[0].slug)} ». Aucun nouveau lien envoyé.`
      );
      return { statusCode: 200, body: JSON.stringify({ skipped: 'client_deja_inscrit' }) };
    }

    // ── Création de l'invitation ──
    const slugSuggere = [nom, ville]
      .filter(Boolean)
      .map((s) =>
        s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
         .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-')
      )
      .join('-');

    const montant = Number(ligneAcces.price) || 7.90;

    const cree = await sb('invitations', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        nom_pharmacie: nom,
        ville,
        email,
        slug_suggere: slugSuggere,
        canal: 'shopify',
        montant_paye: montant,
        note: 'shopify:' + orderId,
      }),
    });

    const token = cree[0].token;
    const lien  = SITE_URL + '/signup.html?invite=' + token;

    // ── Ventes additionnelles présentes dans la commande ──
    const extras = items
      .filter((li) => li !== ligneAcces)
      .map((li) => `${li.quantity} × ${li.title}`);

    const envoye = await envoyerBienvenue({ email, nom, ville, lien, extras });

    if (envoye) {
      await sb('invitations?token=eq.' + token, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ email_envoye_at: new Date().toISOString() }),
      });
    } else {
      await alerte(
        `🚨 <b>EMAIL DE BIENVENUE NON ENVOYÉ</b>\n\n`
        + `Commande #${esc(order.order_number)} — ${esc(email)}\n`
        + `L'invitation existe mais l'email a échoué.\n`
        + `Transmettez le lien manuellement :\n${esc(lien)}`
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, token, email_envoye: envoye, extras: extras.length }),
    };
  } catch (err) {
    console.error('shopify-order.js', err);
    await alerte(
      `🚨 <b>ERREUR WEBHOOK SHOPIFY</b>\n\n`
      + `Commande #${esc(order?.order_number)}\n<code>${esc(err.message)}</code>`
    );
    // On répond 200 : Shopify ne doit pas boucler sur un rejeu infini.
    return { statusCode: 200, body: JSON.stringify({ error: err.message }) };
  }
};
