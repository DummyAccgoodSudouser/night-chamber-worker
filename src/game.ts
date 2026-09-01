export type Mode="1v1"|"2v2"|"4v4";type Shell="live"|"blank";type P={uid:string;username:string;team:number;charges:number;alive:boolean;items:string[];skip:boolean;sawed?:boolean};
export type Saved={mode:Mode;players:P[];shells:Shell[];turn:number;round:number;phase:"waiting"|"playing"|"finished";last:string|null};
export type Snapshot={phase:Saved["phase"];round:number;currentPlayer:string|null;remainingShells:number;players:Array<Omit<P,"items">&{itemCount:number}>;lastAction:string|null;self:{items:string[]}};
const ITEMS=["magnifier","beer","cigarettes","hand_saw","jammer","inverter","burner_phone","adrenaline","remote"];const pick=<T,>(a:T[])=>a[Math.floor(Math.random()*a.length)];
export class Game{
  players=new Map<string,P>();shells:Shell[]=[];turn=0;round=1;phase:Saved["phase"]="waiting";last:string|null=null;
  constructor(public mode:Mode){}
  max(){return this.mode==="1v1"?2:this.mode==="2v2"?4:8}
  add(uid:string,name:string){if(this.players.has(uid))throw Error("This account is already in the room.");if(this.players.size>=this.max())throw Error("Room is full.");this.players.set(uid,{uid,username:name.slice(0,30),team:this.mode==="1v1"?this.players.size:this.players.size%2,charges:3,alive:true,items:[],skip:false})}
  remove(uid:string){this.players.delete(uid);this.turn=0;if(this.players.size<2&&this.phase==="playing")this.phase="waiting"}
  alive(){return[...this.players.values()].filter(p=>p.alive)}
  current(){const a=this.alive();return a[a.length?this.turn%a.length:0]}
  start(){if(this.players.size<2)throw Error("Need at least two connected players.");if(this.phase==="playing")return;this.phase="playing";this.round=1;this.turn=0;this.deal();this.reload();this.last="Match started."}
  deal(){for(const p of this.players.values())while(p.items.length<4)p.items.push(pick(ITEMS))}
  reload(){const n=4+Math.floor(Math.random()*3),live=1+Math.floor(Math.random()*Math.max(1,n-2));this.shells=[];for(let i=0;i<live;i++)this.shells.push("live");while(this.shells.length<n)this.shells.push("blank");this.shells.sort(()=>Math.random()-.5);this.last=`Round ${this.round}: chamber loaded.`}
  use(uid:string,item:string){const p=this.players.get(uid);if(!p||!p.alive)throw Error("Player unavailable.");if(this.phase!=="playing")throw Error("The match has not started.");if(this.current()?.uid!==uid)throw Error("It is not your turn.");const i=p.items.indexOf(item);if(i<0)throw Error("That item is not available.");p.items.splice(i,1);
    if(item==="magnifier")return{private:`MAGNIFIER: ${this.shells[0]??"empty"}`};
    if(item==="beer"){this.shells.shift();if(!this.shells.length)this.reload();this.last=`${p.username} racked the shotgun.`}
    else if(item==="cigarettes"){p.charges=Math.min(3,p.charges+1);this.last=`${p.username} recovered a charge.`}
    else if(item==="hand_saw"){p.sawed=true;this.last=`${p.username} armed the next live shot.`}
    else if(item==="jammer"){const t=this.alive().find(x=>x.uid!==uid);if(t)t.skip=true;this.last=`${p.username} jammed an opponent turn.`}
    else if(item==="inverter"){if(!this.shells.length)this.reload();this.shells[0]=this.shells[0]==="live"?"blank":"live";this.last=`${p.username} inverted the chamber.`}
    else if(item==="burner_phone"){const idx=this.shells.length?Math.floor(Math.random()*this.shells.length):0;return{private:`BURNER PHONE: shell ${idx+1} is ${this.shells[idx]??"unknown"}`}}
    else if(item==="adrenaline"){const t=this.alive().find(x=>x.uid!==uid&&x.items.length);if(t){const stolen=t.items.shift()!;p.items.push(stolen);this.last=`${p.username} stole an item.`}else this.last=`${p.username} found nothing to steal.`}
    else if(item==="remote"){this.turn=Math.max(0,this.turn-1);this.last=`${p.username} reversed the turn order.`}
    return{};
  }
  fire(uid:string,target:string){const a=this.current(),t=this.players.get(target);if(this.phase!=="playing")throw Error("The match has not started.");if(!a||a.uid!==uid||!t||!t.alive)throw Error("Invalid turn or target.");if(!this.shells.length)this.reload();const s=this.shells.shift()!;if(s==="live"){const dmg=a.sawed?2:1;a.sawed=false;t.charges-=dmg;if(t.charges<=0)t.alive=false;this.last=`${a.username} fired a live shell.`;this.next()}else{this.last=`${a.username} fired a blank.`;if(target!==uid)this.next()}const alive=this.alive();if(alive.length<=1){this.phase="finished";this.last=`${alive[0]?.username??"Nobody"} wins.`}else if(!this.shells.length){this.round++;this.deal();this.reload()}}
  next(){const a=this.alive();for(let i=0;i<a.length;i++){this.turn=(this.turn+1)%a.length;if(!a[this.turn].skip)break;a[this.turn].skip=false}}
  save():Saved{return{mode:this.mode,players:[...this.players.values()].map(p=>({...p,items:[...p.items]})),shells:[...this.shells],turn:this.turn,round:this.round,phase:this.phase,last:this.last}}
  restore(s:Saved){this.players=new Map(s.players.map(p=>[p.uid,{...p,items:[...p.items]}]));this.shells=[...s.shells];this.turn=s.turn;this.round=s.round;this.phase=s.phase;this.last=s.last}
  snapshot(uid:string):Snapshot{const self=this.players.get(uid);return{phase:this.phase,round:this.round,currentPlayer:this.current()?.uid??null,remainingShells:this.shells.length,players:[...this.players.values()].map(({items,...p})=>({...p,itemCount:items.length})),lastAction:this.last,self:{items:self?.items??[]}}}
}
