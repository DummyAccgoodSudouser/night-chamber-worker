import {Lobby} from "./lobby";
import {GameRoom} from "./room";
import {requireAuth} from "./auth";
export {Lobby,GameRoom};

export interface Env{
  GAME_ROOM:DurableObjectNamespace<GameRoom>;
  LOBBY:DurableObjectNamespace<Lobby>;
  FIREBASE_PROJECT_ID:string;
  ALLOWED_ORIGIN:string;
}

function cors(origin:string|null,allowed:string){
  const allowedOrigin=origin===allowed?origin:allowed;
  return {
    "access-control-allow-origin":allowedOrigin,
    "access-control-allow-headers":"Authorization, Content-Type",
    "access-control-allow-methods":"GET, POST, OPTIONS",
    "access-control-max-age":"86400",
    "vary":"Origin"
  };
}
function json(data:any,status=200,req?:Request,env?:Env){
  return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8",...cors(req?.headers.get("origin")??null,env?.ALLOWED_ORIGIN??"https://night-chamber.pages.dev")}});
}
function withCors(r:Response,req:Request,env:Env){
  const h=new Headers(r.headers);
  for(const[k,v]of Object.entries(cors(req.headers.get("origin"),env.ALLOWED_ORIGIN)))h.set(k,v);
  return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
}

export default {
  async fetch(req:Request,env:Env){
    const u=new URL(req.url);
    const origin=req.headers.get("origin");
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(origin,env.ALLOWED_ORIGIN)});
    if(origin && origin!==env.ALLOWED_ORIGIN)return new Response(JSON.stringify({ok:false,message:"Origin not allowed."}),{status:403,headers:{"content-type":"application/json",...cors(origin,env.ALLOWED_ORIGIN)}});

    if(u.pathname==="/api/health"){
      return json({ok:true,version:"0.7.0",service:"night-chamber-worker",firebaseProject:env.FIREBASE_PROJECT_ID,durableObjects:true,time:new Date().toISOString()},200,req,env);
    }

    let auth:any=null;
    if(u.pathname.startsWith("/api/")||u.pathname.startsWith("/ws/")){
      const result=await requireAuth(req,env.FIREBASE_PROJECT_ID);
      if(result instanceof Response)return withCors(result,req,env);
      auth=result;
    }

    try{
      const lobby=env.LOBBY.get(env.LOBBY.idFromName("global"));

      if(req.method==="POST"&&u.pathname==="/api/rooms"){
        const b=await req.json().catch(()=>({})) as any;
        const r=await lobby.fetch(new Request("https://lobby/create",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...b,uid:auth.uid})}));
        return withCors(r,req,env);
      }

      if(req.method==="GET"&&u.pathname==="/api/rooms/public"){
        const r=await lobby.fetch(new Request("https://lobby/public"));
        return withCors(r,req,env);
      }

      const roomMatch=u.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,12})$/);
      if(req.method==="GET"&&roomMatch){
        const r=await lobby.fetch(new Request(`https://lobby/room/${roomMatch[1]}`));
        return withCors(r,req,env);
      }

      const joinMatch=u.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,12})\/join$/);
      if(req.method==="POST"&&joinMatch){
        const r=await lobby.fetch(new Request(`https://lobby/room/${joinMatch[1]}`));
        if(!r.ok)return withCors(r,req,env);
        const data=await r.json() as any;
        const room=data.room;
        if(room.players>=room.maxPlayers)return json({ok:false,message:"Room is full."},409,req,env);
        return json(room,200,req,env);
      }

      const wsMatch=u.pathname.match(/^\/ws\/([A-Z0-9]{4,12})$/);
      if(wsMatch){
        if(req.headers.get("Upgrade")!=="websocket")return json({ok:false,message:"WebSocket upgrade required."},426,req,env);
        const r=await lobby.fetch(new Request(`https://lobby/room/${wsMatch[1]}`));
        if(!r.ok)return new Response(await r.text(),{status:r.status,headers:cors(origin,env.ALLOWED_ORIGIN)});
        const data=await r.json() as any;
        const room=data.room;
        if(room.players>=room.maxPlayers)return new Response(JSON.stringify({ok:false,message:"Room is full."}),{status:409,headers:{"content-type":"application/json",...cors(origin,env.ALLOWED_ORIGIN)}});
        const stub=env.GAME_ROOM.get(env.GAME_ROOM.idFromName(room.id));
        const forwarded=new Request(req);
        forwarded.headers.set("x-room-code",wsMatch[1]);
        return stub.fetch(forwarded);
      }

      return json({ok:false,message:"API route not found."},404,req,env);
    }catch(e){
      return json({ok:false,message:e instanceof Error?e.message:"Internal server error."},500,req,env);
    }
  }
};
