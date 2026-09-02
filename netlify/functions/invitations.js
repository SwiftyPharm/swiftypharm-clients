// netlify/functions/invitations.js
//
// Gestion des invitations d'inscription — canal démarchage.
//
// Une invitation est un lien unique remis à une pharmacie qui vous a déjà
// réglé les 7,90 € en direct. Elle s'en sert pour créer son compte
// elle-même : elle choisit son mot de passe, rien ne lui est refacturé,
// et le lien devient inutilisable dès qu'il a servi.
//
// ═══════════════════════════════════════════════════
//  VARIABLES D'ENVIRONNEMENT À DÉFINIR SUR NETLIFY
//  (Site settings → Environment variables)
// ═══════════════════════════════════════════════════
//   SUPABASE_URL              https://twewgozdynowoieyqrcf.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY clé "service_role" (Supabase → Settings → API)
//   ADMIN_PW                  le mot de passe du back office admin
//   BREVO_API_KEY             clé API Brevo (pour l'envoi des emails)
//   BREVO_SENDER_EMAIL        contact@swiftup.fr
//   BREVO_SENDER_NAME         SwiftyPharm
//   SITE_URL                  https://swiftypharm.fr
//
// ⚠️ La clé service_role contourne toutes les règles de sécurité Supabase.
//    Elle ne doit JAMAIS apparaître dans du code côté navigateur.

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PW      = process.env.ADMIN_PW;
const BREVO_KEY     = process.env.BREVO_API_KEY;
const SENDER_EMAIL  = process.env.BREVO_SENDER_EMAIL || 'contact@swiftup.fr';
const SENDER_NAME   = process.env.BREVO_SENDER_NAME  || 'SwiftyPharm';
const SITE_URL      = process.env.SITE_URL || 'https://swiftypharm.fr';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ── Appel REST Supabase avec la clé service_role ──
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

