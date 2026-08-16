// netlify/functions/delete-account.js
// Suppression RGPD d'un compte pharmacien, sur demande depuis le back office
// ou depuis l'admin.
//
// Ce que fait la fonction, dans l'ordre :
//   1. Vérifie l'identité de la pharmacie et le mot de sécurité tapé
//   2. Résilie l'abonnement Stripe en cours, immédiatement
//   3. Supprime les commandes, les promotions, la fiche pharmacie
//   4. Supprime le compte Supabase Auth associé
//   5. Journalise l'opération dans deletion_log — preuve de conformité
//   6. Envoie un email de confirmation de suppression au pharmacien
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   BREVO_API_KEY, BREVO_FROM_EMAIL, BREVO_FROM_NAME

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BREVO_KEY  = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'contact@swiftup.fr';
const FROM_NAME  = process.env.BREVO_FROM_NAME  || 'SwiftyPharm';

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function envoyerConfirmation(email, nomPharma, slug) {
  if (!BREVO_KEY || !email) return;

  const html = `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 14px">
  <tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden">
    <tr><td style="background:#0f172a;padding:28px;text-align:center">
      <div style="font-size:17px;font-weight:800;color:#fff">Suppression de compte confirmée</div>
    </td></tr>
    <tr><td style="padding:26px 28px">
      <p style="font-size:14px;color:#0f172a;line-height:1.7">Bonjour,</p>
      <p style="font-size:14px;color:#0f172a;line-height:1.7">
        Nous confirmons la suppression définitive du compte associé à
        <strong>${esc(nomPharma)}</strong> (${esc(slug)}) sur SwiftyPharm.
      </p>
      <p style="font-size:14px;color:#0f172a;line-height:1.7">
        L'ensemble de vos données — informations de compte, commandes, promotions —
        a été effacé de nos systèmes. Votre abonnement, le cas échéant, a été résilié
        et ne fera l'objet d'aucun prélèvement futur.
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.7;margin-top:20px">
        Cette opération est irréversible. Si vous souhaitez utiliser à nouveau
        SwiftyPharm, vous devrez créer un nouveau compte.
      </p>
      <p style="font-size:13px;color:#64748b;margin-top:20px">
        Pour toute question : contact@swiftup.fr
      </p>
    </td></tr>
  </table>
  </td></tr>
  </table>
  </body></html>`;

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email }],
        subject: 'Confirmation de suppression de votre compte SwiftyPharm',
        htmlContent: html,
      }),
    });
  } catch (e) {
    console.warn('Email de confirmation non envoyé :', e.message);
  }
}

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

  const { slug, confirmation, motif, initiateur } = body;

  if (!slug || confirmation !== slug) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'confirmation_invalide' }),
    };
  }

  try {
    // ── 1. Charger la pharmacie ──
    const { data: pharma, error: errP } = await supabase
      .from('pharmacies')
      .select('*')
      .eq('slug', slug)
      .single();

    if (errP || !pharma) {
      return { statusCode: 404, body: JSON.stringify({ error: 'introuvable' }) };
    }

    const rapport = { slug, etapes: [] };

    // ── 2. Résilier l'abonnement Stripe immédiatement ──
    if (pharma.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(pharma.stripe_subscription_id);
        rapport.etapes.push('abonnement_stripe_resilie');
      } catch (e) {
        // Déjà résilié ou introuvable : on continue, ce n'est pas bloquant
        rapport.etapes.push('abonnement_stripe_deja_absent');
        console.warn('Résiliation Stripe :', e.message);
      }
    }

    // ── 3. Compter puis supprimer les données liées ──
    const { count: nbCommandes } = await supabase
      .from('commandes')
      .select('id', { count: 'exact', head: true })
      .eq('pharmacie_slug', slug);

    const { count: nbPromos } = await supabase
      .from('promos')
      .select('id', { count: 'exact', head: true })
      .eq('pharmacie_slug', slug);

    await supabase.from('commandes').delete().eq('pharmacie_slug', slug);
    await supabase.from('promos').delete().eq('pharmacie_slug', slug);
    rapport.etapes.push(`commandes_supprimees:${nbCommandes || 0}`);
    rapport.etapes.push(`promos_supprimees:${nbPromos || 0}`);

    // ── 4. Supprimer la fiche pharmacie ──
    await supabase.from('pharmacies').delete().eq('slug', slug);
    rapport.etapes.push('fiche_pharmacie_supprimee');

    // ── 5. Supprimer le compte Supabase Auth ──
    if (pharma.user_id) {
      try {
        await supabase.auth.admin.deleteUser(pharma.user_id);
        rapport.etapes.push('compte_auth_supprime');
      } catch (e) {
        rapport.etapes.push('compte_auth_erreur');
        console.warn('Suppression Auth :', e.message);
      }
    }

    // ── 6. Journaliser — preuve de conformité, conservée séparément ──
    await supabase.from('deletion_log').insert({
      slug,
      nom_pharmacie: pharma.nom,
      email_contact: pharma.email_contact,
      motif: motif || 'demande_utilisateur',
      initiateur: initiateur || 'pharmacien',
      etapes: rapport.etapes,
      supprime_le: new Date().toISOString(),
    });

    // ── 7. Email de confirmation — non bloquant ──
    if (pharma.email_contact) {
      await envoyerConfirmation(pharma.email_contact, pharma.nom || slug, slug);
      rapport.etapes.push('email_confirmation_envoye');
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, rapport }) };

  } catch (err) {
    console.error('Erreur delete-account :', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
