const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function fingerprint(record) {
  return hash(JSON.stringify({id:record.id,harnessId:record.harnessId,nativeSessionId:record.nativeSessionId,messages:record.messages,coreState:record.coreState,tools:record.tools}));
}
function atomic(file, value) { const tmp = `${file}.${process.pid}.repair.tmp`; fs.writeFileSync(tmp,JSON.stringify(value,null,2)); fs.renameSync(tmp,file); }
function applyPendingHistoryRepair(directory) {
  const manifestFile = path.join(path.dirname(directory),'runtime','pending-history-repair.json');
  if (!fs.existsSync(manifestFile)) return {status:'none'};
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.version!==1 || path.resolve(manifest.dataDirectory)!==path.resolve(directory) || !/^[a-f0-9-]{36}$/.test(manifest.threadId)) throw new Error('Invalid pending history repair manifest');
  const recordFile=path.join(directory,'threads','records',`${manifest.threadId}.json`);
  const indexFile=path.join(directory,'threads','index.json');
  const replacementBytes=fs.readFileSync(manifest.replacementFile);
  if(hash(replacementBytes)!==manifest.replacementSha256) throw new Error('History repair replacement checksum mismatch');
  const replacement=JSON.parse(replacementBytes);
  const current=JSON.parse(fs.readFileSync(recordFile,'utf8'));
  if(replacement.id!==manifest.threadId || current.id!==manifest.threadId || replacement.harnessId!=='claude' || current.harnessId!=='claude' || current.nativeSessionId!==replacement.nativeSessionId || replacement.coreState?.thread?.id!==manifest.threadId) throw new Error('History repair identity mismatch');
  const index=JSON.parse(fs.readFileSync(indexFile,'utf8'));
  if(index.schemaVersion!==3 || !index.threads.some(t=>t.id===manifest.threadId)) throw new Error('History repair index entry missing');
  const currentFingerprint=fingerprint(current);
  const alreadyApplied=currentFingerprint===fingerprint(replacement);
  if(!alreadyApplied && currentFingerprint!==manifest.expectedFingerprint) throw new Error('History changed after repair preparation; original preserved, repair skipped');
  fs.mkdirSync(manifest.backupDirectory,{recursive:true});
  const backupRecord=path.join(manifest.backupDirectory,'record.before.json');
  const backupIndex=path.join(manifest.backupDirectory,'index.before.json');
  if(!alreadyApplied){
    fs.copyFileSync(recordFile,backupRecord,fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(indexFile,backupIndex,fs.constants.COPYFILE_EXCL);
    const updated={...current};
    for(const key of ['messages','coreState','tools','createdAt','updatedAt','storage','nativeHistorySnapshot','nativeHistorySync']){
      if(replacement[key]===undefined) delete updated[key]; else updated[key]=replacement[key];
    }
    atomic(recordFile,updated);
  }
  const repaired=JSON.parse(fs.readFileSync(recordFile,'utf8'));
  const entry=index.threads.find(t=>t.id===manifest.threadId);
  entry.createdAt=repaired.createdAt; entry.updatedAt=repaired.updatedAt;
  entry.nativeHistorySnapshot=repaired.nativeHistorySnapshot; entry.nativeHistorySync=repaired.nativeHistorySync; entry.messageCount=repaired.messages.length; entry.recordBytes=fs.statSync(recordFile).size;
  entry.preview=repaired.messages.find(m=>m.role==='user'&&m.text)?.text||entry.preview;
  index.savedAt=Date.now(); atomic(indexFile,index);
  const result={status:'applied',threadId:manifest.threadId,at:new Date().toISOString(),fingerprint:fingerprint(repaired)};
  atomic(path.join(manifest.backupDirectory,'result.json'),result);
  fs.renameSync(manifestFile,`${manifestFile}.applied-${Date.now()}`);
  return result;
}
module.exports={applyPendingHistoryRepair,fingerprint};
