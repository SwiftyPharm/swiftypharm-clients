// netlify/functions/notify-client.js
// Notification du client à la validation de sa commande
//
//   Offre Pro  →  email de confirmation
//   Offre Max  →  email + SMS
//
// Fournisseur unique : Brevo (email transactionnel + SMS)
// Variables d'environnement requises :
//   BREVO_API_KEY        — clé API Brevo (xkeysib-...)
//   BREVO_SENDER         — expéditeur SMS, 11 caractères max, sans espace
//   BREVO_FROM_EMAIL     — adresse d'envoi vérifiée dans Brevo
//   BREVO_FROM_NAME      — nom affiché (défaut : SwiftyPharm)
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BREVO_KEY   = process.env.BREVO_API_KEY;
const SMS_SENDER  = (process.env.BREVO_SENDER || 'SwiftyPharm').substring(0, 11);
const FROM_EMAIL  = process.env.BREVO_FROM_EMAIL || 'contact@swiftup.fr';
const FROM_NAME   = process.env.BREVO_FROM_NAME  || 'SwiftyPharm';

// Plafond SMS mensuel par pharmacie — protège la marge de l'offre Max
const SMS_MAX_MOIS = 150;

// ══════════════════════════════════════
//  OUTILS
// ══════════════════════════════════════

function toE164(tel) {
  if (!tel) return null;
  const n = String(tel).replace(/[^\d+]/g, '');
  if (n.startsWith('+33'))  return n;
  if (n.startsWith('0033')) return '+33' + n.slice(4);
  if (n.startsWith('33') && n.length === 11) return '+' + n;
  if (n.startsWith('0')  && n.length === 10) return '+33' + n.slice(1);
  if (n.startsWith('+'))    return n;
  return null;
}

