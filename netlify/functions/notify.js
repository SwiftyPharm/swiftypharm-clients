// netlify/functions/notify.js
//
// Point d'entrée unique pour toutes les notifications SwiftyPharm :
//
//   action: 'ordonnance'  → la page publique transmet une ordonnance à l'officine
//   action: 'commande'    → click & collect : email au pharmacien + SMS au client
//   action: 'statut'      → la commande passe à « prête » : SMS au client
//
// ═══════════════════════════════════════════════════════════
//  PRINCIPE DE SÉCURITÉ — à ne jamais modifier
// ═══════════════════════════════════════════════════════════
//  Le destinataire n'est JAMAIS lu dans la requête. Il est
//  systématiquement récupéré en base à partir du slug de la
//  pharmacie. Sans cela, cette fonction serait un relais ouvert :
//  n'importe qui pourrait envoyer des emails depuis votre domaine
//  et détruire votre réputation d'expéditeur en une nuit.
//
// ═══════════════════════════════════════════════════════════
//  VARIABLES D'ENVIRONNEMENT NETLIFY
// ═══════════════════════════════════════════════════════════
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   BREVO_API_KEY
//   BREVO_SENDER_EMAIL   ordonnances@swiftypharm.fr
//   BREVO_SENDER_NAME    SwiftyPharm
//   BREVO_SMS_SENDER     SwiftyPharm      (11 caractères max, sans espace)
//   SMS_ACTIF            'true' pour activer les SMS (voir note de coût)
//   SMS_MAX_PAR_JOUR     garde-fou par pharmacie, ex. '30'
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (facultatif)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BREVO_KEY    = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'ordonnances@swiftypharm.fr';
const SENDER_NAME  = process.env.BREVO_SENDER_NAME  || 'SwiftyPharm';
const SMS_SENDER   = process.env.BREVO_SMS_SENDER   || 'SwiftyPharm';
const SMS_ACTIF    = process.env.SMS_ACTIF === 'true';
const SMS_MAX_JOUR = parseInt(process.env.SMS_MAX_PAR_JOUR || '30', 10);

// Limites Brevo : 20 Mo pour l'email complet, pièce jointe sous 4 Mo.
// On reste bien en dessous, la limite d'une fonction Netlify étant de 6 Mo.
const MAX_FICHIER   = 3.5 * 1024 * 1024;
const MAX_FICHIERS  = 4;
const EXT_AUTORISEES = ['jpg', 'jpeg', 'png', 'pdf', 'heic', 'webp'];

const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

async function alerte(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.error(msg); return; }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram :', e.message); }
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
  const t = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ' : ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

// ── Envoi email Brevo ──
async function envoyerEmail({ to, toName, replyTo, subject, html, attachments }) {
  const payload = {
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    to: [{ email: to, name: toName || to }],
    subject,
    htmlContent: html,
  };
  // Le pharmacien peut répondre directement au patient
  if (replyTo) payload.replyTo = { email: replyTo };
  if (attachments?.length) payload.attachment = attachments;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error('Brevo email ' + res.status + ' : ' + detail);
  }
  return (await res.json()).messageId;
}

// ── Envoi SMS Brevo ──
//
//  « type: transactional » évite les restrictions horaires françaises.
//  Attention : n'ajoutez JAMAIS de mention STOP dans le texte, Brevo
//  reclasserait le message en marketing, et il serait alors bloqué
//  entre 22 h et 8 h, le dimanche et les jours fériés.
async function envoyerSMS({ numero, texte }) {
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: SMS_SENDER,
      recipient: numero,
      content: texte,
      type: 'transactional',
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error('Brevo SMS ' + res.status + ' : ' + detail);
  }
  return true;
}

// ── Normalisation d'un numéro français au format international ──
function normaliserNumero(brut) {
  const n = String(brut || '').replace(/[\s.\-()]/g, '');
  if (/^0[67]\d{8}$/.test(n)) return '33' + n.slice(1);
  if (/^\+33[67]\d{8}$/.test(n)) return n.slice(1);
  if (/^33[67]\d{8}$/.test(n)) return n;
  return null;   // fixe ou format inconnu : pas de SMS
}

// ── Garde-fou anti-abus : plafond d'envois par pharmacie et par jour ──
const compteurs = new Map();
function quotaDepasse(cle, plafond) {
  const jour = new Date().toISOString().slice(0, 10);
  const k = cle + ':' + jour;
  const n = (compteurs.get(k) || 0) + 1;
  compteurs.set(k, n);
  return n > plafond;
}

// ── Gabarit d'email ──
function gabarit({ titre, sousTitre, corps, accent = '#000046' }) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:28px 14px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,70,.07);">
  <tr><td style="background:${accent};padding:26px 32px;">
    <div style="color:#fff;font-size:19px;font-weight:800;letter-spacing:-.3px;">${titre}</div>
    <div style="color:rgba(255,255,255,.7);font-size:13px;margin-top:4px;">${sousTitre}</div>
  </td></tr>
  <tr><td style="padding:28px 32px;">${corps}</td></tr>
  <tr><td style="padding:18px 32px;background:#f8fafc;border-top:1px solid #e8edf5;">
    <p style="font-size:11.5px;color:#94a3b8;line-height:1.6;margin:0;">
      Message automatique envoyé via SwiftyPharm — une solution Swiftup.<br>
      Ce message peut contenir des données de santé : ne le transférez pas.
    </p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

