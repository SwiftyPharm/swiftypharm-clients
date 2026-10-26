// netlify/functions/bilan.js
//
// Questionnaire « Bilan de prévention » de chaque pharmacie
// (swiftypharm.fr/<slug>/bilan).
//
//   GET  /api/bilan?slug=…  → nom et logo de la pharmacie + questionnaire
//   POST /api/bilan         → envoi des réponses par email à la pharmacie
//                             (et copie au patient s'il la demande)
//
// Le questionnaire est défini UNE seule fois, ici : la page l'affiche,
// le serveur valide les réponses et rédige l'email à partir de la même
// définition. Aucune réponse libre n'est acceptée en dehors des champs
// prévus, et chaque valeur doit figurer parmi les choix proposés.
//
// ═══════════════════════════════════════════════════════════
//  RGPD : ces réponses sont des données de santé.
//  Elles ne sont JAMAIS enregistrées : ni en base, ni en fichier, ni
//  dans les journaux. Elles sont transmises par email à la pharmacie,
//  qui en est le seul destinataire (adresse lue en base, jamais dans
//  la requête). Seul un compteur anonyme (page, type, date) est ajouté.
// ═══════════════════════════════════════════════════════════
//
//  Variables d'environnement : les mêmes que notify.js
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY,
//   BREVO_SENDER_EMAIL, BREVO_SENDER_NAME

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BREVO_KEY    = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'ordonnances@swiftypharm.fr';
const SENDER_NAME  = process.env.BREVO_SENDER_NAME  || 'SwiftyPharm';

const SLUG_VALIDE  = /^[a-z0-9][a-z0-9-]{0,99}$/;
const EMAIL_VALIDE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ═══════════════════════════════════════════════════════════
//  LE QUESTIONNAIRE
//  Inspiré des auto-questionnaires officiels « Mon bilan prévention »
//  (ministère de la Santé), en version courte : il prépare l'entretien,
//  il ne le remplace pas. Les sujets les plus sensibles ne sont pas
//  questionnés en détail : le patient indique seulement s'il souhaite
//  les aborder, en toute confidentialité, avec son pharmacien.
//
//  type 'choix' : une réponse · 'multi' : plusieurs · 'texte' : libre
//  seul      : réponse qui exclut les autres dans une question 'multi'
//  si        : question affichée seulement pour certaines tranches d'âge
// ═══════════════════════════════════════════════════════════
const AGES = ['18-25 ans', '45-50 ans', '60-65 ans', '70-75 ans', 'Un autre âge'];
const FREQ = ['Jamais', 'Quelques jours', 'Plus de la moitié du temps', 'Presque tous les jours'];

