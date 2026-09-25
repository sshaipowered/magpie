import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startRelay } from '../packages/relay/dist/index.js';
import { createMagpieMcp } from '../packages/mcp/dist/server.js';
// macOS canonical PTYs truncate long JSON lines before readline sees them.
const terminalMode = process.stdin.isTTY
  ? execFileSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }).trim()
  : null;
if (terminalMode) execFileSync('stty', ['-icanon', '-echo'], { stdio: 'inherit' });
const revision = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const root = resolve('.magpie/debug', new Date().toISOString().replaceAll(':','-'));
process.env.MAGPIE_HOME = resolve(root,'coordinator');
mkdirSync(process.env.MAGPIE_HOME,{recursive:true});
const relay = await startRelay(0,{host:'127.0.0.1'});
const relayUrl = `ws://127.0.0.1:${relay.port}`;
const mcp = createMagpieMcp({extension:'@debug/coordinator',relayUrl,askWaitMs:20000});
const rpc = new Client({name:'debug-coordinator',version:revision});
const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
await mcp.server.connect(serverTransport);
await rpc.connect(clientTransport);
const input = createInterface({input:process.stdin,terminal:false});
let closing = false;
async function shutdown(){
 if(closing)return; closing=true; clearTimeout(deadline); input.close();
 mcp.store.close(); await rpc.close(); await mcp.server.close(); await relay.close();
 if (terminalMode) execFileSync('stty', [terminalMode], { stdio: 'inherit' });
 console.log(JSON.stringify({type:'closed',pid:process.pid}));
 process.exit(0);
}
const deadline=setTimeout(()=>void shutdown(),15*60*1000);
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
const opened=await rpc.callTool({name:'sb_start',arguments:{topic:'Verify current runtimes, reconcile overlapping repairs, and debug terminal-state races',maxTurns:30}});
console.log(JSON.stringify({type:'ready',pid:process.pid,revision,relayUrl,root,opened}));
for await(const line of input){
 try{
  const cmd=JSON.parse(line);
  if(cmd.name==='shutdown'){await shutdown();break;}
  const result=await rpc.callTool(cmd,undefined,{timeout:45000});
  console.log(JSON.stringify({type:'reply',name:cmd.name,isError:result.isError,content:result.content}));
 }catch(error){console.log(JSON.stringify({type:'error',error:String(error)}));}
}
await shutdown();
