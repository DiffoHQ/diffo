/**
 * The document an artifact runs in — one builder for the reviewer's page
 * (src/ui/artifacts.ts, inside a sandboxed iframe) and for `diffo artifact
 * preview` (src/artifactPreview.ts, in headless Chrome), so what the agent
 * previews is what the reviewer gets.
 *
 * Our head goes first — charset, the policy, the theme, the boot script — then
 * the agent's HTML.
 */

export type ArtifactView = 'card' | 'full'

/** No network at all: images, fonts and data must be inline. Repo content a
 * reviewer is looking at can never leave the machine through an artifact. */
export const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export const SANDBOX = 'allow-scripts'

/** A fresh secret for one frame (see `frameDoc`'s `token`). */
export function newFrameToken(): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** The sandbox lets a frame navigate itself, and no policy stops that; the
 * host watches for a second load and puts this page in its place, so a
 * redirect gets one request out and nothing after it. */
export const LEFT_PAGE_ISSUE =
  'navigated away from its own page (a link, a redirect, or a meta refresh), so Diffo stopped it: keep the whole picture on one page, with no links out'
export const LEFT_PAGE_DOC =
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><body style="margin:0;padding:14px;font:13px/1.4 system-ui,sans-serif;color:#8a8a8a">This artifact tried to leave its page, so Diffo stopped it.</body>'

/** Diffo's own tokens, handed to the frame so an artifact can look native in
 * both themes without guessing colours. */
export const THEME_TOKENS = [
  '--paper',
  '--fill',
  '--fill-2',
  '--ink',
  '--ink-2',
  '--ink-3',
  '--hair',
  '--hair-2',
  '--acc',
  '--acc-wash',
  '--acc-line',
  '--add',
  '--add-tint',
  '--del',
  '--del-tint',
  '--attn',
  '--attn-wash',
  '--danger',
  '--sans',
  '--mono',
  '--r-sm',
  '--r',
] as const

/** The guide's legend — new code green, changed code amber. Same in both
 * themes, like the mermaid classDefs they mirror. */
export const LEGEND = { '--diffo-new': '#2e9e4f', '--diffo-changed': '#d99a00' }

export interface Theme {
  scheme: 'light' | 'dark'
  vars: Record<string, string>
}

const FONTS = {
  '--sans':
    '"Geist Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  '--mono':
    '"Geist Mono Variable", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  '--r-sm': '6px',
  '--r': '10px',
}

/**
 * The tokens as styles.css defines them, for a renderer with no live page to
 * read them from (the preview). A test holds these to styles.css; the page
 * itself always sends the live values.
 */
export const STATIC_THEMES: Record<'light' | 'dark', Theme> = {
  light: {
    scheme: 'light',
    vars: {
      '--paper': '#fdfcfb',
      '--fill': '#f1efeb',
      '--fill-2': '#e7e5df',
      '--ink': '#1f1d1a',
      '--ink-2': '#55524c',
      '--ink-3': '#6b675f',
      '--hair': '#e4e2dc',
      '--hair-2': '#eeece7',
      '--acc': '#3d4ccf',
      '--acc-wash': '#eceefb',
      '--acc-line': '#c5caf2',
      '--add': '#1f883d',
      '--add-tint': 'rgba(46, 160, 67, 0.06)',
      '--del': '#cf222e',
      '--del-tint': 'rgba(248, 81, 73, 0.05)',
      '--attn': '#8a5700',
      '--attn-wash': '#f7eedb',
      '--danger': '#cf222e',
      ...FONTS,
      ...LEGEND,
    },
  },
  dark: {
    scheme: 'dark',
    vars: {
      '--paper': '#1d1c1a',
      '--fill': '#272623',
      '--fill-2': '#33312d',
      '--ink': '#efede9',
      '--ink-2': '#c2bfb8',
      '--ink-3': '#9c988f',
      '--hair': '#33312d',
      '--hair-2': '#2a2926',
      '--acc': '#96a2ff',
      '--acc-wash': '#262a4a',
      '--acc-line': '#40467a',
      '--add': '#3fb950',
      '--add-tint': 'rgba(46, 160, 67, 0.08)',
      '--del': '#f85149',
      '--del-tint': 'rgba(248, 81, 73, 0.07)',
      '--attn': '#e0b050',
      '--attn-wash': '#372d16',
      '--danger': '#f85149',
      ...FONTS,
      ...LEGEND,
    },
  },
}

