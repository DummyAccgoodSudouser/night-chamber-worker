const JWKS_URL="https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
type Claims={aud?:string;iss?:string;sub?:string;exp?:number;iat?:number;auth_time?:number;name?:string;email?:string;[k:string]:unknown};
let cache:{keys:Record<string,CryptoKey>;until:number}|null=null;

function b64url(s:string){
  const pad=s.length%4?"=".repeat(4-s.length%4):"";
  const raw=atob(s.replace(/-/g,"+").replace(/_/g,"/")+pad);
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function decodeJson<T>(s:string){return JSON.parse(new TextDecoder().decode(b64url(s))) as T;}

async function getKeys(){
  if(cache && cache.until>Date.now()+60000) return cache.keys;
  const r=await fetch(JWKS_URL,{cf:{cacheTtl:3600}});
  if(!r.ok) throw Error(`Firebase key fetch failed (${r.status}).`);
  const data=await r.json() as {keys?:Array<JsonWebKey&{kid?:string;alg?:string}>};
  if(!Array.isArray(data.keys)) throw Error("Firebase key set is invalid.");
  const out:Record<string,CryptoKey>={};
  for(const jwk of data.keys){
    if(!jwk.kid || jwk.kty!=="RSA") continue;
    out[jwk.kid]=await crypto.subtle.importKey(
      "jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]
    );
  }
  cache={keys:out,until:Date.now()+3600000};
  return out;
}

export async function verifyIdToken(token:string,project:string){
  const parts=token.split(".");
  if(parts.length!==3) throw Error("Firebase token is malformed.");
  const header=decodeJson<{alg?:string;kid?:string}>(parts[0]);
  const claims=decodeJson<Claims>(parts[1]);
  const now=Math.floor(Date.now()/1000);
  if(header.alg!=="RS256" || !header.kid) throw Error("Unsupported Firebase token.");
  if(claims.aud!==project || claims.iss!==`https://securetoken.google.com/${project}`) throw Error("Firebase token belongs to another project.");
  if(!claims.sub || !claims.exp || claims.exp<=now) throw Error("Firebase session expired. Please log in again.");
  if(!claims.iat || claims.iat>now+60) throw Error("Firebase token time is invalid.");
  const key=(await getKeys())[header.kid];
  if(!key) throw Error("Firebase signing key not found. Try again in a moment.");
  const ok=await crypto.subtle.verify(
    {name:"RSASSA-PKCS1-v1_5"},key,b64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if(!ok) throw Error("Firebase token signature is invalid.");
  return {uid:claims.sub,claims};
}

export async function requireAuth(req:Request,project:string){
  const h=req.headers.get("authorization")||"";
  if(!h.startsWith("Bearer ")) throw new Response(JSON.stringify({ok:false,message:"Authentication required."}),{status:401,headers:{"content-type":"application/json"}});
  try{return await verifyIdToken(h.slice(7),project);}
  catch(e){
    return new Response(JSON.stringify({ok:false,message:e instanceof Error?e.message:"Unauthorized"}),{
      status:401,headers:{"content-type":"application/json"}
    });
  }
}
