import {DurableObject} from "cloudflare:workers";
export type Mode="1v1"|"2v2"|"4v4";

export class Lobby extends DurableObject {
  constructor(ctx:DurableObjectState,env:unknown){
    super(ctx,env);
    this.ctx.blockConcurrencyWhile(async()=>{
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rooms(
        code TEXT PRIMARY KEY,id TEXT NOT NULL,mode TEXT NOT NULL,visibility TEXT NOT NULL,
        max_players INTEGER NOT NULL,players INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,
        host_uid TEXT NOT NULL,created_at INTEGER NOT NULL)`);
    });
  }
  async fetch(req:Request){
    const u=new URL(req.url);
    try{
      if(req.method==="POST"&&u.pathname==="/create"){
        const b=await req.json() as {mode?:string;visibility?:string;uid?:string};
        if(!b.uid) return Response.json({ok:false,message:"Missing authenticated user."},{status:401});
        const mode:Mode=b.mode==="2v2"||b.mode==="4v4"?b.mode:"1v1";
        const visibility=b.visibility==="public"?"public":"private";
        const maxPlayers=mode==="1v1"?2:mode==="2v2"?4:8;
        let code="";
        for(let attempt=0;attempt<20;attempt++){
          const candidate=makeCode();
          const exists=this.ctx.storage.sql.exec("SELECT code FROM rooms WHERE code=?",candidate).one();
          if(!exists){code=candidate;break;}
        }
        if(!code) return Response.json({ok:false,message:"Could not generate a room code. Try again."},{status:503});
        const id=crypto.randomUUID();
        this.ctx.storage.sql.exec(
          "INSERT INTO rooms(code,id,mode,visibility,max_players,players,status,host_uid,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          code,id,mode,visibility,maxPlayers,0,"waiting",b.uid,Date.now()
        );
        return Response.json({ok:true,code,id,mode,visibility,maxPlayers,players:0,status:"waiting"});
      }
      if(req.method==="GET"&&u.pathname==="/public"){
        const rooms=this.ctx.storage.sql.exec(
          "SELECT code,id,mode,visibility,max_players as maxPlayers,players,status FROM rooms WHERE visibility='public' AND status='waiting' AND created_at>? ORDER BY created_at DESC LIMIT 30", Date.now()-2*60*60*1000
        ).toArray();
        return Response.json({ok:true,rooms});
      }
      if(req.method==="GET"&&u.pathname.startsWith("/room/")){
        const code=u.pathname.slice(6).toUpperCase();
        const room=this.ctx.storage.sql.exec(
          "SELECT code,id,mode,visibility,max_players as maxPlayers,players,status FROM rooms WHERE code=?",code
        ).one();
        return room?Response.json({ok:true,room}):Response.json({ok:false,message:"Room not found."},{status:404});
      }
      if(req.method==="POST"&&u.pathname==="/adjust"){
        const b=await req.json() as {code?:string;delta?:number};
        const code=String(b.code||"").toUpperCase();
        const row=this.ctx.storage.sql.exec("SELECT players,max_players FROM rooms WHERE code=?",code).one() as any;
        if(!row) return Response.json({ok:false,message:"Room not found."},{status:404});
        const n=Math.max(0,Math.min(Number(row.max_players),Number(row.players)+Number(b.delta||0)));
        this.ctx.storage.sql.exec("UPDATE rooms SET players=?,status=? WHERE code=?",n,n>=2?"playing":"waiting",code);
        return Response.json({ok:true,players:n,status:n>=2?"playing":"waiting"});
      }
      if(req.method==="POST"&&u.pathname==="/touch"){
        const b=await req.json() as {code?:string};
        const room=this.ctx.storage.sql.exec("SELECT code FROM rooms WHERE code=?",String(b.code||"").toUpperCase()).one();
        return room?Response.json({ok:true}):Response.json({ok:false,message:"Room not found."},{status:404});
      }
      return Response.json({ok:false,message:"Lobby route not found."},{status:404});
    }catch(e){
      return Response.json({ok:false,message:e instanceof Error?e.message:"Lobby error"},{status:500});
    }
  }
}
function makeCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes=new Uint8Array(6);crypto.getRandomValues(bytes);
  return [...bytes].map(b=>chars[b%chars.length]).join("");
}
