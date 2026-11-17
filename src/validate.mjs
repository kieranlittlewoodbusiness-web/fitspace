// Pure validation helpers, copied verbatim from app/auth.cjs (email, text, password),
// app/db.cjs (toEpoch) and app/server.cjs (num, blockData, colours, branding), with
// auth.error -> httpError. Kept byte-for-byte equivalent so behaviour does not drift.
import { httpError, uid } from './util.mjs';

function email(value){const result=String(value||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)||result.length>160)throw httpError(400,'Enter a valid email address.');return result;}
function text(value,label,max=200,min=1){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw httpError(400,`${label} must be ${min}–${max} characters.`);return value.trim();}
function password(value){if(typeof value!=='string'||value.length<12||value.length>200)throw httpError(400,'Use a password with 12–200 characters.');return value;}
function toEpoch(local){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))throw httpError(400,'Enter a valid session date and time.');const base=Date.parse(local+'Z');if(!Number.isFinite(base))throw httpError(400,'Enter a valid date.');for(const offset of [0,3600000]){const candidate=base-offset;const view=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(candidate)).replace(' ','T');if(view===local)return candidate;}throw httpError(400,'This UK time does not exist because the clocks change. Choose another time.');}
const num=(value,label,min,max)=>{const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw httpError(400,`${label} must be a whole number from ${min} to ${max}.`);return n;};
function blockData(body){const title=text(body.title,'Class name',100,3),description=text(body.description,'Description',1000,5),venue=text(body.venue,'Venue',160,3);const price=num(body.price_pence,'Price in pence',100,1000000),capacity=num(body.capacity,'Capacity',1,100);if(!Array.isArray(body.sessions)||body.sessions.length<1||body.sessions.length>52)throw httpError(400,'Add between 1 and 52 session dates.');const seen=new Set();const sessions=body.sessions.map(s=>{const epoch=toEpoch(s.starts_at);if(seen.has(epoch))throw httpError(400,'Two sessions have the same date and time.');seen.add(epoch);return {id:uid(),starts_at:s.starts_at,starts_epoch:epoch,duration_minutes:num(s.duration_minutes,'Duration',15,240)};}).sort((a,b)=>a.starts_epoch-b.starts_epoch);return {title,description,venue,price,capacity,sessions,published:body.published?1:0};}
function colours(bg,fg){const luminance=hex=>{const parts=hex.slice(1).match(/../g).map(p=>parseInt(p,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722;};const a=luminance(bg),b=luminance(fg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
function branding(body){const slug=text(body.slug,'Page address',50,3).toLowerCase();if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw httpError(400,'Use lowercase letters, numbers and hyphens for the page address.');for(const key of ['accent','background','foreground'])if(!/^#[0-9a-f]{6}$/i.test(body[key]||''))throw httpError(400,'Choose valid six-digit colours.');if(colours(body.background,body.foreground)<4.5)throw httpError(400,'Choose text and background colours with clearer contrast.');const features=Array.isArray(body.features)?body.features:[];if(features.length<1||features.length>3)throw httpError(400,'Add one to three training highlights.');return {slug,name:text(body.brand_name,'Site name',70,3),tagline:text(body.tagline,'Headline',120,5),description:text(body.description,'Introduction',700,10),about:text(body.about,'Training information',1200,10),accent:body.accent,background:body.background,foreground:body.foreground,features:features.map(x=>text(x,'Highlight',90,3)),published:body.published?1:0};}

export const MOTIVATIONS=Object.freeze([
'One missed session does not erase your progress. Your next step still matters.',
'Progress grows from showing up again, not from getting every week perfect.',
'A fresh start can be as simple as your next workout.',
'Small steps, repeated, build stronger habits.',
'You do not need a perfect week to make a positive change.',
'Your fitness journey is yours. Keep moving at a pace you can build on.',
'Consistency is built one return at a time.',
'The next session is another chance to invest in yourself.',
'Strength begins with the decision to try again.',
'Give yourself some grace, then take your next small step.',
'Keep your focus on progress you can repeat.',
'Every session is an opportunity to learn something about yourself.',
'Momentum can start again today.',
'Make room for the next positive choice.',
'Your effort matters, even when progress feels slow.',
'A strong routine leaves space to begin again.',
'You have not lost your place on the journey. Keep going.',
'The most useful workout is the next one you show up for.',
'Build confidence through the small promises you keep to yourself.',
'A little movement and a little encouragement can be a good place to restart.'
]);

export { email, text, password, toEpoch, num, blockData, colours, branding };