// Les caractères non-GSM font passer le SMS en Unicode :
// 70 caractères par SMS au lieu de 160, donc coût doublé.
function sansAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/€/g, 'EUR');
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function euros(n) {
  return (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
}

// ══════════════════════════════════════
//  GABARIT EMAIL
// ══════════════════════════════════════

function gabaritEmail({ pharmacie, numero, prenom, nom, tel, debut, fin, articles, total, adresse, mapsUrl }) {
  const lignes = articles.map(a => `
    <tr>
      <td style="padding:11px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0f172a">
        ${esc(a.nom)}
        ${a.marque ? `<div style="font-size:12px;color:#94a3b8;margin-top:2px">${esc(a.marque)}</div>` : ''}
      </td>
      <td style="padding:11px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#1753ff;font-weight:700;text-align:center;white-space:nowrap">
        × ${a.qty}
      </td>
      <td style="padding:11px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0f172a;font-weight:600;text-align:right;white-space:nowrap">
        ${euros((a.prix || 0) * (a.qty || 0))}
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Commande ${esc(numero)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 14px">
<tr><td align="center">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 2px 14px rgba(15,23,42,.07)">

    <!-- Bandeau -->
    <tr>
      <td style="background:linear-gradient(135deg,#000046 0%,#1cb5e0 100%);padding:34px 28px;text-align:center">
        <div style="width:58px;height:58px;border-radius:50%;background:rgba(255,255,255,.18);margin:0 auto 16px;line-height:58px;font-size:27px">✓</div>
        <div style="font-size:21px;font-weight:800;color:#ffffff;letter-spacing:-.3px">Commande confirmée</div>
        <div style="font-size:14px;color:rgba(255,255,255,.8);margin-top:6px">${esc(pharmacie)}</div>
      </td>
    </tr>

    <!-- Numéro de commande -->
    <tr>
      <td style="padding:26px 28px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8ff;border:1px solid #dbe6ff;border-radius:14px">
          <tr>
            <td style="padding:18px 20px;text-align:center">
              <div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:1.2px;text-transform:uppercase">Numéro de commande</div>
              <div style="font-size:27px;font-weight:800;color:#1753ff;letter-spacing:1.5px;margin-top:7px;font-family:'SF Mono',Menlo,Consolas,monospace">${esc(numero)}</div>
              <div style="font-size:12px;color:#64748b;margin-top:7px">À présenter au comptoir</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Créneau -->
    <tr>
      <td style="padding:18px 28px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:14px 0;border-bottom:1px dashed #e2e8f0">
              <span style="font-size:13px;color:#64748b">Retrait</span>
              <span style="float:right;font-size:14px;font-weight:700;color:#0f172a">${esc(debut)} – ${esc(fin)}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 0;border-bottom:1px dashed #e2e8f0">
              <span style="font-size:13px;color:#64748b">Au nom de</span>
              <span style="float:right;font-size:14px;font-weight:700;color:#0f172a">${esc(prenom)} ${esc(nom)}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 0">
              <span style="font-size:13px;color:#64748b">Téléphone</span>
              <span style="float:right;font-size:14px;font-weight:700;color:#0f172a">${esc(tel)}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Articles -->
    <tr>
      <td style="padding:20px 28px 0">
        <div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:6px">Votre commande</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${lignes}
          <tr>
            <td style="padding:15px 0 0;font-size:15px;font-weight:800;color:#0f172a">Total</td>
            <td></td>
            <td style="padding:15px 0 0;font-size:19px;font-weight:800;color:#1753ff;text-align:right">${euros(total)}</td>
          </tr>
        </table>
      </td>
    </tr>

    ${adresse ? `
    <!-- Adresse -->
    <tr>
      <td style="padding:24px 28px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px">
          <tr>
            <td style="padding:16px 18px">
              <div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:6px">Où retirer</div>
              <div style="font-size:14px;color:#0f172a;line-height:1.5">${esc(adresse)}</div>
              ${mapsUrl ? `<a href="${esc(mapsUrl)}" style="display:inline-block;margin-top:11px;font-size:13px;font-weight:700;color:#1753ff;text-decoration:none">Ouvrir dans Maps →</a>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>` : ''}

    <!-- Pied -->
    <tr>
      <td style="padding:26px 28px 30px;text-align:center">
        <div style="font-size:12px;color:#94a3b8;line-height:1.6">
          Une question ? Contactez directement votre pharmacie.<br>
          Cet email confirme votre réservation, aucun paiement n'a été effectué.
        </div>
        <div style="margin-top:18px;padding-top:18px;border-top:1px solid #eef2f7;font-size:11px;color:#cbd5e1">
          Propulsé par SwiftyPharm
        </div>
      </td>
    </tr>

  </table>
</td></tr>
</table>

</body>
</html>`;
}

function gabaritTexte({ pharmacie, numero, debut, fin, articles, total, adresse }) {
  const lignes = articles.map(a => `  - ${a.nom} x${a.qty} : ${euros((a.prix||0)*(a.qty||0))}`).join('\n');
  return `${pharmacie}\n\n`
    + `Commande ${numero} confirmée.\n\n`
    + `Retrait entre ${debut} et ${fin}.\n`
    + `Présentez le numéro ${numero} au comptoir.\n\n`
    + `Votre commande :\n${lignes}\n\n`
    + `Total : ${euros(total)}\n`
    + (adresse ? `\nAdresse : ${adresse}\n` : '')
    + `\nCet email confirme votre réservation, aucun paiement n'a été effectué.\n`
    + `Propulsé par SwiftyPharm`;
}

// ══════════════════════════════════════
//  ENVOIS
// ══════════════════════════════════════

async function envoyerEmail({ destinataire, nomDestinataire, sujet, html, texte, replyTo }) {
  if (!BREVO_KEY) return { ok: false, raison: 'config' };

  try {
    const payload = {
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: destinataire, name: nomDestinataire || destinataire }],
      subject:     sujet,
      htmlContent: html,
      textContent: texte,
    };
    if (replyTo) payload.replyTo = { email: replyTo };

    const res  = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      console.error('Brevo email erreur :', res.status, data);
      return { ok: false, raison: data.message || 'api_error' };
    }
    console.log('Email envoye a', destinataire);
    return { ok: true, id: data.messageId };

  } catch (err) {
    console.error('Envoi email echoue :', err.message);
    return { ok: false, raison: err.message };
  }
}

async function envoyerSMS(destinataire, contenu) {
  if (!BREVO_KEY) return { ok: false, raison: 'config' };

  const numero = toE164(destinataire);
  if (!numero) return { ok: false, raison: 'numero_invalide' };

  const texte = sansAccents(contenu).substring(0, 300);

  try {
    const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        type: 'transactional',
        unicodeEnabled: false,
        sender: SMS_SENDER,
        recipient: numero,
        content: texte,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      console.error('Brevo SMS erreur :', res.status, data);
      return { ok: false, raison: data.message || 'api_error' };
    }
    console.log(`SMS envoye a ${numero} · ${texte.length} car. · credits : ${data.remainingCredits}`);
    return { ok: true, id: data.messageId, credits: data.remainingCredits };

  } catch (err) {
    console.error('Envoi SMS echoue :', err.message);
    return { ok: false, raison: err.message };
  }
}

function composerSMS({ pharmacie, numero, debut, fin, nbArticles, total, adresse }) {
  let m = `[${pharmacie}]\n`
    + `Commande ${numero} confirmee.\n`
    + `Retrait entre ${debut} et ${fin}.\n`
    + `${nbArticles} article${nbArticles > 1 ? 's' : ''} - ${total}\n`
    + `Presentez ce numero au comptoir.`;

  // L'adresse n'est ajoutée que si le message tient dans un seul SMS
  if (adresse) {
    const avec = m + `\n${adresse}`;
    if (sansAccents(avec).length <= 160) m = avec;
  }
  return m;
}