const QUESTIONNAIRE = [
  {
    id: 'profil', titre: 'Votre profil',
    questions: [
      { id: 'age', label: 'Votre tranche d’âge', type: 'choix', options: AGES, obligatoire: true,
        aide: 'Le bilan de prévention concerne les 18-25, 45-50, 60-65 et 70-75 ans.' },
      { id: 'sexe', label: 'Vous êtes', type: 'choix', options: ['Une femme', 'Un homme', 'Je préfère ne pas répondre'] },
      { id: 'foyer', label: 'Vous vivez', type: 'choix', options: ['Seul(e)', 'En couple', 'En famille', 'Autre situation'] },
      { id: 'aidant', label: 'Aidez-vous régulièrement un proche âgé, malade ou en situation de handicap ?', type: 'choix', options: ['Oui', 'Non'] },
      { id: 'entourage', label: 'Pouvez-vous compter sur quelqu’un de votre entourage en cas de besoin ?', type: 'choix', options: ['Oui', 'Parfois', 'Non'] },
    ],
  },
  {
    id: 'sante', titre: 'Votre santé',
    questions: [
      { id: 'traitement', label: 'Prenez-vous un traitement régulier ?', type: 'choix', options: ['Oui', 'Non'] },
      { id: 'maladies', label: 'Êtes-vous suivi(e) pour l’une de ces maladies ?', type: 'multi',
        options: ['Diabète', 'Hypertension', 'Maladie du cœur', 'Asthme ou maladie respiratoire', 'Cancer', 'Anxiété ou dépression', 'Autre maladie', 'Aucune'],
        seul: ['Aucune'] },
      { id: 'famille', label: 'Des maladies sont-elles connues dans votre famille proche (diabète, maladie du cœur, cancer…) ?', type: 'choix', options: ['Oui', 'Non', 'Je ne sais pas'] },
      { id: 'poids', label: 'Votre poids a-t-il changé ces 6 derniers mois ?', type: 'choix', options: ['Non', 'J’ai perdu du poids', 'J’ai pris du poids'] },
      { id: 'sens', label: 'Avez-vous l’impression de moins bien voir ou entendre ?', type: 'multi', options: ['Moins bien voir', 'Moins bien entendre', 'Non'], seul: ['Non'] },
      { id: 'dentiste', label: 'Êtes-vous allé(e) chez le dentiste ces 12 derniers mois ?', type: 'choix', options: ['Oui', 'Non'] },
    ],
  },
  {
    id: 'activite', titre: 'Activité physique et alimentation',
    questions: [
      { id: 'sport', label: 'Combien de fois par semaine pratiquez-vous au moins 30 minutes d’activité physique (marche rapide, vélo, sport…) ?', type: 'choix',
        options: ['Jamais', '1 à 2 fois', '3 à 4 fois', '5 fois ou plus'] },
      { id: 'assis', label: 'Combien de temps passez-vous assis(e) chaque jour, en dehors du sommeil ?', type: 'choix',
        options: ['Moins de 2 heures', '2 à 4 heures', '4 à 7 heures', 'Plus de 7 heures'] },
      { id: 'fruits', label: 'Mangez-vous des fruits et des légumes ?', type: 'choix',
        options: ['5 portions ou plus par jour', '1 à 4 portions par jour', 'De temps en temps', 'Rarement ou jamais'] },
      { id: 'gras', label: 'Mangez-vous des produits gras, sucrés ou salés (sodas, biscuits, plats préparés…) ?', type: 'choix',
        options: ['Plusieurs fois par jour', 'Une fois par jour', 'Quelques fois par semaine', 'Rarement'] },
    ],
  },
  {
    id: 'habitudes', titre: 'Tabac, alcool et écrans',
    questions: [
      { id: 'tabac', label: 'Fumez-vous ou vapotez-vous ?', type: 'choix',
        options: ['Je n’ai jamais fumé', 'J’ai arrêté', 'Je fume', 'Je vapote', 'Je fume et je vapote'] },
      { id: 'alcool', label: 'Votre consommation d’alcool', type: 'choix',
        options: ['Je ne bois pas d’alcool', 'Au plus 2 verres par jour, avec des jours sans alcool', 'Plus de 2 verres certains jours', 'Plus de 10 verres par semaine'] },
      { id: 'ecrans', label: 'Temps passé chaque jour devant un écran, hors travail ou études', type: 'choix',
        options: ['Moins d’1 heure', '1 à 2 heures', '2 à 4 heures', 'Plus de 4 heures'] },
    ],
  },
  {
    id: 'bienetre', titre: 'Sommeil et bien-être',
    note: 'En cas de détresse, le 3114 (numéro national de prévention du suicide) répond 24 h/24 et 7 j/7, gratuitement.',
    questions: [
      { id: 'sommeil', label: 'Comment dormez-vous ?', type: 'choix', options: ['Bien', 'Parfois mal', 'Souvent mal'] },
      { id: 'stress', label: 'Ces 2 dernières semaines, vous êtes-vous senti(e) nerveux(se), anxieux(se) ou stressé(e) ?', type: 'choix', options: FREQ },
      { id: 'moral', label: 'Ces 2 dernières semaines, vous êtes-vous senti(e) triste, déprimé(e) ou sans envie ?', type: 'choix', options: FREQ },
    ],
  },
  {
    id: 'prevention', titre: 'Vaccins et dépistages',
    questions: [
      { id: 'vaccins', label: 'Êtes-vous à jour de vos vaccins ?', type: 'choix', options: ['Oui', 'Non', 'Je ne sais pas'] },
      { id: 'depistages', label: 'Quels dépistages avez-vous réalisés ces dernières années ?', type: 'multi',
        options: ['Cancer du col de l’utérus (frottis ou test HPV)', 'Cancer du sein (mammographie)', 'Cancer colorectal (test à domicile)', 'Infections sexuellement transmissibles', 'Aucun', 'Je ne sais pas'],
        seul: ['Aucun', 'Je ne sais pas'] },
      { id: 'chutes', label: 'Êtes-vous tombé(e) au cours des 12 derniers mois ?', type: 'choix', options: ['Oui', 'Non'], si: ['60-65 ans', '70-75 ans'] },
      { id: 'autonomie', label: 'Avez-vous des difficultés pour les gestes du quotidien (courses, ménage, toilette…) ?', type: 'choix', options: ['Oui', 'Non'], si: ['70-75 ans'] },
    ],
  },
  {
    id: 'sujets', titre: 'Ce dont vous souhaitez parler',
    intro: 'Choisissez les sujets à aborder pendant votre bilan. L’échange avec votre pharmacien reste confidentiel.',
    questions: [
      { id: 'sujets', label: 'Sujets à aborder', type: 'multi',
        options: ['Mieux dormir', 'Alimentation et activité physique', 'Arrêter ou réduire le tabac', 'Réduire l’alcool', 'Stress et bien-être', 'Temps passé sur les écrans',
                  'Vaccins et dépistages', 'Vie affective et sexuelle', 'Une situation difficile ou des violences', 'Chutes et autonomie'] },
      { id: 'precision', label: 'Autre chose à signaler ? (facultatif)', type: 'texte', max: 300 },
    ],
  },
];