function rootRule(theme: Theme): string {
  const decls = Object.entries(theme.vars)
    .map(([k, v]) => `${k}:${v.replace(/[<>{}]/g, '')}`)
    .join(';')
  return `:root{${decls};color-scheme:${theme.scheme}}`
}

/**
 * Runs inside the frame, before the agent's HTML: dependency-free, and the
 * frame's whole contract with whatever renders it. It posts the page's height
 * and every problem it sees to its parent, and also writes them onto <html>
 * as `data-diffo-report` — the one channel a headless DOM dump can read.
 *
 * Problems: errors, rejections, policy blocks, `console.error`, and once the
 * page settles a blank render, a page wider than its frame, and text whose
 * colour can't be read on what is behind it (the symptom of a fixed colour
 * that suits one theme only).
 */
const BOOT = String.raw`(function(){
var de=document.documentElement,P=parent,T=__TOKEN__,assign=Object.assign;
var me=document.currentScript;if(me&&me.parentNode)me.parentNode.removeChild(me);
['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCRtpSender','RTCRtpReceiver','RTCIceCandidate','RTCSessionDescription'].forEach(function(k){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(_){}});
var post=function(m){try{P.postMessage(assign({diffoArtifact:1,t:T},m),'*')}catch(_){}};
var list=[],seen={},last=-1;
var report=function(){try{de.setAttribute('data-diffo-report',JSON.stringify({issues:list,height:last,width:de.clientWidth}))}catch(_){}};
var issue=function(t){t=String(t).slice(0,500);if(seen[t]||list.length>=8)return;seen[t]=1;list.push(t);post({type:'issue',text:t});report()};
addEventListener('error',function(e){
 if(e.target&&e.target!==window&&e.target.tagName){var el=e.target;issue('failed to load <'+el.tagName.toLowerCase()+'>'+(el.src?' '+String(el.src).slice(0,120):''));return}
 issue((e.message||'error')+(e.lineno?' (line '+e.lineno+(e.colno?':'+e.colno:'')+')':''))
},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;issue('unhandled promise rejection: '+(r&&r.message?r.message:r))});
addEventListener('securitypolicyviolation',function(e){issue('blocked by the frame (no network, inline only): '+e.violatedDirective+(e.blockedURI?' '+e.blockedURI:''))});
var ce=console.error;console.error=function(){try{issue('console.error: '+Array.prototype.map.call(arguments,function(a){return a&&a.message?a.message:typeof a==='object'?JSON.stringify(a):String(a)}).join(' '))}catch(_){}return ce.apply(console,arguments)};
var measure=function(){var b=document.body;if(!b)return;var r=b.getBoundingClientRect();var cs=getComputedStyle(b);
 var h=Math.ceil(Math.max(b.scrollHeight,r.height)+parseFloat(cs.marginTop||0)+parseFloat(cs.marginBottom||0));
 if(h!==last){last=h;post({type:'size',height:h});report()}};
var watch=function(){measure();if(window.ResizeObserver){var ro=new ResizeObserver(measure);ro.observe(de);if(document.body)ro.observe(document.body)}};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch);else watch();
var rgb=function(c){var m=/^rgba?\(([^)]+)\)/.exec(c);var p;
 if(m){p=m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);return [p[0],p[1],p[2],p.length>3?p[3]:1]}
 m=/^color\(srgb ([^)]+)\)/.exec(c);if(m){p=m[1].split(/[\s\/]+/).filter(Boolean).map(parseFloat);return [p[0]*255,p[1]*255,p[2]*255,p.length>3?p[3]:1]}
 return null};
var over=function(top,under){var a=top[3];return [top[0]*a+under[0]*(1-a),top[1]*a+under[1]*(1-a),top[2]*a+under[2]*(1-a),1]};
var lum=function(c){var f=function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2])};
var behind=function(el){var layers=[];for(var n=el;n&&n.nodeType===1;n=n.parentElement){var cs=getComputedStyle(n);
 if(cs.backgroundImage&&cs.backgroundImage!=='none')return null;
 var c=rgb(cs.backgroundColor);if(c&&c[3]>0){layers.push(c);if(c[3]>=0.99)break}}
 var base=de.getAttribute('data-theme')==='dark'?[0,0,0,1]:[255,255,255,1];
 for(var i=layers.length-1;i>=0;i--)base=over(layers[i],base);return base};
var unreadable=function(){var bad=[],tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),n,k=0;
 while((n=tw.nextNode())&&k<400){var t=(n.nodeValue||'').trim();if(!t)continue;var el=n.parentElement;
  if(!el||(el.closest&&el.closest('svg')))continue;k++;var r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
  var cs=getComputedStyle(el);if(cs.visibility==='hidden')continue;
  var fg=rgb(cs.color),bg=behind(el);if(!fg||!bg)continue;fg[3]*=parseFloat(cs.opacity||'1');if(fg[3]<0.05)continue;
  var L1=lum(over(fg,bg)),L2=lum(bg),ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
  if(ratio<2){bad.push('"'+t.slice(0,40)+'" ('+ratio.toFixed(1)+':1)');if(bad.length>=3)break}}
 return bad};
addEventListener('load',function(){measure();setTimeout(function(){
 var b=document.body;if(!b){report();return}var text=(b.innerText||'').trim();
 var drawn=Array.prototype.some.call(document.querySelectorAll('svg,canvas,img,video'),function(n){var r=n.getBoundingClientRect();return r.width>0&&r.height>0});
 if(!text&&!drawn)issue('rendered blank: no text, svg, canvas or image on the page');
 var wide=de.scrollWidth-de.clientWidth;
 if(wide>1)issue('scrolls sideways: the page is '+wide+'px wider than the '+de.clientWidth+'px it gets; let rows wrap, and give a wide table or diagram its own overflow-x:auto box');
 try{var bad=unreadable();if(bad.length)issue('text that can'+"'"+'t be read in the '+(de.getAttribute('data-theme')||'light')+' theme: '+bad.join(', ')+'; color text with var(--ink)/var(--ink-2) on var(--paper)/var(--fill), never a fixed color')}catch(_){}
 report();post({type:'ready'})},800)});
addEventListener('pagehide',function(){post({type:'leaving'})});
addEventListener('keydown',function(e){if(e.key==='Escape'&&!e.defaultPrevented)post({type:'escape'})});
addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';if(h.charAt(0)!=='#')e.preventDefault()},true);
addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||!d.diffoTheme)return;
 var s=de.style;for(var k in d.vars)s.setProperty(k,d.vars[k]);s.setProperty('color-scheme',d.scheme);
 de.setAttribute('data-theme',d.scheme)});
})();`

