// netlify/functions/stripe-portal.js
// Ouvre le portail client Stripe pour qu'un pharmacien gère son abonnement :
// changement de formule, mise à jour de carte, factures, résiliation.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

  const { slug, action } = body;

  if (!slug) {
    return { statusCode: 400, body: JSON.stringify({ error: 'slug requis' }) };
  }

  try {
    // ── Charger la pharmacie ──
    const { data: pharma, error } = await supabase
      .from('pharmacies')
      .select('slug, nom, plan, subscription_status, stripe_customer_id, stripe_subscription_id, billing_period, subscribed_at, last_payment_at')
      .eq('slug', slug)
      .single();

    if (error || !pharma) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Pharmacie introuvable' }) };
    }

    // ══ Action : récupérer les détails de l'abonnement ══
    if (action === 'details') {
      const details = {
        plan:                pharma.plan || 'basic',
        statut:              pharma.subscription_status || 'none',
        periodicite:         pharma.billing_period || null,
        abonne_depuis:       pharma.subscribed_at || null,
        dernier_paiement:    pharma.last_payment_at || null,
        prochaine_echeance:  null,
        montant:             null,
        resiliation_prevue:  false,
        fin_periode:         null,
        carte:               null,
      };

      // Enrichir avec les données Stripe si un abonnement existe
      if (pharma.stripe_subscription_id) {
        try {
          const sub = await stripe.subscriptions.retrieve(
            pharma.stripe_subscription_id,
            { expand: ['default_payment_method'] }
          );

          details.prochaine_echeance = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;
          details.resiliation_prevue = sub.cancel_at_period_end === true;
          details.fin_periode        = sub.cancel_at
            ? new Date(sub.cancel_at * 1000).toISOString()
            : null;

          const item = sub.items?.data?.[0];
          if (item?.price?.unit_amount != null) {
            details.montant = item.price.unit_amount / 100;
          }

          const pm = sub.default_payment_method;
          if (pm && pm.card) {
            details.carte = {
              marque: pm.card.brand,
              fin:    pm.card.last4,
              expire: `${String(pm.card.exp_month).padStart(2, '0')}/${String(pm.card.exp_year).slice(-2)}`,
            };
          }
        } catch (e) {
          console.warn('Abonnement Stripe illisible :', e.message);
        }
      }

      return { statusCode: 200, body: JSON.stringify(details) };
    }

    // ══ Action : ouvrir le portail client ══
    if (action === 'portal') {
      if (!pharma.stripe_customer_id) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'aucun_abonnement' })
        };
      }

      const session = await stripe.billingPortal.sessions.create({
        customer:   pharma.stripe_customer_id,
        return_url: `https://swiftypharm.fr/backoffice.html?slug=${slug}&tab=offre`,
      });

      return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'action inconnue' }) };

  } catch (err) {
    console.error('Erreur stripe-portal :', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
