const JWKS_URL="https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
type C={aud?:string;iss?:string;sub?:string;exp?:number;iat?:number;auth_time?:number;name?:string;email?:string;[k:string]:unknown};
let cache:{keys:Record<string,CryptoKey>;until:number}|null=null;
const b64url=(s:string)=>{const pad=s.length%4?"=".repeat(4-s.length%4):"";const raw=atob(s.replace(/-/g,"+").replace(/_/g,"/")+pad);return Uint8Array.from(raw,c=>c.charCodeAt(0))};
const decodeJson=<T,>(s:string)=>JSON.parse(new TextDecoder().decode(b64url(s))) as T;

async function keys(){
  if(cache && cache.until>Date.now()+60000) return cache.keys;
  const r=await fetch(JWKS_URL,{cf:{cacheTtl:3600}});
  if(!r.ok) throw Error("Firebase signing keys unavailable.");
  const data=await r.json() as {keys?:Array<JsonWebKey&{kid?:string;alg?:string;use?:string}>};
  if(!Array.isArray(data.keys)) throw Error("Firebase signing key set is invalid.");
  const out:Record<string,CryptoKey>={};
  for(const jwk of data.keys){
    if(!jwk.kid || jwk.kty!=="RSA") continue;
    out[jwk.kid]=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
  }
  cache={keys:out,until:Date.now()+3600000};
  return out;
}

export async function verify(token:string,project:string){
  const p=token.split(".");
  if(p.length!==3) throw Error("Invalid token.");
  const h=decodeJson<{alg?:string;kid?:string}>(p[0]);
  const c=decodeJson<C>(p[1]);
  const now=Math.floor(Date.now()/1000);
  if(h.alg!=="RS256"||!h.kid||c.aud!==project||c.iss!==`https://securetoken.google.com/${project}`||!c.sub||!c.exp||c.exp<=now||!c.iat||c.iat>now+60)
    throw Error("Invalid or expired Firebase token.");
  const key=(await keys())[h.kid];
  if(!key) throw Error("Firebase signing key not found.");
  const valid=await crypto.subtle.verify(
    {name:"RSASSA-PKCS1-v1_5"},key,b64url(p[2]),
    new TextEncoder().encode(`${p[0]}.${p[1]}`)
  );
  if(!valid) throw Error("Invalid Firebase signature.");
  return{uid:c.sub,claims:c};
}

export async function requireAuth(req:Request,project:string){
  const h=req.headers.get("authorization")||"";
  if(!h.startsWith("Bearer ")) throw new Response(JSON.stringify({message:"Authentication required."}),{status:401,headers:{"content-type":"application/json"}});
  try{return await verify(h.slice(7),project)}
  catch(e){throw new Response(JSON.stringify({message:e instanceof Error?e.message:"Unauthorized"}),{status:401,headers:{"content-type":"application/json"}})}
}
