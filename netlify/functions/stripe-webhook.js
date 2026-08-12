// netlify/functions/stripe-webhook.js
// Webhook Stripe → met à jour l'abonnement dans Supabase

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // clé service_role, PAS la anon
);

// Mapping Price ID Stripe → plan SwiftyPharm
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_PRO_MONTHLY]: { plan: 'pro', billing: 'monthly' },
  [process.env.STRIPE_PRICE_PRO_YEARLY]:  { plan: 'pro', billing: 'yearly'  },
  [process.env.STRIPE_PRICE_MAX_MONTHLY]: { plan: 'max', billing: 'monthly' },
  [process.env.STRIPE_PRICE_MAX_YEARLY]:  { plan: 'max', billing: 'yearly'  },
};

exports.handler = async (event) => {
  // Stripe envoie toujours en POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  // 1. Vérifier la signature — empêche les faux webhooks
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature invalide :', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Événement reçu :', stripeEvent.type);

  try {
    switch (stripeEvent.type) {

      // ── PAIEMENT INITIAL RÉUSSI ──
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const slug = session.client_reference_id;

        if (!slug) {
          console.warn('Pas de client_reference_id dans la session');
          break;
        }

        // Récupérer l'abonnement pour connaître le price ID
        let planInfo = { plan: 'pro', billing: 'monthly' };
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const priceId = sub.items.data[0]?.price?.id;
          if (PRICE_TO_PLAN[priceId]) planInfo = PRICE_TO_PLAN[priceId];
        }

        const { error } = await supabase
          .from('pharmacies')
          .update({
            plan: planInfo.plan,
            billing_period: planInfo.billing,
            subscription_status: 'active',
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            subscribed_at: new Date().toISOString(),
          })
          .eq('slug', slug);

        if (error) throw error;
        console.log(`✓ ${slug} activé en ${planInfo.plan} (${planInfo.billing})`);
        break;
      }

      // ── RENOUVELLEMENT RÉUSSI ──
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;

        const { error } = await supabase
          .from('pharmacies')
          .update({
            subscription_status: 'active',
            last_payment_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', invoice.subscription);

        if (error) throw error;
        console.log(`✓ Renouvellement OK pour ${invoice.subscription}`);
        break;
      }

      // ── PAIEMENT ÉCHOUÉ ──
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;

        const { error } = await supabase
          .from('pharmacies')
          .update({ subscription_status: 'past_due' })
          .eq('stripe_subscription_id', invoice.subscription);

        if (error) throw error;
        console.log(`⚠ Paiement échoué pour ${invoice.subscription}`);
        break;
      }

      // ── CHANGEMENT D'ABONNEMENT ──
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const priceId = sub.items.data[0]?.price?.id;
        const planInfo = PRICE_TO_PLAN[priceId];

        const updates = {
          subscription_status: sub.status === 'active' ? 'active' : sub.status,
        };
        if (planInfo) {
          updates.plan = planInfo.plan;
          updates.billing_period = planInfo.billing;
        }

        const { error } = await supabase
          .from('pharmacies')
          .update(updates)
          .eq('stripe_subscription_id', sub.id);

        if (error) throw error;
        console.log(`✓ Abonnement mis à jour : ${sub.id}`);
        break;
      }

      // ── ANNULATION ──
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;

        const { error } = await supabase
          .from('pharmacies')
          .update({
            plan: 'basic',
            subscription_status: 'canceled',
            canceled_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);

        if (error) throw error;
        console.log(`✓ Abonnement annulé, retour en Basic : ${sub.id}`);
        break;
      }

      default:
        console.log('Événement non traité :', stripeEvent.type);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('Erreur traitement webhook :', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
