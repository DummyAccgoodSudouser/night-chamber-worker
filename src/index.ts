export interface Env{GAME_ROOM:DurableObjectNamespace<GameRoom>}
export class GameRoom implements DurableObject{
 constructor(private state:DurableObjectState,_env:Env){}
 async fetch(request:Request):Promise<Response>{
  if(request.headers.get("Upgrade")!=="websocket")return new Response("Night Chamber GameRoom");
  const pair=new WebSocketPair();const client=pair[0],server=pair[1];this.state.acceptWebSocket(server);
  server.send(JSON.stringify({type:"connected",room:this.state.id.toString()}));
  return new Response(null,{status:101,webSocket:client});
 }
 async webSocketMessage(ws:WebSocket,message:string|ArrayBuffer){if(typeof message!=="string")return;try{const data=JSON.parse(message);if(data.type==="ping")ws.send(JSON.stringify({type:"pong"}));else ws.send(JSON.stringify({type:"ack",action:data.type}));}catch{ws.send(JSON.stringify({type:"error",message:"Invalid message."}));}}
 async webSocketClose(){} async webSocketError(){}
}
export default{async fetch(request:Request,env:Env){const url=new URL(request.url);if(url.pathname==="/api/health")return Response.json({ok:true,service:"night-chamber-worker",version:"0.1.0"});if(url.pathname.startsWith("/room/")){const code=url.pathname.split("/")[2];if(!code||!/^[A-Z0-9]{4,12}$/.test(code))return new Response("Invalid room code.",{status:400});const id=env.GAME_ROOM.idFromName(code);return env.GAME_ROOM.get(id).fetch(request)}return new Response("Night Chamber Worker")}};