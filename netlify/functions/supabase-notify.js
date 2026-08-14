// netlify/functions/supabase-notify.js
// Reçoit les webhooks base de données Supabase → notifie sur Telegram

const { sendTelegram, esc, frDate } = require('./utils/telegram');

const SECRET = process.env.SUPABASE_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Vérification du secret partagé (en-tête personnalisé côté Supabase)
  if (SECRET) {
    const received = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
    if (received !== SECRET) {
      console.warn('Secret invalide');
      return { statusCode: 401, body: 'Unauthorized' };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { type, table, record, old_record } = payload;
  console.log('Supabase webhook:', type, table);

  try {
    // ══ NOUVELLE PHARMACIE ══
    if (table === 'pharmacies' && type === 'INSERT') {
      const plan = (record.plan || 'basic').toUpperCase();
      const statut = record.subscription_status === 'pending'
        ? '⏳ En attente de paiement'
        : '✅ Actif';

      await sendTelegram(
        `🎉 <b>NOUVELLE PHARMACIE</b>\n\n` +
        `🏥 <b>${esc(record.nom || record.slug)}</b>\n` +
        `${record.soustitre ? `<i>${esc(record.soustitre)}</i>\n` : ''}` +
        `\n` +
        `📋 Offre : <b>${esc(plan)}</b>\n` +
        `${statut}\n` +
        `${record.telephone ? `📞 ${esc(record.telephone)}\n` : ''}` +
        `${record.email_contact ? `✉️ ${esc(record.email_contact)}\n` : ''}` +
        `\n` +
        `🌐 swiftypharm.fr/${esc(record.slug)}\n` +
        `🕐 ${frDate()}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🌐 Voir la page', url: `https://swiftypharm.fr/${record.slug}` },
              { text: '⚙️ Admin',        url: 'https://swiftypharm.fr/admin.html' },
            ]],
          },
        }
      );
    }

    // ══ CHANGEMENT DE PLAN / STATUT ══
    if (table === 'pharmacies' && type === 'UPDATE' && old_record) {
      const planChanged   = old_record.plan !== record.plan;
      const statusChanged = old_record.subscription_status !== record.subscription_status;

      if (planChanged && record.subscription_status === 'active') {
        await sendTelegram(
          `💳 <b>ABONNEMENT ACTIVÉ</b>\n\n` +
          `🏥 <b>${esc(record.nom || record.slug)}</b>\n` +
          `📈 ${esc((old_record.plan || 'basic').toUpperCase())} → <b>${esc((record.plan || '').toUpperCase())}</b>\n` +
          `${record.billing_period === 'yearly' ? '📅 Facturation annuelle' : '📅 Facturation mensuelle'}\n` +
          `\n🕐 ${frDate()}`
        );
      } else if (statusChanged && record.subscription_status === 'past_due') {
        await sendTelegram(
          `⚠️ <b>PAIEMENT ÉCHOUÉ</b>\n\n` +
          `🏥 <b>${esc(record.nom || record.slug)}</b>\n` +
          `${record.email_contact ? `✉️ ${esc(record.email_contact)}\n` : ''}` +
          `\nÀ relancer.\n🕐 ${frDate()}`
        );
      } else if (statusChanged && record.subscription_status === 'canceled') {
        await sendTelegram(
          `😔 <b>ABONNEMENT ANNULÉ</b>\n\n` +
          `🏥 <b>${esc(record.nom || record.slug)}</b>\n` +
          `📉 Retour en offre Basic\n` +
          `\n🕐 ${frDate()}`
        );
      }
    }

    // ══ SUPPRESSION ══
    if (table === 'pharmacies' && type === 'DELETE' && old_record) {
      await sendTelegram(
        `🗑 <b>PHARMACIE SUPPRIMÉE</b>\n\n` +
        `🏥 ${esc(old_record.nom || old_record.slug)}\n` +
        `🔓 URL libérée : /${esc(old_record.slug)}\n` +
        `\n🕐 ${frDate()}`
      );
    }

    // ══ NOUVELLE COMMANDE CLICK & COLLECT ══
    if (table === 'commandes' && type === 'INSERT') {
      const articles = Array.isArray(record.articles) ? record.articles : [];
      const lignes = articles
        .map(a => `  • ${esc(a.nom)} ×${a.qty} — ${(a.prix * a.qty).toFixed(2)} €`)
        .join('\n');
      const total = articles.reduce((s, a) => s + (a.prix || 0) * (a.qty || 0), 0);

      await sendTelegram(
        `🛒 <b>NOUVELLE COMMANDE</b>\n\n` +
        `🏥 ${esc(record.pharmacie_slug)}\n` +
        `👤 ${esc(record.client_prenom)} ${esc(record.client_nom)}\n` +
        `📞 ${esc(record.client_tel)}\n` +
        `⏰ Retrait entre <b>${esc(record.heure_debut)}</b> et <b>${esc(record.heure_fin)}</b>\n` +
        `\n📦 <b>Articles</b>\n${lignes}\n` +
        `\n💰 Total : <b>${total.toFixed(2).replace('.', ',')} €</b>\n` +
        `🕐 ${frDate()}`
      );
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error('Erreur notification:', err);
    // On renvoie 200 pour que Supabase ne réessaie pas indéfiniment
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