const ligne = (label, valeur) => `
  <tr>
    <td style="padding:9px 0;font-size:13px;color:#64748b;width:38%;">${esc(label)}</td>
    <td style="padding:9px 0;font-size:14px;color:#0f172a;font-weight:600;">${esc(valeur)}</td>
  </tr>`;

// ═══════════════════════════════════════════════════════════
//  HANDLER
// ═══════════════════════════════════════════════════════════
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée' });
  if (!BREVO_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'Configuration serveur incomplète' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Requête invalide' }); }

  const slug = String(body.slug || '').trim().toLowerCase();
  if (!slug) return json(400, { error: 'Pharmacie non identifiée' });

  // ── Le destinataire vient de la base, jamais de la requête ──
  let pharma;
  try {
    const rows = await sb(
      'pharmacies?slug=eq.' + encodeURIComponent(slug)
      + '&select=slug,nom,email_contact,telephone&limit=1'
    );
    if (!rows?.length) return json(404, { error: 'Pharmacie introuvable' });
    pharma = rows[0];
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Base de données indisponible' });
  }

  if (!pharma.email_contact) {
    await alerte(`⚠️ <b>EMAIL DE CONTACT MANQUANT</b>\n\nLa pharmacie <b>${esc(pharma.nom)}</b> `
      + `(${esc(slug)}) n'a pas renseigné d'email. Notification perdue.`);
    return json(422, { error: "Cette pharmacie n'a pas encore renseigné son email de contact." });
  }

  try {
    // ═══════════════════════════════════════════
    //  1. TRANSMISSION D'ORDONNANCE
    // ═══════════════════════════════════════════
    if (body.action === 'ordonnance') {
      if (quotaDepasse('ord:' + slug, 120)) {
        return json(429, { error: 'Trop de transmissions. Réessayez dans quelques minutes.' });
      }

      const nom      = String(body.patient_nom || '').trim().slice(0, 120);
      const tel      = String(body.patient_tel || '').trim().slice(0, 30);
      const email    = String(body.patient_email || '').trim().slice(0, 160);
      const message  = String(body.message || '').trim().slice(0, 1200);
      const fichiers = Array.isArray(body.fichiers) ? body.fichiers : [];

      if (!nom || !tel) return json(400, { error: 'Nom et téléphone sont obligatoires.' });
      if (!fichiers.length) return json(400, { error: 'Ajoutez au moins une photo de votre ordonnance.' });
      if (fichiers.length > MAX_FICHIERS) return json(400, { error: `Maximum ${MAX_FICHIERS} fichiers.` });

      // Validation des pièces jointes
      const attachments = [];
      for (const f of fichiers) {
        const nomFichier = String(f.name || 'ordonnance.jpg');
        const ext = nomFichier.split('.').pop().toLowerCase();
        if (!EXT_AUTORISEES.includes(ext)) {
          return json(400, { error: `Format non accepté : .${ext}. Utilisez JPG, PNG ou PDF.` });
        }
        const contenu = String(f.content || '').replace(/^data:[^;]+;base64,/, '');
        if (!contenu) return json(400, { error: 'Fichier illisible.' });
        if (contenu.length * 0.75 > MAX_FICHIER) {
          return json(400, { error: 'Photo trop lourde. Réduisez la qualité et réessayez.' });
        }
        attachments.push({ name: nomFichier, content: contenu });
      }

      const corps = `
        <p style="font-size:15px;color:#334155;line-height:1.7;margin:0 0 20px;">
          Une nouvelle ordonnance vient de vous être transmise depuis votre page SwiftyPharm.
        </p>
        <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:20px;">
          ${ligne('Patient', nom)}
          ${ligne('Téléphone', tel)}
          ${email ? ligne('Email', email) : ''}
          ${ligne('Reçue le', new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }))}
          ${ligne('Pièces jointes', attachments.length + ' fichier' + (attachments.length > 1 ? 's' : ''))}
        </table>
        ${message ? `<div style="background:#f8fafc;border-left:3px solid #1cb5e0;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
          <p style="font-size:12px;font-weight:700;color:#64748b;margin:0 0 6px;text-transform:uppercase;letter-spacing:.4px;">Message du patient</p>
          <p style="font-size:14px;color:#334155;line-height:1.7;margin:0;">${esc(message)}</p>
        </div>` : ''}
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:9px;padding:13px 15px;">
          <p style="font-size:12.5px;color:#92400e;line-height:1.6;margin:0;">
            L'ordonnance est en pièce jointe. Contactez le patient au <strong>${esc(tel)}</strong>
            pour confirmer la disponibilité et l'heure de retrait.
          </p>
        </div>`;

      await envoyerEmail({
        to: pharma.email_contact,
        toName: pharma.nom,
        replyTo: email || undefined,
        subject: `Ordonnance — ${nom}`,
        html: gabarit({
          titre: 'Nouvelle ordonnance',
          sousTitre: pharma.nom,
          corps,
          accent: '#0f766e',
        }),
        attachments,
      });

      // Aucune trace de l'ordonnance n'est conservée : ni en base,
      // ni dans les journaux. Voir la note RGPD du guide.
      return json(200, { ok: true });
    }

    // ═══════════════════════════════════════════
    //  2. NOUVELLE COMMANDE CLICK & COLLECT
    // ═══════════════════════════════════════════
    if (body.action === 'commande') {
      if (quotaDepasse('cmd:' + slug, 200)) {
        return json(429, { error: 'Trop de commandes en peu de temps.' });
      }

      const cmd     = body.commande || {};
      const numero  = String(cmd.numero || '').slice(0, 24);
      const client  = String(cmd.client_nom || '').trim().slice(0, 120);
      const tel     = String(cmd.client_tel || '').trim().slice(0, 30);
      const creneau = String(cmd.creneau || '').slice(0, 60);
      const articles = Array.isArray(cmd.articles) ? cmd.articles.slice(0, 40) : [];
      const total   = Number(cmd.total) || 0;

      if (!numero || !client) return json(400, { error: 'Commande incomplète.' });

      const lignesArticles = articles.map(a => `
        <tr>
          <td style="padding:8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #f1f5f9;">
            ${esc(a.nom)} <span style="color:#94a3b8;">× ${Number(a.qte) || 1}</span>
          </td>
          <td style="padding:8px 0;font-size:14px;color:#0f172a;font-weight:600;text-align:right;border-bottom:1px solid #f1f5f9;">
            ${(Number(a.prix) || 0).toFixed(2)} €
          </td>
        </tr>`).join('');

      const corps = `
        <p style="font-size:15px;color:#334155;line-height:1.7;margin:0 0 20px;">
          Nouvelle commande à préparer.
        </p>
        <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:20px;">
          ${ligne('N° de commande', numero)}
          ${ligne('Client', client)}
          ${tel ? ligne('Téléphone', tel) : ''}
          ${creneau ? ligne('Retrait souhaité', creneau) : ''}
        </table>
        <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:14px;">
          ${lignesArticles}
          <tr>
            <td style="padding:12px 0 0;font-size:15px;font-weight:800;color:#0f172a;">Total</td>
            <td style="padding:12px 0 0;font-size:15px;font-weight:800;color:#0f172a;text-align:right;">${total.toFixed(2)} €</td>
          </tr>
        </table>
        <p style="font-size:13px;color:#64748b;line-height:1.6;margin:18px 0 0;">
          Retrouvez cette commande dans l'onglet <strong>Commandes</strong> de votre back office
          pour la marquer comme prête.
        </p>`;

      await envoyerEmail({
        to: pharma.email_contact,
        toName: pharma.nom,
        subject: `Commande ${numero} — ${client}`,
        html: gabarit({
          titre: 'Nouvelle commande',
          sousTitre: pharma.nom,
          corps,
          accent: '#000046',
        }),
      });

      // ── SMS de confirmation au client ──
      let smsEnvoye = false;
      const numeroClient = normaliserNumero(tel);
      if (SMS_ACTIF && numeroClient && !quotaDepasse('sms:' + slug, SMS_MAX_JOUR)) {
        try {
          await envoyerSMS({
            numero: numeroClient,
            texte: `${pharma.nom} : commande ${numero} bien reçue.`
                 + (creneau ? ` Retrait prévu ${creneau}.` : '')
                 + ` Nous vous préviendrons dès qu'elle est prête.`,
          });
          smsEnvoye = true;
        } catch (e) {
          // Un SMS raté ne doit jamais faire échouer la commande
          console.error('SMS commande :', e.message);
        }
      }

      return json(200, { ok: true, sms: smsEnvoye });
    }

    // ═══════════════════════════════════════════
    //  3. COMMANDE PRÊTE — SMS au client
    // ═══════════════════════════════════════════
    if (body.action === 'statut') {
      const numero = String(body.numero || '').slice(0, 24);
      const tel    = normaliserNumero(body.client_tel);

      if (!SMS_ACTIF) return json(200, { ok: true, sms: false, raison: 'SMS désactivés' });
      if (!tel)       return json(200, { ok: true, sms: false, raison: 'Numéro non mobile' });
      if (quotaDepasse('sms:' + slug, SMS_MAX_JOUR)) {
        return json(200, { ok: true, sms: false, raison: 'Plafond quotidien atteint' });
      }

      await envoyerSMS({
        numero: tel,
        texte: `${pharma.nom} : votre commande ${numero} est prête. `
             + `Vous pouvez venir la retirer.`,
      });
      return json(200, { ok: true, sms: true });
    }

    return json(400, { error: 'Action inconnue' });

  } catch (err) {
    console.error('notify.js', err);
    await alerte(`🚨 <b>ÉCHEC DE NOTIFICATION</b>\n\nPharmacie : ${esc(pharma?.nom)}\n`
      + `Action : ${esc(body.action)}\n<code>${esc(err.message)}</code>`);
    return json(502, { error: "L'envoi a échoué. Réessayez dans un instant." });
  }
};
