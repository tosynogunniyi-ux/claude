// Measurement, and the consent it is not allowed to skip.
//
// Three separate things live here, and only the first costs the visitor
// anything:
//
//   Google Analytics 4, which loads only when GA4_MEASUREMENT_ID is set, and
//   even then starts with every storage consent DENIED. Nothing is written to
//   the visitor's browser until they say yes on the bar at the foot of the
//   page. That bar writes the same `profitna_ads` cookie the application and
//   the privacy notice already use, so one answer governs everything: Meta
//   server-side, the pixel, and this.
//
//   Verification tags for Google Search Console and Bing Webmaster Tools.
//   These are inert strings — no script, no cookie, no request — and they are
//   how those two prove you own the domain before they will show you what
//   people searched to find it.
//
//   Four conversion events, all of them a click on something already on the
//   page. No page-scroll tracking, no session recording, nothing that reads
//   a form. Somebody comparing accounting software should not be followed
//   around the internet for it.
//
// Nothing here runs on the application: /app is a signed-in product holding
// other people's books, and the figures in it are none of Google's business.

// G-XXXXXXXXXX. Anything else is a typo, and a typo quietly measuring
// nothing for a month is worse than nothing.
const MEASUREMENT_RE = /^G-[A-Z0-9]{4,20}$/;

const env = (name) => String(process.env[name] || '').trim();

const MEASUREMENT = env('GA4_MEASUREMENT_ID');
const GOOGLE_VERIFY = env('GOOGLE_SITE_VERIFICATION');
const BING_VERIFY = env('BING_SITE_VERIFICATION');

const usable = MEASUREMENT_RE.test(MEASUREMENT);

// The events worth counting. Each is a click on a link the page already has,
// recognised by where it goes, so no markup carries a tracking attribute.
const EVENTS = [
  ['start_trial_click', 'a link to the signup', "/^\\/app\\?start/"],
  ['sign_in_click', 'a link to the sign-in', null],
  ['contact_email_click', 'a mailto: link', null]
];

function warnings() {
  const out = [];
  if (MEASUREMENT && !usable) {
    out.push('GA4_MEASUREMENT_ID is set to "' + MEASUREMENT + '", which is not a measurement ' +
      'id. It should look like G-XXXXXXXXXX, from Google Analytics → Admin → Data streams. ' +
      'Nothing is being measured until it is corrected.');
  }
  if (usable && !GOOGLE_VERIFY) {
    out.push('Google Analytics is on but GOOGLE_SITE_VERIFICATION is not set, so Search ' +
      'Console cannot be claimed — which is where the searches people actually typed appear.');
  }
  return out;
}

function describe() {
  return {
    state: !MEASUREMENT ? 'off' : usable ? 'on' : 'misconfigured',
    measurement: usable ? MEASUREMENT : null,
    consent: 'denied until the visitor accepts',
    searchConsole: GOOGLE_VERIFY ? 'claimed' : 'not claimed',
    bing: BING_VERIFY ? 'claimed' : 'not claimed',
    events: EVENTS.map((e) => e[0]),
    warnings: warnings()
  };
}

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inert, and worth having even with no analytics at all.
function verification() {
  const tags = [];
  if (GOOGLE_VERIFY) tags.push('<meta name="google-site-verification" content="' + attr(GOOGLE_VERIFY) + '">');
  if (BING_VERIFY) tags.push('<meta name="msvalidate.01" content="' + attr(BING_VERIFY) + '">');
  return tags.join('\n');
}

// Consent Mode first, then the tag. In this order the tag never has a moment
// in which it is allowed to write anything.
function head() {
  if (!usable) return '';
  const id = attr(MEASUREMENT);
  return `<script>
window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',functionality_storage:'granted',security_storage:'granted',wait_for_update:600});
try{if(/(?:^|;\\s*)profitna_ads=on(?:;|$)/.test(document.cookie)){gtag('consent','update',{ad_storage:'granted',ad_user_data:'granted',ad_personalization:'granted',analytics_storage:'granted'});}}catch(e){}
gtag('js',new Date());
gtag('config','${id}',{anonymize_ip:true});
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a'):null;if(!a)return;
  var h=a.getAttribute('href')||'',p=location.pathname;
  if(/^\\/app\\?start/.test(h))gtag('event','start_trial_click',{page_path:p,link_text:(a.textContent||'').trim().slice(0,60)});
  else if(h==='/app')gtag('event','sign_in_click',{page_path:p});
  else if(/^mailto:/i.test(h))gtag('event','contact_email_click',{page_path:p});
},true);
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>`;
}

// The bar. Shown only when there is something to consent to, and only until
// the visitor has answered — the same answer the application reads.
function banner() {
  if (!usable) return '';
  return `<div id="consent" hidden>
  <p>We use Google Analytics to see which pages are read. Nothing is stored in your browser
  until you agree, and we never measure anything inside your books.
  <a href="/privacy">How we handle data</a>.</p>
  <div class="consent-buttons">
    <button type="button" data-consent="off">No thanks</button>
    <button type="button" data-consent="on" class="yes">Allow</button>
  </div>
</div>
<script>
(function(){
  var NAME='profitna_ads',bar=document.getElementById('consent');
  function read(){try{var h=('; '+document.cookie).split('; '+NAME+'=');return h.length===2?h.pop().split(';').shift():null;}catch(e){return 'off';}}
  if(read()){return;}
  bar.hidden=false;
  bar.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('[data-consent]'):null;if(!b)return;
    var v=b.getAttribute('data-consent');
    try{document.cookie=NAME+'='+v+'; Path=/; Max-Age='+(60*60*24*182)+'; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');}catch(e){}
    if(v==='on'&&window.gtag){gtag('consent','update',{ad_storage:'granted',ad_user_data:'granted',ad_personalization:'granted',analytics_storage:'granted'});}
    bar.hidden=true;
  });
})();
</script>`;
}

module.exports = { describe, verification, head, banner, usable, EVENTS };
