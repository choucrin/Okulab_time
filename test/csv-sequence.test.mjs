import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {readSource,extractFunction} from './support/extract-app-functions.mjs';
const source=readSource('js/app.js');
const header=s=>vm.runInNewContext(s.match(/const CSV_HEADER = (\[[\s\S]*?\]);/)[1]);
test('CSVの旧27列の名前と順序を保持し5列を末尾に追加、旧・新・任意の意味を維持',()=>{
 const original=execFileSync('git',['show','aa3d61657be04b623a88631af7f2cf6018be1f61:js/app.js'],{encoding:'utf8'});
 const previous=header(original),current=header(source);assert.equal(previous.length,27);assert.deepEqual([...current.slice(0,27)],[...previous]);
 assert.deepEqual([...current.slice(27)],['sequence_run_id','sequence_trial','sequence_set','sequence_position','sequence_outcome']);
 const body=extractFunction(source,'exportCsv');const expr=body.slice(body.indexOf('lines.push([')+'lines.push('.length,body.indexOf('].join(",")')+1);
 const context=vm.createContext({});vm.runInContext(`${['csv','csvText','modeText','randomOutcomeText','sequenceOutcomeText'].map(n=>extractFunction(source,n)).join('\n')}
 const formatFull=v=>v??'',toIso=formatFull,round1=formatFull,fromTimestamp=formatFull;
 var row=s=>${expr};`,context);
 const row=s=>JSON.parse(JSON.stringify(vm.runInContext(`row(${JSON.stringify(s)})`,context)));
 for(const s of [{},{mode:'free'},{mode:'random',randomBatchId:'old',randomOutcome:'discarded'}, {mode:'sequence',randomBatchId:null,sequenceRunId:'run',sequenceTrial:2,sequenceSet:1,sequencePosition:2,sequenceOutcome:'confirmed'}]){
  const r=row(s);assert.equal(r.length,32);
  if(s.mode==='sequence'){assert.equal(r[4],'順序反復');assert.equal(r[5],'');assert.equal(r[6],'');assert.deepEqual(r.slice(27),['run','2','1','2','有効']);}
  else {assert.deepEqual(r.slice(27),['','','','','']);if(s.mode==='random'){assert.equal(r[4],'ランダム');assert.equal(r[5],'old');assert.equal(r[6],'ランダム試行内のエラーデータ');}else assert.equal(r[4],'任意');}
 }
});
