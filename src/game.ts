export type Mode="1v1"|"2v2"|"4v4";export type Shell="live"|"blank";
type Player={uid:string;username:string;team:number;charges:number;alive:boolean;items:string[];skipNext:boolean};
export type Snapshot={phase:"waiting"|"playing"|"finished";round:number;currentPlayer:string|null;remainingShells:number;players:Array<Omit<Player,"items">&{itemCount:number}>;lastAction:string|null;self:{items:string[]}};
type Saved={mode:Mode;players:Player[];shells:Shell[];currentIndex:number;round:number;phase:Snapshot["phase"];lastAction:string|null};
const ITEMS=["scanner","rack_can","med_pack","cut_barrel","restraint","polarity","signal","adrenal","jammer"];
const pick=<T,>(a:T[])=>a[Math.floor(Math.random()*a.length)];
export class GameEngine{
 private players=new Map<string,Player>();private shells:Shell[]=[];private currentIndex=0;private round=1;private phase:Snapshot["phase"]="waiting";private lastAction:string|null=null;
 constructor(readonly mode:Mode){}
 maxPlayers(){return this.mode==="1v1"?2:this.mode==="2v2"?4:8}
 hasPlayer(uid:string){return this.players.has(uid)}
 addPlayer(uid:string,username:string){if(this.players.has(uid))return false;if(this.players.size>=this.maxPlayers())throw new Error("Room is full.");const team=this.mode==="1v1"?this.players.size:this.players.size%2;this.players.set(uid,{uid,username,team,charges:3,alive:true,items:[],skipNext:false});return true}
 removePlayer(uid:string){this.players.delete(uid);this.currentIndex=0}
 start(){if(this.players.size<2)throw new Error("Need at least two players.");if(this.phase==="playing")return;this.phase="playing";this.round=1;this.currentIndex=0;this.dealItems();this.reload()}
 private dealItems(){for(const p of this.players.values())while(p.items.length<4)p.items.push(pick(ITEMS))}
 private reload(){const count=Math.floor(Math.random()*4)+4;const live=Math.max(1,Math.floor(Math.random()*(count-1))+1);this.shells=[];for(let i=0;i<live;i++)this.shells.push("live");while(this.shells.length<count)this.shells.push("blank");this.shells.sort(()=>Math.random()-.5);this.lastAction=`Round ${this.round} loaded.`}
 private alive(){return[...this.players.values()].filter(p=>p.alive)}
 private current(){const a=this.alive();return a.length?a[this.currentIndex%a.length]:null}
 snapshotFor(uid:string):Snapshot{const self=this.players.get(uid);return{phase:this.phase,round:this.round,currentPlayer:this.current()?.uid??null,remainingShells:this.shells.length,players:[...this.players.values()].map(({items,...p})=>({...p,itemCount:items.length})),lastAction:this.lastAction,self:{items:self?[...self.items]:[]}}}
 serialize():Saved{return{mode:this.mode,players:[...this.players.values()].map(p=>({...p,items:[...p.items]})),shells:[...this.shells],currentIndex:this.currentIndex,round:this.round,phase:this.phase,lastAction:this.lastAction}}
 restore(s:Saved){this.players=new Map(s.players.map(p=>[p.uid,{...p,items:[...p.items]}]));this.shells=[...s.shells];this.currentIndex=s.currentIndex;this.round=s.round;this.phase=s.phase;this.lastAction=s.lastAction}
 useItem(uid:string,itemId:string){const p=this.players.get(uid);if(!p||!p.alive)throw new Error("Player unavailable.");if(this.current()?.uid!==uid)throw new Error("Not your turn.");const i=p.items.indexOf(itemId);if(i<0)throw new Error("Item not owned.");p.items.splice(i,1);if(itemId==="scanner")return{privateMessage:`Scanner result: ${this.shells[0]??"empty"}`};if(itemId==="rack_can"){this.shells.shift();this.lastAction=`${p.username} ejected a shell.`;if(!this.shells.length)this.reload()}else if(itemId==="med_pack"){p.charges=Math.min(3,p.charges+1);this.lastAction=`${p.username} restored one charge.`}else if(itemId==="restraint"){const t=this.alive().find(x=>x.uid!==uid);if(t)t.skipNext=true;this.lastAction=`${p.username} restrained an opponent.`}else{p.items.push(itemId);this.lastAction=`${p.username} used ${itemId}.`}return{}}
 fire(uid:string,targetUid:string){const shooter=this.players.get(uid),target=this.players.get(targetUid);if(!shooter||!target||!shooter.alive||!target.alive)throw new Error("Invalid player.");if(this.current()?.uid!==uid)throw new Error("Not your turn.");if(!this.shells.length)this.reload();const shell=this.shells.shift()!;if(shell==="live"){target.charges--;if(target.charges<=0)target.alive=false;this.lastAction=`${shooter.username} fired.`;this.advance()}else{this.lastAction=`${shooter.username} fired a blank.`;if(targetUid!==uid)this.advance()}const a=this.alive();if(a.length<=1){this.phase="finished";this.lastAction=`${a[0]?.username??"Nobody"} wins.`}else if(!this.shells.length){this.round++;this.dealItems();this.reload()}}
 private advance(){const a=this.alive();if(!a.length)return;for(let i=0;i<a.length;i++){this.currentIndex=(this.currentIndex+1)%a.length;const n=a[this.currentIndex];if(n.skipNext){n.skipNext=false;continue}break}}
}