async function smsCeMois(slug) {
  const debutMois = new Date();
  debutMois.setDate(1);
  debutMois.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('commandes')
    .select('id', { count: 'exact', head: true })
    .eq('pharmacie_slug', slug)
    .not('sms_confirm_at', 'is', null)
    .gte('sms_confirm_at', debutMois.toISOString());

  return count || 0;
}

// ══════════════════════════════════════
//  HANDLER
// ══════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON invalide' }) };
  }

  const { slug, commandeId } = body;
  if (!slug || !commandeId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'slug et commandeId requis' }) };
  }

  const resultat = { email: null, sms: null };

  try {
    // ── Pharmacie ──
    const { data: pharma, error: errP } = await supabase
      .from('pharmacies')
      .select('nom, adresse, adresse_maps, email_contact, plan, sms_actif')
      .eq('slug', slug)
      .single();

    if (errP || !pharma) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Pharmacie introuvable' }) };
    }

    // Notifications réservées aux offres payantes
    if (pharma.plan !== 'pro' && pharma.plan !== 'max') {
      return { statusCode: 200, body: JSON.stringify({ skipped: 'plan' }) };
    }

    // ── Commande ──
    const { data: cmd, error: errC } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', commandeId)
      .single();

    if (errC || !cmd) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Commande introuvable' }) };
    }

    const arts  = Array.isArray(cmd.articles) ? cmd.articles : [];
    const nb    = arts.reduce((s, a) => s + (parseInt(a.qty) || 0), 0);
    const total = arts.reduce((s, a) => s + (parseFloat(a.prix) || 0) * (parseInt(a.qty) || 0), 0);
    const nomPharma = pharma.nom || slug;

    // ══ EMAIL — Pro et Max ══
    if (cmd.client_email && !cmd.email_confirm_at) {
      const html = gabaritEmail({
        pharmacie: nomPharma,
        numero:    cmd.numero || '',
        prenom:    cmd.client_prenom || '',
        nom:       cmd.client_nom || '',
        tel:       cmd.client_tel || '',
        debut:     cmd.heure_debut || '',
        fin:       cmd.heure_fin || '',
        articles:  arts,
        total,
        adresse:   pharma.adresse || '',
        mapsUrl:   pharma.adresse_maps || '',
      });

      const texte = gabaritTexte({
        pharmacie: nomPharma,
        numero:    cmd.numero || '',
        debut:     cmd.heure_debut || '',
        fin:       cmd.heure_fin || '',
        articles:  arts,
        total,
        adresse:   pharma.adresse || '',
      });

      resultat.email = await envoyerEmail({
        destinataire:    cmd.client_email,
        nomDestinataire: `${cmd.client_prenom || ''} ${cmd.client_nom || ''}`.trim(),
        sujet:           `Commande ${cmd.numero} confirmée — ${nomPharma}`,
        html,
        texte,
        replyTo:         pharma.email_contact || undefined,
      });

      if (resultat.email.ok) {
        await supabase.from('commandes')
          .update({ email_confirm_at: new Date().toISOString() })
          .eq('id', commandeId);
      }
    } else if (!cmd.client_email) {
      resultat.email = { skipped: 'pas_d_email' };
    } else {
      resultat.email = { skipped: 'deja_envoye' };
    }

    // ══ SMS — Max uniquement ══
    if (pharma.plan !== 'max') {
      resultat.sms = { skipped: 'plan' };
    } else if (pharma.sms_actif === false) {
      resultat.sms = { skipped: 'desactive' };
    } else if (!cmd.client_tel) {
      resultat.sms = { skipped: 'pas_de_telephone' };
    } else if (cmd.sms_consent === false) {
      resultat.sms = { skipped: 'pas_de_consentement' };
    } else if (cmd.sms_confirm_at) {
      resultat.sms = { skipped: 'deja_envoye' };
    } else {
      const envoyes = await smsCeMois(slug);
      if (envoyes >= SMS_MAX_MOIS) {
        console.warn(`Plafond SMS atteint pour ${slug} : ${envoyes}/${SMS_MAX_MOIS}`);
        resultat.sms = { skipped: 'plafond', envoyes };
      } else {
        const contenu = composerSMS({
          pharmacie:  nomPharma.substring(0, 22),
          numero:     cmd.numero || '',
          debut:      cmd.heure_debut || '',
          fin:        cmd.heure_fin || '',
          nbArticles: nb,
          total:      total.toFixed(2).replace('.', ',') + ' EUR',
          adresse:    pharma.adresse || '',
        });

        resultat.sms = await envoyerSMS(cmd.client_tel, contenu);

        if (resultat.sms.ok) {
          await supabase.from('commandes')
            .update({ sms_confirm_at: new Date().toISOString() })
            .eq('id', commandeId);
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify(resultat) };

  } catch (err) {
    console.error('Erreur notify-client :', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