// Étape finale, gérée à part : coordonnées et disponibilités
const JOURS    = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const MOMENTS  = ['Matin', 'Midi', 'Après-midi', 'Fin de journée'];

// ═══════════════════════════════════════════════════════════
//  OUTILS
// ═══════════════════════════════════════════════════════════
const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function sb(path, options = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const t = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ' : ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

async function envoyerEmail({ to, toName, replyTo, subject, html }) {
  const payload = { sender: { name: SENDER_NAME, email: SENDER_EMAIL }, to: [{ email: to, name: toName || to }], subject, htmlContent: html };
  if (replyTo) payload.replyTo = { email: replyTo };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Brevo email ' + res.status + ' : ' + (await res.text()).slice(0, 300));
}

// Plafond d'envois par clé et par jour (mémoire de la fonction)
const compteurs = new Map();
function quotaDepasse(cle, plafond) {
  const k = cle + ':' + new Date().toISOString().slice(0, 10);
  const n = (compteurs.get(k) || 0) + 1;
  compteurs.set(k, n);
  return n > plafond;
}

// Email sobre, texte simple (même rendu que les autres emails SwiftyPharm)
const gabarit = (corps) => `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;">
${corps}
</body></html>`;
const puce = (label, valeur) => `<li style="margin:6px 0;"><strong>${esc(label)} :</strong> ${esc(valeur)}</li>`;

// ── Validation stricte des réponses contre la définition ──
function valider(brut, age) {
  const propres = {};
  for (const etape of QUESTIONNAIRE) {
    for (const q of etape.questions) {
      if (q.si && !q.si.includes(age)) continue;
      const v = brut[q.id];
      if (v == null || v === '') continue;
      if (q.type === 'choix' && typeof v === 'string' && q.options.includes(v)) propres[q.id] = v;
      if (q.type === 'multi' && Array.isArray(v)) {
        let liste = [...new Set(v.filter(x => typeof x === 'string' && q.options.includes(x)))];
        const exclusive = liste.find(x => (q.seul || []).includes(x));
        if (exclusive) liste = [exclusive];
        if (liste.length) propres[q.id] = liste;
      }
      if (q.type === 'texte' && typeof v === 'string') {
        const t = v.replace(/\s+/g, ' ').trim().slice(0, q.max || 300);
        if (t) propres[q.id] = t;
      }
    }
  }
  return propres;
}

// Corps de l'email : les sujets demandés d'abord, puis chaque rubrique
function sectionsHtml(reponses) {
  return QUESTIONNAIRE.map(etape => {
    const lignes = etape.questions
      .filter(q => reponses[q.id] != null)
      .map(q => puce(q.label, Array.isArray(reponses[q.id]) ? reponses[q.id].join(', ') : reponses[q.id]))
      .join('');
    return lignes ? `<p style="margin:18px 0 4px;"><strong>${esc(etape.titre)}</strong></p><ul style="padding-left:20px;margin:0;">${lignes}</ul>` : '';
  }).join('');
}

// Points d'attention signalés en tête de l'email du pharmacien
function pointsAttention(r) {
  const p = [];
  if (['Plus de la moitié du temps', 'Presque tous les jours'].includes(r.moral)) p.push('moral bas fréquent ces deux dernières semaines');
  if (['Plus de la moitié du temps', 'Presque tous les jours'].includes(r.stress)) p.push('stress ou anxiété fréquents ces deux dernières semaines');
  if ((r.sujets || []).includes('Une situation difficile ou des violences')) p.push('souhaite parler d’une situation difficile ou de violences');
  if (r.chutes === 'Oui') p.push('chute au cours des 12 derniers mois');
  return p;
}

// ═══════════════════════════════════════════════════════════
//  HANDLER
// ═══════════════════════════════════════════════════════════
exports.handler = async (event) => {
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Configuration serveur incomplète' });

  // ── Lecture : pharmacie + questionnaire ──
  if (event.httpMethod === 'GET') {
    const slug = String(event.queryStringParameters?.slug || '').trim().toLowerCase();
    if (!SLUG_VALIDE.test(slug)) return json(400, { error: 'Pharmacie non identifiée' });
    try {
      const rows = await sb('pharmacies?slug=eq.' + encodeURIComponent(slug) + '&select=slug,nom,logo_url,couleur_fond,telephone&limit=1');
      if (!rows?.length) return json(404, { error: 'Pharmacie introuvable' });
      const p = rows[0];
      return json(200, {
        ok: true,
        pharmacie: { slug: p.slug, nom: p.nom || '', logo_url: p.logo_url || '', couleur_fond: p.couleur_fond || '#d2d2d2', telephone: p.telephone || '' },
        questionnaire: QUESTIONNAIRE, jours: JOURS, moments: MOMENTS,
      });
    } catch (e) {
      console.error('bilan GET', e.message);
      return json(500, { error: 'Base de données indisponible' });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée' });
  if (!BREVO_KEY) return json(500, { error: 'Configuration serveur incomplète' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Requête invalide' }); }
  if (body.site_web) return json(200, { ok: true });   // pot de miel rempli : robot

  const slug = String(body.slug || '').trim().toLowerCase();
  if (!SLUG_VALIDE.test(slug)) return json(400, { error: 'Pharmacie non identifiée' });
  if (body.consentement !== true) return json(400, { error: 'Votre accord est nécessaire pour transmettre vos réponses.' });

  const ip = String(event.headers?.['x-nf-client-connection-ip'] || event.headers?.['x-forwarded-for'] || 'inconnue').split(',')[0].trim();
  if (quotaDepasse('ip:' + ip, 10) || quotaDepasse('ph:' + slug, 200)) {
    return json(429, { error: 'Trop d’envois. Réessayez demain ou appelez votre pharmacie.' });
  }

  // Coordonnées
  const champ = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const nom   = champ(body.nom, 120);
  const tel   = champ(body.telephone, 30);
  const email = champ(body.email, 160);
  if (!nom) return json(400, { error: 'Indiquez votre nom et votre prénom.' });
  if (!/^\+?[0-9 .()-]{9,20}$/.test(tel)) return json(400, { error: 'Indiquez un numéro de téléphone valide.' });
  if (email && !EMAIL_VALIDE.test(email)) return json(400, { error: 'Adresse email invalide.' });

  const brut = body.reponses && typeof body.reponses === 'object' ? body.reponses : {};
  const age = AGES.includes(brut.age) ? brut.age : '';
  if (!age) return json(400, { error: 'Indiquez votre tranche d’âge.' });
  const reponses = valider(brut, age);
  const jours   = (Array.isArray(body.jours) ? body.jours : []).filter(j => JOURS.includes(j));
  const moments = (Array.isArray(body.moments) ? body.moments : []).filter(m => MOMENTS.includes(m));
  const dispo = [jours.join(', '), moments.join(', ')].filter(Boolean).join(' · ') || 'Non précisées';

  // Destinataire : toujours lu en base, jamais dans la requête
  let pharma;
  try {
    const rows = await sb('pharmacies?slug=eq.' + encodeURIComponent(slug) + '&select=slug,nom,email_contact&limit=1');
    if (!rows?.length) return json(404, { error: 'Pharmacie introuvable' });
    pharma = rows[0];
  } catch (e) {
    console.error('bilan pharmacie', e.message);
    return json(500, { error: 'Base de données indisponible' });
  }
  if (!EMAIL_VALIDE.test(String(pharma.email_contact || ''))) {
    return json(422, { error: 'Cette pharmacie ne peut pas encore recevoir de questionnaire. Contactez-la par téléphone.' });
  }

  const attention = pointsAttention(reponses);
  const sections = sectionsHtml(reponses);
  const corpsPharmacie = `
    <p>Bonjour, un patient a rempli le questionnaire de bilan de prévention depuis votre page SwiftyPharm. Recontactez-le pour fixer le rendez-vous.</p>
    <ul style="padding-left:20px;margin:16px 0;">
      ${puce('Patient', nom)}
      ${puce('Téléphone', tel)}
      ${email ? puce('Email', email) : ''}
      ${puce('Tranche d’âge', age)}
      ${puce('Disponibilités', dispo)}
    </ul>
    ${attention.length ? `<p><strong>À noter :</strong> ${esc(attention.join(' ; '))}.</p>` : ''}
    ${sections}
    <p style="margin-top:22px;color:#5f6368;font-size:12px;">Ce questionnaire n’est pas conservé par SwiftyPharm : cet email en est la seule copie. Il contient des données de santé, à traiter dans le respect du secret professionnel.</p>`;

  try {
    await envoyerEmail({
      to: pharma.email_contact,
      toName: pharma.nom,
      replyTo: email || undefined,
      subject: `Bilan prévention : ${nom} (${age})`,
      html: gabarit(corpsPharmacie),
    });
  } catch (e) {
    console.error('bilan email pharmacie', e.message);
    return json(502, { error: 'L’envoi a échoué. Réessayez dans un instant.' });
  }

  // Copie au patient, s'il l'a demandée (plafond par adresse IP)
  let copie = false;
  if (body.copie === true && email && !quotaDepasse('copie:' + ip, 3)) {
    try {
      await envoyerEmail({
        to: email,
        toName: nom,
        subject: `Votre questionnaire de bilan de prévention · ${pharma.nom}`,
        html: gabarit(`
          <p>Bonjour ${esc(nom)},</p>
          <p>Voici une copie des réponses transmises à ${esc(pharma.nom)}. La pharmacie vous recontactera pour fixer votre rendez-vous.</p>
          <p>Le bilan de prévention est pris en charge à 100 % par l’Assurance Maladie, sans avance de frais. Pensez à venir avec votre carte Vitale.</p>
          ${sections}
          <p style="margin-top:22px;color:#5f6368;font-size:12px;">Vous recevez cet email car vous avez demandé une copie de votre questionnaire.</p>`),
      });
      copie = true;
    } catch (e) { console.error('bilan copie', e.message); }
  }

  // Compteur anonyme pour le tableau de bord (page, type, date)
  try { await sb('evenements', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ slug, type: 'bilan' }) }); }
  catch (e) { console.error('evenement bilan', e.message); }

  return json(200, { ok: true, copie });
};

// Exposé pour les tests
exports.QUESTIONNAIRE = QUESTIONNAIRE;