// ── Email d'invitation ──
async function envoyerInvitation({ email, nom, ville, lien }) {
  if (!BREVO_KEY) {
    console.warn('BREVO_API_KEY absente — email non envoyé');
    return false;
  }

  const html = `
<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,70,.07);">

        <tr><td style="background:linear-gradient(135deg,#000046,#1cb5e0);padding:32px 34px;">
          <div style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-.4px;">SwiftyPharm</div>
          <div style="color:rgba(255,255,255,.68);font-size:13px;margin-top:5px;">Votre vitrine digitale d'officine</div>
        </td></tr>

        <tr><td style="padding:32px 34px;">
          <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 16px;">Bonjour,</p>

          <p style="font-size:14.5px;color:#334155;line-height:1.7;margin:0 0 18px;">
            Votre accès SwiftyPharm pour <strong>${nom}</strong>${ville ? ' à ' + ville : ''}
            est réglé et actif. Il ne vous reste qu'à créer votre espace pour mettre
            votre page en ligne.
          </p>

          <p style="font-size:14.5px;color:#334155;line-height:1.7;margin:0 0 26px;">
            Cliquez sur le bouton ci-dessous, choisissez votre mot de passe, et votre
            pharmacie est en ligne en quelques minutes.
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 26px;">
            <tr><td align="center" style="border-radius:11px;background:#000046;">
              <a href="${lien}" style="display:inline-block;padding:15px 38px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                Créer mon espace
              </a>
            </td></tr>
          </table>

          <div style="background:#f8fafc;border-radius:10px;padding:15px 17px;margin-bottom:22px;">
            <p style="font-size:12.5px;color:#64748b;line-height:1.6;margin:0;">
              Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
              <span style="color:#1cb5e0;word-break:break-all;">${lien}</span>
            </p>
          </div>

          <p style="font-size:13px;color:#64748b;line-height:1.7;margin:0;">
            Ce lien est personnel, valable 90 jours, et ne fonctionne qu'une seule fois.
            <strong>Aucun abonnement ne vous sera prélevé</strong> : votre accès est acquis
            définitivement.
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
      subject: 'Votre accès SwiftyPharm est prêt — créez votre espace',
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
    return json(405, { error: 'Méthode non autorisée' });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'Configuration serveur incomplète (Supabase)' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'JSON invalide' });
  }

  // ── Authentification admin ──
  if (!ADMIN_PW || body.admin_pw !== ADMIN_PW) {
    return json(401, { error: 'Accès non autorisé' });
  }

  const action = body.action;

  try {
    // ══ LISTER LES INVITATIONS EN ATTENTE ══
    if (action === 'list') {
      const rows = await sb(
        'invitations?used_at=is.null&expires_at=gt.' + new Date().toISOString()
        + '&select=token,nom_pharmacie,ville,email,canal,created_at,expires_at,email_envoye_at'
        + '&order=created_at.desc&limit=100'
      );
      return json(200, { ok: true, invitations: rows || [] });
    }

    // ══ CRÉER UNE INVITATION ══
    if (action === 'create') {
      const nom   = (body.nom_pharmacie || '').trim();
      const ville = (body.ville || '').trim();
      const email = (body.email || '').trim().toLowerCase();

      if (!nom)   return json(400, { error: 'Nom de la pharmacie requis' });
      if (!ville) return json(400, { error: 'Ville requise' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(400, { error: 'Adresse email invalide' });
      }

      // Une pharmacie déjà inscrite ne doit pas recevoir de nouveau lien
      const dejaInscrit = await sb(
        'pharmacies?select=slug&limit=1&or=(email_contact.eq.' + encodeURIComponent(email) + ')'
      );
      if (dejaInscrit && dejaInscrit.length) {
        return json(409, {
          error: 'Cette adresse est déjà rattachée au compte « ' + dejaInscrit[0].slug + ' »',
        });
      }

      // Invitation encore valable pour cette adresse : on la réutilise
      const enCours = await sb(
        'invitations?email=eq.' + encodeURIComponent(email)
        + '&used_at=is.null&expires_at=gt.' + new Date().toISOString()
        + '&select=token&limit=1'
      );

      let token;
      if (enCours && enCours.length) {
        token = enCours[0].token;
      } else {
        const slugSuggere = [nom, ville]
          .filter(Boolean)
          .map((s) =>
            s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
             .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-')
          )
          .join('-');

        const cree = await sb('invitations', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            nom_pharmacie: nom,
            ville,
            email,
            slug_suggere: slugSuggere,
            canal: body.canal || 'demarchage',
            montant_paye: body.montant_paye != null ? body.montant_paye : 7.90,
            note: body.note || null,
          }),
        });
        token = cree[0].token;
      }

      const lien = SITE_URL + '/signup.html?invite=' + token;

      let emailEnvoye = false;
      if (body.envoyer_email !== false) {
        emailEnvoye = await envoyerInvitation({ email, nom, ville, lien });
        if (emailEnvoye) {
          await sb('invitations?token=eq.' + token, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ email_envoye_at: new Date().toISOString() }),
          });
        }
      }

      return json(200, { ok: true, token, lien, email_envoye: emailEnvoye });
    }

    // ══ RENVOYER L'EMAIL ══
    if (action === 'resend') {
      const rows = await sb(
        'invitations?token=eq.' + encodeURIComponent(body.token || '')
        + '&select=token,nom_pharmacie,ville,email,used_at&limit=1'
      );
      if (!rows || !rows.length) return json(404, { error: 'Invitation introuvable' });
      if (rows[0].used_at)       return json(409, { error: 'Invitation déjà utilisée' });

      const inv  = rows[0];
      const lien = SITE_URL + '/signup.html?invite=' + inv.token;
      const ok   = await envoyerInvitation({
        email: inv.email, nom: inv.nom_pharmacie, ville: inv.ville, lien,
      });
      if (!ok) return json(502, { error: "L'envoi de l'email a échoué" });

      await sb('invitations?token=eq.' + inv.token, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ email_envoye_at: new Date().toISOString() }),
      });
      return json(200, { ok: true });
    }

    // ══ ANNULER UNE INVITATION ══
    if (action === 'cancel') {
      await sb('invitations?token=eq.' + encodeURIComponent(body.token || ''), {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Action inconnue : ' + action });
  } catch (err) {
    console.error('invitations.js', err);
    return json(500, { error: err.message });
  }
};
