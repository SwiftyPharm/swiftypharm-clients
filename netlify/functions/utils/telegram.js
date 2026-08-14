// netlify/functions/utils/telegram.js
// Petit module partagé pour envoyer des notifications Telegram

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;

/**
 * Envoie un message sur Telegram.
 * Ne fait jamais planter l'appelant : en cas d'erreur on log et on continue.
 */
async function sendTelegram(text, options = {}) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquants)');
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Telegram API error:', res.status, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram send failed:', err.message);
    return false;
  }
}

/** Échappe les caractères HTML pour éviter de casser le parse_mode */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Formate un montant en euros */
function euros(cents) {
  if (cents == null) return '—';
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

/** Date lisible en français */
function frDate(d = new Date()) {
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
}

module.exports = { sendTelegram, esc, euros, frDate };
