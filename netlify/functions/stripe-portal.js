// netlify/functions/stripe-portal.js
// Gestion de l'abonnement depuis le back office pharmacien.
//
// Actions disponibles :
//   details  — état de l'abonnement, avec resynchronisation de Supabase sur Stripe
//   update   — portail Stripe ouvert directement sur le changement de formule
//   cancel   — portail Stripe ouvert directement sur la résiliation
//   payment  — portail Stripe ouvert directement sur le moyen de paiement
//   portal   — accueil du portail (factures, tout le reste)
//   reactivate — annule une résiliation programmée
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

// Price ID Stripe → formule SwiftyPharm
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_PRO_MONTHLY]: { plan: 'pro', billing: 'monthly' },
  [process.env.STRIPE_PRICE_PRO_YEARLY]:  { plan: 'pro', billing: 'yearly'  },
  [process.env.STRIPE_PRICE_MAX_MONTHLY]: { plan: 'max', billing: 'monthly' },
  [process.env.STRIPE_PRICE_MAX_YEARLY]:  { plan: 'max', billing: 'yearly'  },
};

// Formule → Price IDs proposés lors d'un changement
const PLAN_PRICES = {
  pro: [process.env.STRIPE_PRICE_PRO_MONTHLY, process.env.STRIPE_PRICE_PRO_YEARLY],
  max: [process.env.STRIPE_PRICE_MAX_MONTHLY, process.env.STRIPE_PRICE_MAX_YEARLY],
};