const BASE_STYLE =
  'html,body{margin:0}html{background:var(--paper)}body{font:14px/1.5 var(--sans,system-ui);color:var(--ink);background:transparent;padding:12px 14px;box-sizing:border-box}'

/**
 * The document a frame loads. A leading doctype is dropped (ours stays first,
 * so the page renders in standards mode); the agent's own <html>/<head>/<body>
 * tags merge into ours the way the HTML parser always merges them, its
 * <style> and <script> included.
 */
export function frameDoc(
  html: string,
  view: ArtifactView,
  theme: Theme,
  box?: { width: number; page?: true },
  /** A secret per frame: the boot script stamps every message with it, and
   * the host reads only stamped ones — a page the frame navigates to never
   * learns it. The boot script removes itself, so the agent's code can't read
   * it either. */
  token = '',
): string {
  const body = html.replace(/^\s*<!doctype[^>]*>/i, '')
  // The full view, by default, is the card's page uncut: the box's width,
  // centred, every row of it. Zero specificity, so any rule of the agent's
  // for [data-view=full] wins and the page can take the whole window.
  // A page is designed for the window, so it keeps the whole width.
  const full =
    box && !box.page
      ? `:where(html[data-view=full]) body{max-width:${box.width}px;margin:0 auto}`
      : ''
  return (
    `<!doctype html><html data-view="${view}" data-theme="${theme.scheme}"><head>` +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${rootRule(theme)}${BASE_STYLE}${full}</style>` +
    `<script>${BOOT.replace('__TOKEN__', JSON.stringify(token))}</script>` +
    `</head>${body}`
  )
}

/** What the boot script left on <html> — read back from a DOM dump. */
export interface FrameReport {
  issues: string[]
  height: number
  width: number
}

export function readFrameReport(dom: string): FrameReport | null {
  const m = /data-diffo-report="([^"]*)"/.exec(dom)
  if (!m) return null
  const json = (m[1] ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  try {
    const r = JSON.parse(json) as Partial<FrameReport> & { ready?: number }
    // The preview's host writes its tally from the start; until the frame
    // said it had settled, the page never finished loading.
    if (r.ready !== 1) return null
    return {
      issues: Array.isArray(r.issues) ? r.issues.filter((i) => typeof i === 'string') : [],
      height: typeof r.height === 'number' ? r.height : 0,
      width: typeof r.width === 'number' ? r.width : 0,
    }
  } catch {
    return null
  }
}
