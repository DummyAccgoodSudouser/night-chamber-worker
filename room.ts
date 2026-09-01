import {DurableObject} from "cloudflare:workers";
import {Game,Mode,Saved} from "./game";
import {verifyIdToken} from "./auth";

type Env={FIREBASE_PROJECT_ID:string;LOBBY:DurableObjectNamespace};
type Session={uid:string;name:string};

export class GameRoom extends DurableObject<Env>{
  private game:Game;
  private mode:Mode="1v1";
  private code="";
  private hostUid="";
  private sessions=new Map<WebSocket,Session>();

  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    this.game=new Game("1v1");
    this.ctx.blockConcurrencyWhile(async()=>{
      this.mode=(await this.ctx.storage.get<Mode>("mode"))??"1v1";
      this.code=(await this.ctx.storage.get<string>("code"))??"";
      this.hostUid=(await this.ctx.storage.get<string>("hostUid"))??"";
      this.game=new Game(this.mode);
      const saved=await this.ctx.storage.get<Saved>("game");
      if(saved)this.game.restore(saved);
      for(const ws of this.ctx.getWebSockets()){
        const a=ws.deserializeAttachment() as Session|null;
        if(a?.uid)this.sessions.set(ws,a);
      }
    });
  }

  async fetch(req:Request){
    if(req.headers.get("Upgrade")!=="websocket")return Response.json({ok:true,code:this.code,mode:this.mode});
    const pair=new WebSocketPair();
    const client=pair[0],server=pair[1];
    this.code=req.headers.get("x-room-code")||this.code;
    if(!this.code)return new Response("Missing room code",{status:400});
    await this.ctx.storage.put("code",this.code);
    this.ctx.acceptWebSocket(server,["room"]);
    server.serializeAttachment({uid:"",name:""});
    return new Response(null,{status:101,webSocket:client});
  }

  private async lobbyAdjust(delta:number){
    if(!this.code)return;
    const lobby=this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
    await lobby.fetch(new Request("https://lobby/adjust",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:this.code,delta})}));
  }

  private async persist(){await this.ctx.storage.put("game",this.game.save());await this.ctx.storage.put("mode",this.mode)}

  private broadcast(){
    for(const ws of this.ctx.getWebSockets()){
      const s=ws.deserializeAttachment() as Session|null;
      if(s?.uid)this.safeSend(ws,{type:"state",snapshot:this.game.snapshot(s.uid)});
    }
  }

  private safeSend(ws:WebSocket,msg:any){try{if(ws.readyState===1)ws.send(JSON.stringify(msg))}catch{}}

  async webSocketMessage(ws:WebSocket,message:string|ArrayBuffer){
    if(typeof message!=="string"||message.length>12000){try{ws.close(1009,"Message too large")}catch{};return}
    let m:any;try{m=JSON.parse(message)}catch{this.safeSend(ws,{type:"error",message:"Invalid JSON."});return}
    let session=this.sessions.get(ws);

    if(!session){
      if(m.type!=="auth"||typeof m.token!=="string"){this.safeSend(ws,{type:"error",message:"WebSocket authentication required."});try{ws.close(1008,"Auth required")}catch{};return}
      try{
        const v=await verifyIdToken(m.token,this.env.FIREBASE_PROJECT_ID);
        const name=String(v.claims.name||v.claims.email||v.uid).slice(0,30);
        if(this.sessions.size>0 && [...this.sessions.values()].some(x=>x.uid===v.uid)){
          throw Error("This account is already connected to this room.");
        }
        const lobby=this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
        const hr=await lobby.fetch(new Request("https://lobby/host/"+encodeURIComponent(this.code)));
        if(!hr.ok) throw Error("Room host could not be verified.");
        const hd=await hr.json() as any;
        this.hostUid=String(hd.hostUid||"");
        await this.ctx.storage.put("hostUid",this.hostUid);
        this.game.add(v.uid,name);
        session={uid:v.uid,name};
        this.sessions.set(ws,session);
        ws.serializeAttachment(session);
        await this.lobbyAdjust(1);
        await this.persist();
        this.safeSend(ws,{type:"authenticated",snapshot:this.game.snapshot(v.uid)});
        this.broadcast();
      }catch(e){
        this.safeSend(ws,{type:"error",message:e instanceof Error?e.message:"Authentication failed."});
        try{ws.close(1008,"Authentication failed")}catch{}
      }
      return;
    }

    try{
      if(m.type==="start"){
        if(session.uid!==this.hostUid)throw Error("Only the room creator can start the match.");
        this.game.start();
      }
      else if(m.type==="fire")this.game.fire(session.uid,String(m.target));
      else if(m.type==="use_item")this.game.use(session.uid,String(m.itemId));
      else if(m.type==="ping"){this.safeSend(ws,{type:"pong"});return}
      else if(m.type==="whoami"){this.safeSend(ws,{type:"state",snapshot:this.game.snapshot(session.uid)});return}
      else throw Error("Unknown game action.");
      await this.persist();this.broadcast();
    }catch(e){this.safeSend(ws,{type:"error",message:e instanceof Error?e.message:"Game action failed."})}
  }

  async webSocketClose(ws:WebSocket){
    const s=this.sessions.get(ws);this.sessions.delete(ws);
    if(s){this.game.remove(s.uid);await this.persist();await this.lobbyAdjust(-1);this.broadcast()}
  }
  async webSocketError(ws:WebSocket){await this.webSocketClose(ws)}
}