function retourUrl(slug) {
  return `https://swiftypharm.fr/backoffice.html?slug=${encodeURIComponent(slug)}&tab=offre`;
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

  const { slug, action, plan: planCible, periode } = body;

  if (!slug) {
    return { statusCode: 400, body: JSON.stringify({ error: 'slug requis' }) };
  }

  try {
    const { data: pharma, error } = await supabase
      .from('pharmacies')
      .select('slug, nom, plan, subscription_status, stripe_customer_id, stripe_subscription_id, billing_period, subscribed_at, last_payment_at')
      .eq('slug', slug)
      .single();

    if (error || !pharma) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Pharmacie introuvable' }) };
    }

    // ══════════════════════════════════════
    //  DÉTAILS + RESYNCHRONISATION
    // ══════════════════════════════════════
    if (action === 'details') {
      const details = {
        plan:               pharma.plan || 'basic',
        statut:             pharma.subscription_status || 'none',
        periodicite:        pharma.billing_period || null,
        abonne_depuis:      pharma.subscribed_at || null,
        dernier_paiement:   pharma.last_payment_at || null,
        prochaine_echeance: null,
        montant:            null,
        resiliation_prevue: false,
        fin_periode:        null,
        carte:              null,
        a_un_client_stripe: !!pharma.stripe_customer_id,
      };

      if (pharma.stripe_subscription_id) {
        try {
          const sub = await stripe.subscriptions.retrieve(
            pharma.stripe_subscription_id,
            { expand: ['default_payment_method'] }
          );

          // ── Stripe fait autorité : on aligne Supabase si besoin ──
          const item     = sub.items?.data?.[0];
          const priceId  = item?.price?.id;
          const infoPlan = PRICE_TO_PLAN[priceId];

          let planReel   = pharma.plan;
          let statutReel = pharma.subscription_status;

          if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
            planReel   = 'basic';
            statutReel = 'canceled';
          } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
            statutReel = 'past_due';
            if (infoPlan) planReel = infoPlan.plan;
          } else if (sub.status === 'active' || sub.status === 'trialing') {
            statutReel = 'active';
            if (infoPlan) planReel = infoPlan.plan;
          }

          const periodeReelle = infoPlan ? infoPlan.billing : pharma.billing_period;

          // Écriture uniquement si un écart existe
          if (planReel !== pharma.plan
              || statutReel !== pharma.subscription_status
              || periodeReelle !== pharma.billing_period) {

            await supabase.from('pharmacies').update({
              plan: planReel,
              subscription_status: statutReel,
              billing_period: periodeReelle,
            }).eq('slug', slug);

            console.log(`Resync ${slug} : ${pharma.plan}/${pharma.subscription_status} → ${planReel}/${statutReel}`);
          }

          details.plan        = planReel;
          details.statut      = statutReel;
          details.periodicite = periodeReelle;

          details.prochaine_echeance = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString() : null;
          details.resiliation_prevue = sub.cancel_at_period_end === true;
          details.fin_periode = sub.cancel_at
            ? new Date(sub.cancel_at * 1000).toISOString()
            : (sub.cancel_at_period_end && sub.current_period_end
                ? new Date(sub.current_period_end * 1000).toISOString() : null);

          if (item?.price?.unit_amount != null) {
            details.montant = item.price.unit_amount / 100;
          }

          const pm = sub.default_payment_method;
          if (pm && pm.card) {
            details.carte = {
              marque: pm.card.brand,
              fin:    pm.card.last4,
              expire: `${String(pm.card.exp_month).padStart(2,'0')}/${String(pm.card.exp_year).slice(-2)}`,
            };
          }

        } catch (e) {
          // Abonnement introuvable côté Stripe : il a été supprimé
          if (e.code === 'resource_missing') {
            await supabase.from('pharmacies').update({
              plan: 'basic',
              subscription_status: 'canceled',
              stripe_subscription_id: null,
            }).eq('slug', slug);
            details.plan   = 'basic';
            details.statut = 'canceled';
            console.log(`Abonnement introuvable pour ${slug} — retour en Basic`);
          } else {
            console.warn('Lecture abonnement Stripe :', e.message);
          }
        }
      }

      return { statusCode: 200, body: JSON.stringify(details) };
    }

    // ══════════════════════════════════════
    //  RÉACTIVER UN ABONNEMENT RÉSILIÉ
    // ══════════════════════════════════════
    if (action === 'reactivate') {
      if (!pharma.stripe_subscription_id) {
        return { statusCode: 400, body: JSON.stringify({ error: 'aucun_abonnement' }) };
      }
      await stripe.subscriptions.update(pharma.stripe_subscription_id, {
        cancel_at_period_end: false,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ══════════════════════════════════════
    //  FLUX DU PORTAIL STRIPE
    // ══════════════════════════════════════
    if (!pharma.stripe_customer_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'aucun_abonnement' }) };
    }

    const params = {
      customer:   pharma.stripe_customer_id,
      return_url: retourUrl(slug),
    };

    // Changement de formule — atterrit directement sur la sélection
    if (action === 'update') {
      if (!pharma.stripe_subscription_id) {
        return { statusCode: 400, body: JSON.stringify({ error: 'aucun_abonnement' }) };
      }

      const flow = {
        type: 'subscription_update',
        subscription_update: { subscription: pharma.stripe_subscription_id },
      };

      // Si une formule précise est demandée, on préselectionne son tarif
      if (planCible && PLAN_PRICES[planCible]) {
        const idx    = periode === 'yearly' ? 1 : 0;
        const priceId = PLAN_PRICES[planCible][idx];

        if (priceId) {
          try {
            const sub  = await stripe.subscriptions.retrieve(pharma.stripe_subscription_id);
            const item = sub.items?.data?.[0];

            if (item) {
              flow.type = 'subscription_update_confirm';
              flow.subscription_update_confirm = {
                subscription: pharma.stripe_subscription_id,
                items: [{ id: item.id, price: priceId, quantity: 1 }],
              };
              delete flow.subscription_update;
            }
          } catch (e) {
            console.warn('Préselection tarif impossible :', e.message);
          }
        }
      }

      params.flow_data = flow;
    }

    // Résiliation — atterrit directement sur la confirmation d'annulation
    if (action === 'cancel') {
      if (!pharma.stripe_subscription_id) {
        return { statusCode: 400, body: JSON.stringify({ error: 'aucun_abonnement' }) };
      }
      params.flow_data = {
        type: 'subscription_cancel',
        subscription_cancel: { subscription: pharma.stripe_subscription_id },
      };
    }

    // Moyen de paiement
    if (action === 'payment') {
      params.flow_data = { type: 'payment_method_update' };
    }

    let session;
    try {
      session = await stripe.billingPortal.sessions.create(params);
    } catch (e) {
      // Si le flux ciblé n'est pas autorisé dans la configuration du portail,
      // on retombe sur l'accueil plutôt que d'échouer.
      console.warn('Flux ciblé refusé, repli sur l\'accueil :', e.message);
      session = await stripe.billingPortal.sessions.create({
        customer:   pharma.stripe_customer_id,
        return_url: retourUrl(slug),
      });
    }

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };

  } catch (err) {
    console.error('Erreur stripe-portal :', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
