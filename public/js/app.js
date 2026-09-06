  const $ = id => document.getElementById(id);
  const dot=$('dot'), sub=$('sub'), viewport=$('viewport'), img=$('ctrlImg'),
    empty=$('empty'), emptyMsg=$('emptyMsg'), loading=$('loading'),
    setupCard=$('setupCard'), setupIcon=$('setupIcon'), setupTitle=$('setupTitle'),
    setupDesc=$('setupDesc'), setupGoBtn=$('setupGoBtn'), setupAlt=$('setupAlt'),
    vcursor=$('vcursor'), ripple=$('ripple'),
    zoomInBtn=$('zoomInBtn'), zoomOutBtn=$('zoomOutBtn'), resetBtn=$('resetBtn'),
    zoomVal=$('zoomVal'), clickBtn=$('clickBtn'),
    modeBtn=$('modeBtn'), toastEl=$('toast'),
    helpModal=$('helpModal'), helpBtn=$('helpBtn'), helpClose=$('helpClose'),
    inputBtn=$('inputBtn'), inputModal=$('inputModal'), inputCard=$('inputCard'),
    inputClose=$('inputClose'), inputCancel=$('inputCancel'), inputSend=$('inputSend'),
    inputArea=$('inputArea'), clearSwitch=$('clearSwitch'),
    updateBtn=$('updateBtn'), updateModal=$('updateModal'),
    updateTitleText=$('updateTitleText'),
    updateClose=$('updateClose'), updateInfo=$('updateInfo'), updateVersion=$('updateVersion'),
    updateAuto=$('updateAuto'), updateGo=$('updateGo'), updateSteps=$('updateSteps'),
    restartBtn=$('restartBtn'),
    confirmModal=$('confirmModal'), confirmTitle=$('confirmTitle'), confirmMsg=$('confirmMsg'),
    confirmOk=$('confirmOk'), confirmCancel=$('confirmCancel'), confirmClose=$('confirmClose');

  // ===== 状态 =====
  let imgNatural=null, busy=false, tok=0, zoom=1;
  let target=null;   // 最近一次点击的截图像素坐标 = 目标输入框位置(文本输入焦点管理依据)
  const ZOOM_MIN=0.5, ZOOM_MAX=8;
  let pan={x:0,y:0}, cursor=null;
  let manual=false;   // false=直接点击, true=手动点击
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function toast(t){ toastEl.textContent=t; toastEl.classList.add('show'); clearTimeout(toastEl._t); toastEl._t=setTimeout(()=>toastEl.classList.remove('show'),1800); }
  function setBusy(b){ busy=b; loading.classList.toggle('on', b); }
  function setReady(ok){ dot.className='dot '+(ok?'ready':'err'); }

  // ===== 空态 / 未安装引导 =====
  // lucide 风格内联 SVG 图标
  const ICON_DOWNLOAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
  const ICON_WARN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  function showEmpty(text){
    setupCard.classList.remove('on');
    emptyMsg.textContent = text;
    emptyMsg.style.display = '';
    empty.style.display = 'flex';
  }
  // 花妖未安装(reason='no_record')或程序文件丢失(reason='exe_missing')时,
  // 用引导卡替代普通空态, 引导用户进入安装面板完成首次安装/重装
  function showSetup(reason){
    const fileLost = reason === 'exe_missing';
    empty.style.display = 'flex';
    emptyMsg.style.display = 'none';
    setupIcon.classList.toggle('warn', fileLost);
    setupIcon.innerHTML = fileLost ? ICON_WARN : ICON_DOWNLOAD;
    setupTitle.textContent = fileLost ? '花妖程序文件丢失' : '花妖尚未安装';
    setupDesc.textContent = fileLost
      ? '找不到已安装的花妖主程序（可能被移动或被杀毒软件误删）。重新下载安装后即可继续使用操控台。'
      : '操控台需要花妖程序才能工作。首次使用请先下载安装花妖，安装完成后即可开始操控。';
    setupGoBtn.textContent = fileLost ? '重新下载安装' : '立即下载安装';
    setupGoBtn.disabled = false;
    setupAlt.textContent = '';
    setupCard.classList.add('on');
    setReady(false);
    // 探测下载源是否已配置: 未配置时提前禁用按钮并说明原因, 避免用户点进去才发现不可用
    fetch('/api/garden/update', { cache: 'no-store' })
      .then(r => r.json().catch(() => ({})))
      .then(d => {
        if (!setupCard.classList.contains('on')) return; // 引导卡已被关闭
        if (d && d.configured === false) {
          setupGoBtn.disabled = true;
          setupAlt.textContent = '下载源未配置：请在服务器 .env 中设置 GARDEN_DOWNLOAD_URL 后重启服务';
        }
      })
      .catch(() => {});
  }

  // ===== 模式切换 =====
  function applyMode(){
    const isManual = manual;
    modeBtn.classList.toggle('on', isManual);
    modeBtn.textContent = isManual ? '🖐 手动' : '⚡ 直接';
    sub.textContent = isManual ? '手动点击模式' : '直接点击模式';
    clickBtn.style.display = isManual ? 'flex' : 'none';
    clickBtn.disabled = isManual && !cursor;
    if (!isManual) vcursor.classList.remove('on');
    else { ensureCursor(); updateCursor(); }
    toast(isManual ? '已切换：手动点击模式（拖动光标→点击确认）' : '已切换：直接点击模式');
  }

  // ===== 渲染 =====
  function renderInfo(){
    if(!imgNatural) return null;
    const vw=viewport.clientWidth, vh=viewport.clientHeight, nw=imgNatural.w, nh=imgNatural.h;
    if(!nw||!nh||!vw||!vh) return null;
    const fit=Math.min(vw/nw, vh/nh);
    const dw=nw*fit*zoom, dh=nh*fit*zoom;
    return { left:(vw-dw)/2+pan.x, top:(vh-dh)/2+pan.y, dispW:dw, dispH:dh, z:zoom, fit };
  }
  function applyTransform(){
    const i=renderInfo(); if(!i||!imgNatural) return;
    img.style.width=(imgNatural.w*i.fit)+'px';
    img.style.height=(imgNatural.h*i.fit)+'px';
    img.style.transform=`translate(${i.left}px,${i.top}px) scale(${i.z})`;
    img.style.transformOrigin='0 0';
    zoomVal.textContent=Math.round(i.z*100)+'%';
    zoomInBtn.disabled=busy||i.z>=ZOOM_MAX;
    zoomOutBtn.disabled=busy||i.z<=ZOOM_MIN;
  }
  function clampPan(){
    const i=renderInfo(); if(!i) return;
    const vw=viewport.clientWidth, vh=viewport.clientHeight;
    // 图片显示偏移 = 居中偏移 + pan。画面大于视口时须保证图片完全覆盖视口:
    //   left∈[vw-dispW, 0] => pan.x∈[(vw-dispW)/2, (dispW-vw)/2] = [cx, -cx]
    const cx=(vw-i.dispW)/2, cy=(vh-i.dispH)/2;
    pan.x = i.dispW<=vw ? 0 : Math.max(cx, Math.min(-cx, pan.x));
    pan.y = i.dispH<=vh ? 0 : Math.max(cy, Math.min(-cy, pan.y));
    applyTransform();
  }
  function centerView(){ pan={x:0,y:0}; zoom=1; applyTransform(); }
  function zoomAt(cx,cy,d){
    const i=renderInfo(); if(!i) return;
    const oldZ=i.z; let nz=Math.max(ZOOM_MIN,Math.min(ZOOM_MAX,oldZ*d));
    if(nz===oldZ) return;
    const px=(cx-viewport.clientWidth/2-pan.x)/oldZ, py=(cy-viewport.clientHeight/2-pan.y)/oldZ;
    pan.x=(cx-viewport.clientWidth/2)-px*nz; pan.y=(cy-viewport.clientHeight/2)-py*nz;
    zoom=nz; clampPan(); if(manual) updateCursor();
  }
  function imgPixelFromClient(cx,cy){
    const i=renderInfo(); if(!i||!imgNatural) return null;
    const vr=viewport.getBoundingClientRect();
    const px=(cx-vr.left-i.left)/(i.fit*i.z), py=(cy-vr.top-i.top)/(i.fit*i.z);
    if(px<0||py<0||px>=imgNatural.w||py>=imgNatural.h) return null;
    return { x:Math.round(px), y:Math.round(py) };
  }

  // ===== 虚拟光标 =====
  function ensureCursor(){
    if(!cursor || cursor.x<0 || cursor.y<0 || cursor.x>=imgNatural.w || cursor.y>=imgNatural.h){
      cursor = imgNatural ? { x: Math.floor(imgNatural.w/2), y: Math.floor(imgNatural.h/2) } : null;
    }
  }
  function updateCursor(){
    if(!manual || !cursor || !imgNatural || img.style.display==='none'){ vcursor.classList.remove('on'); return; }
    const i=renderInfo(); if(!i) return;
    vcursor.style.left=(i.left+cursor.x*i.fit*i.z)+'px';
    vcursor.style.top=(i.top+cursor.y*i.fit*i.z)+'px';
    vcursor.classList.add('on');
    clickBtn.disabled = busy;
  }
  function moveCursorTo(x,y){
    if(!imgNatural) return;
    cursor.x=Math.max(0,Math.min(imgNatural.w-1,Math.round(x)));
    cursor.y=Math.max(0,Math.min(imgNatural.h-1,Math.round(y)));
    updateCursor();
  }

  function setFrame(src,onLoaded){
    const t=++tok;
    img.onload=()=>{
      if(t!==tok) return;
      imgNatural={w:img.naturalWidth,h:img.naturalHeight};
      img.style.display='block'; empty.style.display='none';
      inputBtn.disabled=false;
      applyTransform(); if(manual) updateCursor();
      if(onLoaded) onLoaded();
    };
    img.src=src;
  }
  function showImage(b64){ if(!b64) return; setFrame('data:image/png;base64,'+b64); }

  // ===== 实时画面 (WebSocket /api/live) =====
  const LIVE_GEARS=[['eco','省流',2000],['mid','均衡',500],['fast','流畅',200]];
  let liveWs=null, liveLastUrl=null, liveGearIdx=1;
  let liveArr=[], liveLastArrival=0, liveStatT=0, lastLiveErrT=0, lastOpT=0;

  const liveBadge=$('liveBadge');
  function liveSend(o){ if(liveWs&&liveWs.readyState===1) liveWs.send(JSON.stringify(o)); }
  function liveActive(){ return !!liveWs && liveWs.readyState===1; }
  function liveBadgeUi(){
    if(!liveWs){ liveBadge.style.display='none'; return; }
    liveBadge.style.display='flex';
    for(let i=0;i<3;i++) liveBadge.children[i].className = i<=liveGearIdx ? 'on' : '';
  }
  function liveSetGear(i){ liveGearIdx=i; liveBadgeUi(); }
  function liveConnect(){
    const proto=location.protocol==='https:'?'wss':'ws';
    liveWs=new WebSocket(proto+'://'+location.host+'/api/live');
    liveWs.binaryType='arraybuffer';
    liveWs.onopen=()=>{ liveSend({op:'start',gear:LIVE_GEARS[liveGearIdx][0]}); liveBadgeUi(); };
    liveWs.onmessage=(ev)=>{
      if(typeof ev.data==='string'){
        let d; try{ d=JSON.parse(ev.data); }catch{ return; }
        if(d.op==='gear' && LIVE_GEARS.some(g=>g[0]===d.gear)){ liveSetGear(LIVE_GEARS.findIndex(g=>g[0]===d.gear)); }
        else if(d.op==='error'){ const n=Date.now(); if(n-lastLiveErrT>5000){ lastLiveErrT=n; toast('实时画面: '+(d.message||'抓帧失败')); } }
        return;
      }
      // 二进制帧: [u8 flags][u32 seq][u32 ts][u16 w][u16 h] (+JPEG, flags&1=跳帧心跳)
      const now=performance.now();
      if(liveLastArrival){ liveArr.push(now-liveLastArrival); if(liveArr.length>10) liveArr.shift(); }
      liveLastArrival=now;
      const dv=new DataView(ev.data);
      if(!(dv.getUint8(0)&1)){
        const url=URL.createObjectURL(new Blob([new Uint8Array(ev.data,13)],{type:'image/jpeg'}));
        setFrame(url,()=>{ if(liveLastUrl) URL.revokeObjectURL(liveLastUrl); liveLastUrl=url; });
      }
      liveAutoStats();
    };
    liveWs.onclose=()=>{
      liveWs=null; liveBadgeUi();
      if(!document.hidden){ setTimeout(()=>{ if(!liveWs) liveConnect(); },2000); }
    };
    liveWs.onerror=()=>{ try{ liveWs.close(); }catch{} };
  }
  function liveStop(){
    try{ liveWs && liveWs.close(); }catch{}
    liveWs=null; liveBadgeUi();
    if(liveLastUrl){ URL.revokeObjectURL(liveLastUrl); liveLastUrl=null; }
  }
  // 每 5 秒上报帧到达间隔样本; 档位决策在服务端(只有它知道实际调度节奏与空闲状态), 客户端只显示
  function liveAutoStats(){
    const nowt=Date.now();
    if(nowt-liveStatT<5000) return;
    liveStatT=nowt;
    if(nowt-lastOpT<4000){ liveArr=[]; return; }   // 操作突发期的样本不参与上报
    if(liveArr.length>=6){
      const avg=Math.round(liveArr.reduce((a,b)=>a+b,0)/liveArr.length);
      liveSend({op:'stats',interval:avg,expect:LIVE_GEARS[liveGearIdx][2]});
    }
    liveArr=[];
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){ if(liveWs) liveStop(); }
    else if(!liveWs){ liveConnect(); }
  });
  window.addEventListener('pagehide',()=>{ try{ liveWs && liveWs.close(); }catch{} });
  function doShot(){
    if(liveActive()){ liveSend({op:'refresh'}); return; }   // 实时模式下刷新=触发一次突发, 无需重截
    setBusy(true);
    fetch('/api/control/shot',{method:'POST',cache:'no-store'})
      .then(r=>r.json().catch(()=>({})))
      .then(d=>{
        // 花妖未安装/程序文件丢失: 展示安装引导卡, 引导用户进入安装流程
        if(d.notInstalled){ toast(d.message||'花妖尚未安装'); showSetup(d.reason); setReady(false); return; }
        if(d.autoStarted) toast('花妖未在运行，已自动重新启动');
        else if(d.ensureError) toast(d.ensureError);
        if(!d.ok){
          if(!imgNatural) showEmpty(d.message||'截图失败');
          toast(d.message||'截图失败'); setReady(false); return;
        }
        setReady(true); if(d.image) showImage(d.image);
        if(!liveWs) liveConnect();   // 首帧就绪后自动开启实时画面
      })
      .catch(()=>{ toast('请求失败'); setReady(false); })
      .finally(()=>setBusy(false));
  }
  function rippleAt(sx,sy){
    const i=renderInfo(); if(!i) return;
    ripple.style.left=(i.left+sx*i.fit*i.z)+'px';
    ripple.style.top=(i.top+sy*i.fit*i.z)+'px';
    ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go');
  }
  let clickInflight=false;
  function doClick(x,y){
    if(clickInflight) return;   // 轻量防抖: 实时模式下无蒙层阻挡, 避免误触连发
    const la=liveActive();
    if(!la) setBusy(true);
    rippleAt(x,y);
    try{ navigator.vibrate && navigator.vibrate(10); }catch{}
    target={x,y};   // 记住目标输入框位置(文本输入时先重定位到此处确保焦点)
    lastOpT=Date.now();   // 突发期样本不参与自适应判断
    clickInflight=true;
    fetch('/api/control/click',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,y,noimg:la}),cache:'no-store'})
      .then(r=>r.json().catch(()=>({})))
      .then(d=>{ if(!d.ok){ toast(d.message||'点击失败'); return; } if(d.image) showImage(d.image); })
      .catch(()=>{ toast('请求失败'); })
      .finally(()=>{ clickInflight=false; if(!la) setBusy(false); });
  }

  // ===== 触摸手势 =====
  // 直接模式: 单指轻点=点击, 单指拖动=平移, 双指捏合=缩放(双指整体移动=平移)
  // 手动模式: 单指拖动=移动光标(1:1), 双指捏合=缩放, 底部按钮=确认点击
  let gesture=null;
  viewport.addEventListener('touchstart',(e)=>{
    if(busy) return;
    if(e.touches.length===2){
      const t1=e.touches[0], t2=e.touches[1];
      gesture={type:'pinch',
        d:Math.hypot(t1.clientX-t2.clientX, t1.clientY-t2.clientY), zoom,
        midX:(t1.clientX+t2.clientX)/2, midY:(t1.clientY+t2.clientY)/2};
    } else if(e.touches.length===1){
      gesture={type: manual?'move':'tap', sx:e.touches[0].clientX, sy:e.touches[0].clientY, moved:false};
    }
  },{passive:false});
  viewport.addEventListener('touchmove',(e)=>{
    if(!gesture) return;
    if(gesture.type==='pinch' && e.touches.length===2){
      e.preventDefault();
      const t1=e.touches[0], t2=e.touches[1];
      const d=Math.hypot(t1.clientX-t2.clientX, t1.clientY-t2.clientY);
      const midX=(t1.clientX+t2.clientX)/2, midY=(t1.clientY+t2.clientY)/2;
      if(d>0 && gesture.d>0){
        const vr=viewport.getBoundingClientRect();
        zoomAt(midX-vr.left, midY-vr.top, d/gesture.d);   // 以两指中点为锚缩放
      }
      pan.x+=(midX-gesture.midX); pan.y+=(midY-gesture.midY);   // 双指整体位移 = 平移
      gesture.d=d; gesture.midX=midX; gesture.midY=midY;
      clampPan(); if(manual) updateCursor();
    } else if(gesture.type==='move' && e.touches.length===1){
      e.preventDefault();
      const dx=e.touches[0].clientX-gesture.sx, dy=e.touches[0].clientY-gesture.sy;
      const i=renderInfo();
      if(i && imgNatural){
        const imgDX=dx/(i.fit*i.z), imgDY=dy/(i.fit*i.z);
        moveCursorTo(cursor.x+imgDX, cursor.y+imgDY);
      }
      gesture.sx=e.touches[0].clientX; gesture.sy=e.touches[0].clientY;
      if(Math.abs(dx)+Math.abs(dy)>6) gesture.moved=true;
    } else if(gesture.type==='tap'){
      // 直接模式: 轻点=点击; 单指拖动(>8px)转为平移画面
      const dx=e.touches[0].clientX-gesture.sx, dy=e.touches[0].clientY-gesture.sy;
      if(Math.abs(dx)+Math.abs(dy)>8){
        if(!gesture.panning){
          gesture.panning=true;
          gesture.px=pan.x; gesture.py=pan.y;   // 记录进入平移时的 pan
        }
        e.preventDefault();
        pan.x=gesture.px+(e.touches[0].clientX-gesture.sx);
        pan.y=gesture.py+(e.touches[0].clientY-gesture.sy);
        clampPan();
      }
      gesture.moved=gesture.panning;
    }
  },{passive:false});
  viewport.addEventListener('touchend',(e)=>{
    if(!gesture) return;
    if(gesture.type==='pinch' && e.touches.length<2){ clampPan(); gesture=null; return; }
    if(gesture.type==='tap' && e.touches.length===0 && !gesture.moved && !busy && img.style.display!=='none'){
      const t=e.changedTouches[0];
      const p=imgPixelFromClient(t.clientX,t.clientY);
      if(p) doClick(p.x,p.y);
    }
    if(gesture.type==='tap' && e.touches.length===0 && gesture.moved) clampPan();   // 拖动平移后收拢边界
    if(e.touches.length===0) gesture=null;
  });
  viewport.addEventListener('touchcancel',()=>{ gesture=null; });

  // ===== 桌面 =====
  if(fine){
    viewport.addEventListener('mousemove',(e)=>{
      if(img.style.display==='none') return;
      const p=imgPixelFromClient(e.clientX,e.clientY);
      if(!p) return;
      if(manual){ moveCursorTo(p.x,p.y); }
      else { cursor={x:p.x,y:p.y}; }
    });
    let drag=null, dragMoved=false;
    viewport.addEventListener('click',(e)=>{
      if(dragMoved){ dragMoved=false; return; }   // 拖动平移后的 click 不当作点击
      if(busy||img.style.display==='none') return;
      const p=imgPixelFromClient(e.clientX,e.clientY); if(p) doClick(p.x,p.y);
    });
    viewport.addEventListener('mousedown',(e)=>{ if(e.button!==0) return; drag={sx:e.clientX,sy:e.clientY,px:pan.x,py:pan.y}; dragMoved=false; e.preventDefault(); });
    window.addEventListener('mousemove',(e)=>{
      if(!drag) return;
      pan.x=drag.px+(e.clientX-drag.sx); pan.y=drag.py+(e.clientY-drag.sy);
      if(Math.abs(e.clientX-drag.sx)+Math.abs(e.clientY-drag.sy)>6) dragMoved=true;
      clampPan();
    });
    window.addEventListener('mouseup',()=>{ drag=null; });
    viewport.addEventListener('wheel',(e)=>{ e.preventDefault(); const vr=viewport.getBoundingClientRect(); zoomAt(e.clientX-vr.left,e.clientY-vr.top, e.deltaY<0?1.18:1/1.18); },{passive:false});
  }

  // ===== 底部按钮 =====
  zoomInBtn.addEventListener('click',()=>zoomAt(viewport.clientWidth/2,viewport.clientHeight/2,1.25));
  zoomOutBtn.addEventListener('click',()=>zoomAt(viewport.clientWidth/2,viewport.clientHeight/2,1/1.25));
  resetBtn.addEventListener('click',()=>{ centerView(); });
  modeBtn.addEventListener('click',()=>{ manual=!manual; applyMode(); });
  clickBtn.addEventListener('click',()=>{ if(cursor) doClick(cursor.x,cursor.y); });

  // ===== 文本输入 =====
  const MAX_TEXT = 2000;
  function openInput(){
    if(!imgNatural || img.style.display==='none'){ toast('画面不可用，请先刷新'); return; }
    if(!target){ toast('请先点击画面选中目标输入框'); return; }
    inputArea.value=''; clearSwitch.checked=false;
    inputModal.classList.add('show');
    adjustInputPanel();
    setTimeout(()=>inputArea.focus({preventScroll:true}), 90);
  }
  function closeInput(){ inputModal.classList.remove('show'); }
  function sendInput(){
    const text=inputArea.value.trim();
    if(!text){ toast('请输入要发送的文本'); inputArea.focus(); return; }
    if(text.length>MAX_TEXT){ toast('文本过长(最多 '+MAX_TEXT+' 字符)'); return; }
    if(!target){ toast('请先点击画面选中目标输入框'); closeInput(); return; }
    const la=liveActive();
    if(!la) setBusy(true);
    lastOpT=Date.now();   // 突发期样本不参与自适应判断
    inputSend.disabled=true; inputSend.textContent='发送中…';   // 输入链路较长(探测+消息投递), 明确加载态
    const clear=clearSwitch.checked;
    fetch('/api/control/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:target.x,y:target.y,text,clear,noimg:la}),cache:'no-store'})
      .then(r=>r.json().catch(()=>({})))
      .then(d=>{
        if(!d.ok){ toast(d.message||'输入失败'); return; }
        if(d.image) showImage(d.image);
        closeInput(); toast('文本已发送'+(clear?'(已清空)':''));
      })
      .catch(()=>{ toast('请求失败'); })
      .finally(()=>{ inputSend.disabled=false; inputSend.textContent='发送'; if(!la) setBusy(false); });
  }
  inputBtn.addEventListener('click', openInput);

  inputClose.addEventListener('click', closeInput);
  inputCancel.addEventListener('click', closeInput);
  inputSend.addEventListener('click', sendInput);
  inputModal.addEventListener('click',(e)=>{ if(e.target===inputModal) closeInput(); });
  // 回车/软键盘"发送"键确认; Shift+回车换行; 中文输入法组合阶段不误触发
  inputArea.addEventListener('keydown',(e)=>{
    if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); sendInput(); }
  });
  // 键盘弹出时把面板顶到键盘上方(visualViewport 适配, iOS 键盘覆盖 fixed 底部)
  const vv = window.visualViewport;
  function adjustInputPanel(){
    if(!vv || !inputModal.classList.contains('show')) return;
    const kb = window.innerHeight - vv.offsetTop - vv.height;
    inputCard.style.marginBottom = (kb>0 ? kb : 0)+'px';
  }
  if(vv){ vv.addEventListener('resize', adjustInputPanel); vv.addEventListener('scroll', adjustInputPanel); }
  window.addEventListener('resize', adjustInputPanel);

  // ===== 帮助 =====
  const openHelp=()=>helpModal.classList.add('show'), closeHelp=()=>helpModal.classList.remove('show');
  helpBtn.addEventListener('click',openHelp);
  helpClose.addEventListener('click',closeHelp);
  helpModal.addEventListener('click',(e)=>{ if(e.target===helpModal) closeHelp(); });

  // ===== 花妖版本更新 =====
  const VERSION_RE = /^\d+\.\d+\.\d+$/;
  let updating = false;
  function openUpdate(){
    updateModal.classList.add('show');
    updateSteps.textContent = '';
    updateInfo.innerHTML = '加载中…';
    updateAuto.disabled = true; updateGo.disabled = true;
    fetch('/api/garden/update', { cache: 'no-store' })
      .then(r => r.json().catch(() => ({})))
      .then(d => {
        if (d.ok === false) { updateInfo.textContent = d.message || '获取版本信息失败'; return; }
        // 未安装(首次)或程序文件丢失时, 面板切换为"安装"语义, 与日常"更新"区分
        const missing = d.installed === false;
        const fileLost = missing && !!d.currentVersion;
        updateTitleText.textContent = missing ? (fileLost ? '重新安装花妖' : '安装花妖') : '更新花妖版本';
        const cur = d.currentVersion ? d.currentVersion + (fileLost ? '（文件丢失）' : '') : '未安装';
        const src = d.configured ? (d.downloadUrl || '未知') : '未配置（请在 .env 中设置 GARDEN_DOWNLOAD_URL 后重启服务）';
        updateInfo.innerHTML = '当前版本：<b>' + cur + '</b>' +
          (d.lastUpdated ? ' · 更新于 <span class="dim">' + d.lastUpdated + '</span>' : '') +
          '<br><span class="dim">下载源：' + src + '</span>' +
          (missing ? '<br><span class="dim">' + (fileLost
            ? '程序文件已丢失，输入版本号（可与原版本相同）重新下载安装。'
            : '首次使用请输入要安装的版本号，然后点击「下载安装」。') + '</span>' : '');
        if (!missing && d.currentVersion) {
          updateVersion.value = nextVersionStr(d.currentVersion);
          updateGo.textContent = '更新到此版本';
        } else {
          updateVersion.value = '';
          updateGo.textContent = fileLost ? '重新安装' : '下载安装';
        }
        // 未安装时无当前版本可推算, 禁用"自动下一版本"
        updateAuto.disabled = !d.configured || missing;
        updateGo.disabled = !d.configured;
      })
      .catch(() => { updateInfo.textContent = '获取版本信息失败'; });
  }
  function nextVersionStr(v){
    const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? (m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1)) : (v || '');
  }
  function closeUpdate(){ updateModal.classList.remove('show'); }
  function setUpdating(b){
    updating = b;
    updateGo.disabled = b; updateAuto.disabled = b;
    updateVersion.disabled = b;
  }
  function doUpdate(body){
    if (updating) return;
    setUpdating(true);
    updateSteps.textContent = '处理中…';
    updateSteps.className = 'update-steps';
    fetch('/api/garden/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
      .then(r => r.json().catch(() => ({})))
      .then(d => {
        // 后端 steps 已包含完整过程(失败时最后一条即"更新失败: xxx"), 直接展示, 避免与 d.message 重复
        const stepsText = (d.steps || []).join('\n');
        if (d.ok) {
          updateSteps.textContent = stepsText || (d.message || '更新完成');
          updateSteps.className = 'update-steps ok';
          toast(d.message || '更新完成');
          // 更新成功后重新截图, 展示新版花妖画面
          closeUpdate();
          doShot();
        } else {
          updateSteps.textContent = stepsText || (d.message || '更新失败');
          updateSteps.className = 'update-steps err';
          toast(d.message || '更新失败');
        }
      })
      .catch(() => { updateSteps.textContent = '请求失败'; updateSteps.className = 'update-steps err'; toast('请求失败'); })
      .finally(() => setUpdating(false));
  }
  updateBtn.addEventListener('click', openUpdate);
  setupGoBtn.addEventListener('click', openUpdate);   // 未安装引导卡 -> 安装面板
  updateClose.addEventListener('click', closeUpdate);
  updateModal.addEventListener('click', (e) => { if (e.target === updateModal) closeUpdate(); });
  // ===== 通用确认弹窗 =====
  function confirmDialog(opts){
    opts = opts || {};
    confirmTitle.textContent = opts.title || '确认操作';
    confirmMsg.textContent = opts.message || '';
    confirmOk.textContent = opts.okText || '确定';
    confirmCancel.textContent = opts.cancelText || '取消';
    confirmOk.classList.toggle('danger', !!opts.danger);
    confirmModal._onOk = typeof opts.onOk === 'function' ? opts.onOk : null;
    confirmModal.classList.add('show');
  }
  function closeConfirm(){ confirmModal.classList.remove('show'); }
  confirmOk.addEventListener('click', () => { const cb = confirmModal._onOk; closeConfirm(); if (cb) cb(); });
  confirmCancel.addEventListener('click', closeConfirm);
  confirmClose.addEventListener('click', closeConfirm);
  confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) closeConfirm(); });

  // ===== 重启花妖 =====
  let restarting = false;
  function doRestart(){
    if (restarting || busy) return;
    restarting = true; setBusy(true);
    fetch('/api/control/restart', { method: 'POST', cache: 'no-store' })
      .then(r => r.json().catch(() => ({})))
      .then(d => {
        setBusy(false);
        // 未安装/程序文件丢失时无法重启: 提示并直接打开安装面板
        if (d.notInstalled) { toast(d.message || '花妖尚未安装'); showSetup(d.reason); openUpdate(); return; }
        if (!d.ok) { toast(d.message || '重启失败'); return; }
        toast(d.message || '花妖已重启');
        doShot(); // 刷新画面展示重启后的花妖
      })
      .catch(() => { setBusy(false); toast('请求失败'); })
      .finally(() => { restarting = false; });
  }
  restartBtn.addEventListener('click', () => {
    confirmDialog({
      title: '重启花妖',
      message: '将结束当前花妖进程，并重新启动最新版本。确定重启吗？',
      okText: '重启',
      danger: true,
      onOk: doRestart,
    });
  });

  updateAuto.addEventListener('click', () => doUpdate({ auto: true }));
  updateGo.addEventListener('click', () => {
    const v = updateVersion.value.trim();
    if (!VERSION_RE.test(v)) { toast('版本号格式应为 x.y.z，例如 1.5.1'); updateVersion.focus(); return; }
    doUpdate({ version: v });
  });

  // ===== 初始化 =====
  applyMode();
  inputBtn.disabled = true;   // 无画面时不可输入
  doShot();
  window.addEventListener('resize', applyTransform);
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ helpModal.classList.remove('show'); closeInput(); closeConfirm(); } });
