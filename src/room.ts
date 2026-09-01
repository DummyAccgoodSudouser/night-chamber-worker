import{DurableObject}from"cloudflare:workers";import{Game,Mode,Saved}from"./game";import{verifyIdToken}from"./auth";
type Env={FIREBASE_PROJECT_ID:string;LOBBY:DurableObjectNamespace};type Session={uid:string;name:string;host:boolean};
export class GameRoom extends DurableObject<Env>{
 private game:Game=new Game("1v1");private mode:Mode="1v1";private code="";private hostUid="";private sessions=new Map<WebSocket,Session>();
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.ctx.blockConcurrencyWhile(async()=>{this.mode=(await this.ctx.storage.get<Mode>("mode"))??"1v1";this.code=(await this.ctx.storage.get<string>("code"))??"";this.hostUid=(await this.ctx.storage.get<string>("hostUid"))??"";this.game=new Game(this.mode);const saved=await this.ctx.storage.get<Saved>("game");if(saved)this.game.restore(saved);for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment() as Session|null;if(a?.uid)this.sessions.set(ws,a)}})}
 private async adjust(n:number){if(!this.code)return;await this.env.LOBBY.get(this.env.LOBBY.idFromName("global")).fetch(new Request("https://lobby/adjust",{method:"POST",body:JSON.stringify({code:this.code,delta:n}),headers:{"content-type":"application/json"}}))}
 private async status(s:"waiting"|"playing"|"finished"){if(!this.code)return;await this.env.LOBBY.get(this.env.LOBBY.idFromName("global")).fetch(new Request("https://lobby/status",{method:"POST",body:JSON.stringify({code:this.code,status:s}),headers:{"content-type":"application/json"}}))}
 private async save(){await this.ctx.storage.put("game",this.game.save());await this.ctx.storage.put("mode",this.mode);await this.ctx.storage.put("hostUid",this.hostUid);await this.ctx.storage.put("code",this.code)}
 private send(ws:WebSocket,m:any){try{if(ws.readyState===1)ws.send(JSON.stringify(m))}catch{}}
 private broadcast(){for(const[ws,s]of this.sessions){this.send(ws,{type:"state",snapshot:this.game.snapshot(s.uid),isHost:s.host})}}
 async fetch(req:Request){if(req.headers.get("Upgrade")!=="websocket")return Response.json({ok:true,code:this.code,mode:this.mode,hostUid:this.hostUid});const pair=new WebSocketPair();const[client,server]=Object.values(pair);this.code=req.headers.get("x-room-code")||this.code;await this.ctx.storage.put("code",this.code);this.ctx.acceptWebSocket(server);server.serializeAttachment({uid:"",name:"",host:false});return new Response(null,{status:101,webSocket:client})}
 async webSocketMessage(ws:WebSocket,message:string|ArrayBuffer){
  if(typeof message!=="string"||message.length>12000){try{ws.close(1009,"Message too large")}catch{};return}let m:any;try{m=JSON.parse(message)}catch{return this.send(ws,{type:"error",message:"Invalid JSON."})}
  let s=this.sessions.get(ws);
  if(!s){if(m.type!=="auth"||typeof m.token!=="string"){this.send(ws,{type:"error",message:"WebSocket authentication required."});try{ws.close(1008,"Auth required")}catch{};return}
    try{const v=await verifyIdToken(m.token,this.env.FIREBASE_PROJECT_ID);const hr=await this.env.LOBBY.get(this.env.LOBBY.idFromName("global")).fetch(new Request("https://lobby/room/"+encodeURIComponent(this.code)));if(!hr.ok)throw Error("Room not found.");const data=await hr.json() as any;const room=data.room;if(!room)throw Error("Room data unavailable.");this.hostUid=String(room.hostUid||this.hostUid);this.mode=room.mode as Mode;await this.ctx.storage.put("mode",this.mode);await this.ctx.storage.put("hostUid",this.hostUid);const host=v.uid===this.hostUid;this.game.add(v.uid,String(v.claims.name||v.claims.email||v.uid));s={uid:v.uid,name:String(v.claims.name||v.claims.email||v.uid).slice(0,30),host};this.sessions.set(ws,s);ws.serializeAttachment(s);await this.adjust(1);await this.save();this.send(ws,{type:"authenticated",snapshot:this.game.snapshot(v.uid),isHost:host});this.broadcast()
    }catch(e){this.send(ws,{type:"error",message:e instanceof Error?e.message:"Authentication failed."});try{ws.close(1008,"Authentication failed")}catch{}}
    return;
  }
  try{
    if(m.type==="start"){
      if(s.uid!==this.hostUid)throw Error("Only the room creator can start the match.");
      this.game.start();await this.status("playing");
    }else if(m.type==="fire"){this.game.fire(s.uid,String(m.target));if(this.game.phase==="finished")await this.status("finished")}
    else if(m.type==="use_item"){const r=this.game.use(s.uid,String(m.itemId));if(r.private)this.send(ws,{type:"private",message:r.private})}
    else if(m.type==="ping"){this.send(ws,{type:"pong"});return}
    else if(m.type==="whoami"){this.send(ws,{type:"state",snapshot:this.game.snapshot(s.uid),isHost:s.host});return}
    else throw Error("Unknown game action.");
    await this.save();this.broadcast();
  }catch(e){this.send(ws,{type:"error",message:e instanceof Error?e.message:"Game action failed."})}
 }
 async webSocketClose(ws:WebSocket){const s=this.sessions.get(ws);this.sessions.delete(ws);if(s){this.game.remove(s.uid);await this.save();await this.adjust(-1);if(this.game.phase==="playing"&&this.game.players.size<2)await this.status("waiting");this.broadcast()}}
 async webSocketError(ws:WebSocket){await this.webSocketClose(ws)}
}
