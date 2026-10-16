import vm from 'node:vm';
import * as sequence from '../../js/sequence.js';
import { readSource, extractFunction } from './extract-app-functions.mjs';
import { createSharedLockManager, createSharedStorageBackend, createLocalStorage } from './sandbox.mjs';
export const source = readSource('js/app.js');
export class FakeElement {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.ownText = ''; this.hidden = true; this.disabled = false; this.checked = false; this.value = ''; this.className = ''; this.attrs = {}; this.listeners = {}; this.focusCount = 0; }
  get textContent() { return this.ownText + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get options() { return this.children.filter(c => c.tagName === 'option'); }
  append(...v) { this.children.push(...v); }
  replaceChildren(...v) { this.ownText = ''; this.children = [...v]; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(k, f) { (this.listeners[k] ??= []).push(f); }
  focus() { this.focusCount++; }
  async fire(k) { for (const f of this.listeners[k] ?? []) await f({}); }
  find(cls) { return this.children.flatMap(c => typeof c === 'string' ? [] : [...(c.className.split(' ').includes(cls) ? [c] : []), ...c.find(cls)]); }
}
export const chipPairs = node => node.find('tag-chip').map(c => c.children.map(x => x.textContent));
const names = ['catalogName','catalogTag','sortTags','sortRecordTags','tagChips','tagCell','cell','catalogButton',
  'validateRandomItems','mutateRandom','restoreRandom','readRandomSets','interruptRandom','settleRandom','renderLegacyRandom',
  'randomMessage','randomAction','randomOutcomeText','randomRecordText','modeText','sequenceOutcomeText',
  'legacyActive','mutateSequence','restoreSequence','watchSequence','settleSequence','startSequence',
  'readSequenceSets','renderSequenceSets','renderRandom','importSequence','renderRandomSettings','initSequence'];
export function createHarness({ backend = createSharedStorageBackend(), locks = createSharedLockManager(), catalog = [{name:'色',items:['赤','白']},{name:'音',items:['低','高']}] } = {}) {
  const nodes = {}, $ = id => nodes[id] ??= new FakeElement(id.endsWith('saved') ? 'select' : 'div');
  const log = { confirms: [], aborts: [], started: [], decisions: [], subscriptions: [], answer: true, failDecision: false };
  let id = 0;
  const context = vm.createContext({ ...sequence, $, console, structuredClone,
    localStorage: createLocalStorage(backend), navigator: {locks},
    document: {createElement: t => new FakeElement(t), createTextNode: t => String(t)},
    el: {catalogOptions: new FakeElement(), inputLabel: {value:''}},
    confirm: m => { log.confirms.push(m); return log.answer; }, crypto: {randomUUID: () => `run-${++id}`},
    window: {addEventListener() {}},
    subscribeRandomSession(_db,_room,session,onData) { const sub = {id:session,onData,active:true}; log.subscriptions.push(sub); return () => {sub.active = false;}; },
    decideRandomSession: async (...args) => log.decisions.push(args),
    decideSequenceSession: async (...args) => { if(log.failDecision) throw Error('通信失敗'); log.decisions.push(args); },
    log,
  });
  vm.runInContext(`
    const RANDOM_KEY = 'okulab-time/random/', SEQUENCE_KEY = 'okulab-time/sequence/';
    let state = {roomId:'room',role:'start',uid:'user',busy:false,activeId:null}, roomEpoch = 1, db = {};
    let catalog = ${JSON.stringify(catalog)};
    let randomMode='free',randomBatch=null,randomSnapshot=null,randomDraft=[],randomSelection=new Set(),randomRecord;
    let randomWorking=false,stopRandom=null,sequenceRun=null,sequenceSnapshot=null,sequenceMode='free',sequenceRecord,stopSequence=null,sequenceSets=1;
    function renderControls(){renderRandom();}
    function watchRandom(){}
    function onAbort(id){log.aborts.push(id);}
    function newSessionId(){return crypto.randomUUID();}
    function confirmUnsynced(){return true;}
    function describeError(e){return e.message;}
    async function startMeasurement(press,pending){log.started.push(structuredClone(pending));}
    ${names.map(n=>extractFunction(source,n)).join('\n')}
    $('sequence-sets').value='1'; $('random-count').value='1'; initSequence();
  `,context);
  const run = code => vm.runInContext(code,context);
  const stored = () => JSON.parse(backend['okulab-time/sequence/room'] ?? 'null');
  const saveSets = sets => { backend['okulab-time/sequence/sets']=JSON.stringify(sets); };
  const notify = async record => { const sub=log.subscriptions.filter(s=>s.active).at(-1); if(sub)sub.onData(record); await new Promise(r=>setImmediate(r)); };
  return {$,run,context,log,stored,saveSets,backend,locks,notify};
}
