// A hidden Electron fixture. No user Desktop connection, history, or model call.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve('output/repair-20261112/panel-smoke');
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  fs.mkdirSync(root, { recursive: true });
  const bundle = path.join(root, 'panel.js');
  await esbuild.build({ entryPoints: ['src/native-ui/renderer-extension/src/independent-harness-panel.ts'], bundle: true,
    alias: { '@harnessmix/shared-contracts': path.resolve('src/native-ui/shared-contracts/src/index.ts') },
    platform: 'browser', format: 'iife', globalName: 'HarnessPanel', loader: { '.css': 'text' }, outfile: bundle });
  const fixture = path.join(root, 'index.html');
  fs.writeFileSync(fixture, '<!doctype html><html><body><h1>Codex native fixture</h1><textarea id="native">native draft preserved</textarea><script src="panel.js"></script></body></html>');
  const window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(fixture);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const calls=[], responses=[], listeners=new Set(); let pending=[], failSend=false;
      const thread={id:'external-fixture',name:'历史 · 测试会话',cwd:'C:/fixture',status:{type:'idle'},turns:[{id:'old-turn',status:'completed',items:[
        {id:'u1',type:'userMessage',content:[{type:'text',text:'历史用户输入完整保留'}]},
        {id:'a1',type:'agentMessage',text:'历史回复完整保留'}]}]};
      const client={
        async request(method,params){calls.push({method,params});
          if(method==='harnessmix/collaboration/agents')return [{id:'claude-code',name:'Claude Code',available:true}];
          if(method==='harnessmix/harness/inspect')return {status:'ready',catalog:{models:[{ref:{id:'fixture-ref'},label:'Claude Fixture'}],defaultModel:{id:'fixture-ref'},thinkingOptions:[],permissionModes:[]}};
          if(method==='harnessmix/thread/list')return {data:[thread],nextCursor:null};
          if(method==='harnessmix/thread/inspect')return {owner:'external',harnessId:'claude-code',effectiveModel:{id:'fixture-ref'},resolvedModelLabel:'Claude Fixture',locked:true};
          if(method==='thread/read'||method==='thread/resume')return {thread};
          if(method==='turn/start'){if(failSend)throw Error('fixture send failed'); return {turn:{id:'new-turn',status:'inProgress'}};}
          if(method==='turn/steer'){if(failSend)throw Error('fixture send failed'); return {turnId:'new-turn'};}
          if(method==='turn/interrupt')return {};
          throw Error('Unexpected fixture request '+method);
        },
        async respond(id,result){responses.push({id,result});pending=pending.filter(p=>p.id!==id)},
        subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},pendingApprovals(){return pending},dispose(){}
      };
      const emit=frame=>{for(const fn of listeners)fn(frame)};
      const control=HarnessPanel.installIndependentHarnessPanel(client);control.open();
      const root=document.querySelector('[data-harnessmix-independent-panel]').shadowRoot;
      const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw Error('Timed out: '+label)};
      const assert=(condition,message)=>{if(!condition)throw Error(message)};
      const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
      await wait(()=>root.querySelector('.thread'),'history list');root.querySelector('.thread').click();
      await wait(()=>root.textContent.includes('历史用户输入完整保留'),'history text');
      assert(root.textContent.includes('历史回复完整保留'),'Assistant history missing');
      let input=root.querySelector('textarea');input.value='新消息测试';input.dispatchEvent(new Event('input',{bubbles:true}));
      await wait(()=>button('发送')&&!button('发送').disabled,'send enabled after typing');button('发送').click();
      await wait(()=>calls.some(c=>c.method==='turn/start'),'send invoked');
      await wait(()=>root.querySelector('textarea').value==='','draft cleared after success');
      input=root.querySelector('textarea');input.value='发送失败后保留草稿';input.dispatchEvent(new Event('input',{bubbles:true}));
      failSend=true;const sendButton=button('发送')??button('引导当前回合');assert(sendButton&&!sendButton.disabled,'follow-up disabled');sendButton.click();
      await wait(()=>root.textContent.includes('fixture send failed'),'send failure displayed');
      assert(root.querySelector('textarea').value==='发送失败后保留草稿','Failed input lost');
      failSend=false;
      const approval={id:'harness-mix:approval:fixture',method:'item/tool/requestUserInput',params:{threadId:thread.id,turnId:'new-turn',questions:[
        {id:'q1',header:'选择恢复方式',question:'选择两个测试选项',harnessmixMultiple:true,isOther:true,options:[{label:'方式 A'},{label:'方式 B'}]}]}};
      pending=[approval];emit(approval);await wait(()=>root.querySelectorAll('input[type=checkbox]').length===2,'question choices');
      for(const checkbox of root.querySelectorAll('input[type=checkbox]')){checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}))}
      input=root.querySelector('textarea');input.focus();input.setSelectionRange(2,4);
      emit({method:'thread/status/changed',params:{threadId:thread.id,status:{type:'active'}}});
      await new Promise(r=>setTimeout(r,1000));
      assert(root.querySelectorAll('input[type=checkbox]:checked').length===2,'Live update erased selected answers');
      assert(root.activeElement===root.querySelector('textarea'),'Live update lost composer focus');
      assert(root.querySelector('textarea').selectionStart===2&&root.querySelector('textarea').selectionEnd===4,'Live update lost input selection');
      button('提交回答').click();await wait(()=>responses.length===1,'answer acknowledged');
      await wait(()=>!root.querySelector('.approval'),'acknowledged card removed');
      assert(JSON.stringify(responses[0].result.answers.q1.answers)===JSON.stringify(['方式 A','方式 B']),'Multi-choice response changed');
      assert(root.textContent.includes('Claude Fixture'),'Effective model label missing');
      assert(document.getElementById('native').value==='native draft preserved','Native composer changed');
      assert(!calls.some(c=>c.method==='harnessmix/thread/model/select'),'History opening changed model');
      const readsBefore=calls.filter(c=>c.method==='thread/read').length;
      emit({method:'turn/started',params:{threadId:thread.id,turnId:'stream-turn',turn:{id:'stream-turn',status:'inProgress',items:[]}}});
      emit({method:'item/started',params:{threadId:thread.id,turnId:'stream-turn',item:{id:'stream-a',type:'agentMessage',text:'流式首段'}}});
      emit({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:'stream-turn',itemId:'stream-a',delta:'流式首段'}});
      emit({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:'stream-turn',itemId:'stream-a',delta:' 后续内容'}});
      await wait(()=>root.querySelector('.messages').textContent.includes('流式首段 后续内容'),'incremental stream visible');
      assert(!root.querySelector('.messages').textContent.includes('流式首段流式首段'),'Initial streamed content duplicated');
      await new Promise(r=>setTimeout(r,1200));
      assert(calls.filter(c=>c.method==='thread/read').length-readsBefore<=1,'Streaming reloaded full history repeatedly');
      return {ok:true,checks:['history','input enable','send acknowledgement','failed draft retention','live choice retention','focus and cursor','multi-choice reply','native isolation','incremental stream'],requests:calls.map(c=>c.method)};
    })()`);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(root, 'panel.png'), (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(result));
    await window.loadURL('data:text/html,<html><body><textarea id="native">native draft preserved</textarea></body></html>');
    await window.webContents.executeJavaScript(`window.__harnessmixSidecarModeV1=true;window.__harnessmixProductionConfigV1={defaultAgent:'codex'};window.__harnessmixSidecarSendV1=()=>{throw Error('Unexpected eager request')};void 0`);
    const production = fs.readFileSync(path.resolve('output/native-build/renderer-extension.js'), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      const evaluation = await window.webContents.executeJavaScript(`(()=>{try{${production}\n;return {ok:true};}catch(error){return {error:String(error),stack:String(error.stack)};}})()`);
      if (!evaluation.ok) throw Error(evaluation.error + '\n' + evaluation.stack);
    }
    const installed = await window.webContents.executeJavaScript(`(()=>{
      const status=window.__harnessmixIndependentPanelV1?.status();
      if(status?.adapter?.reason!=='independent-sidecar-panel')throw Error('Production entry did not install independent panel');
      if(document.querySelectorAll('[data-harnessmix-independent-panel]').length!==1)throw Error('Duplicate panel after re-injection');
      if(window.__harnessmixDraftPrewarmPolicyV1||window.__harnessmixRateLimitUnlockV1)throw Error('Independent mode touched native policy');
      if(document.getElementById('native').value!=='native draft preserved')throw Error('Production entry changed native input');
      return {ok:true,mode:status.adapter.reason,enabledAgents:status.enabledAgents.length,reinjection:'single panel',nativePolicy:'untouched'};
    })()`);
    fs.writeFileSync(path.join(root, 'production-result.json'), JSON.stringify(installed, null, 2));
    console.log(JSON.stringify(installed));
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error.message); app.exit(1); });
