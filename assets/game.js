
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const holdBtn = $('holdBtn');
  const overlay = $('overlay');
  const nearestEl = $('nearest');
  const bestScoreEl = $('bestScore');
  const bestPowerEl = $('bestPower');
  const timeLeftEl = $('timeLeft');
  const statusCaption = $('statusCaption');
  const dangerEl = $('danger');
  const pauseBtn = $('pauseBtn');
  const scorecardBackdrop = $('scorecardBackdrop');
  const scorecard = $('scorecard');
  const cardCtx = scorecard.getContext('2d');
  const cardPower = $('cardPower');

  const RUN_SECONDS = 60;
  const EARLY_DETECTION_GRACE_MS = 110;
  const LATE_DETECTION_GRACE_MS = 48;
  const MIN_WATCH = 0.58;
  const MAX_WATCH = 1.55;
  const DPR_CAP = 2;

  const state = {
    phase: 'idle',
    t: 0,
    progress: 0,
    moving: false,
    founderWatching: false,
    founderLook: 0,          // 0 = looking away, 1 = fully watching
    targetLook: 0,
    nextTurn: 1.4,
    watchUntil: 0,
    detectionArmedAt: Infinity,
    power: 0,
    caught: false,
    paused: false,
    lastTs: 0,
    seed: Math.random() * 99999,
    viewW: 1536,
    viewH: 382
  };

  const bg = new Image();
  bg.src = './assets/factory-stage.png';
  const cardScene = new Image();
  cardScene.src = './assets/sniff-scorecard-scene.png';

  const founder = Array.from({length:5}, (_,i) => {
    const img = new Image();
    img.src = `./assets/sprites/founder-${i}.png`;
    return img;
  });
  const thread = Array.from({length:4}, (_,i) => {
    const img = new Image();
    img.src = `./assets/sprites/threadguy-${i}.png`;
    return img;
  });

  function rnd(a,b){
    state.seed=(state.seed*9301+49297)%233280;
    return a+(state.seed/233280)*(b-a);
  }

  function resizeCanvas(){
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr)) {
      canvas.width = Math.round(w*dpr);
      canvas.height = Math.round(h*dpr);
    }
    state.viewW = w;
    state.viewH = h;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.imageSmoothingEnabled = false;
  }

  function remainingPct(){
    return 100 * (1 - state.progress);
  }

  function calcPower(){
    // Distance remains dominant. Pace separates otherwise similar runs.
    const p = Math.max(0, Math.min(0.997, state.progress));
    const elapsed = Math.max(1, state.t);
    const pace = Math.max(.70, Math.min(1.30, 1.20 - (elapsed/RUN_SECONDS)*.50));
    return Math.min(10000, Math.round(10000 * Math.pow(p, 3.15) * pace));
  }

  function lateDifficulty(){
    // Almost all of the difficulty increase is reserved for the final stretch.
    // 0 at the start, 1 extremely close to Founder.
    return Math.pow(Math.max(0, Math.min(1, state.progress)), 2.65);
  }

  function progressSpeed(){
    // Asymptotic approach: the closer Threadguy gets, the smaller every step becomes.
    // Mathematically this never reaches 100%, and the 60s shift makes the final
    // fractions of a percent the competitive battleground.
    return 0.205 * Math.max(0.0008, 1 - state.progress);
  }

  function safeWindow(){
    const d = lateDifficulty();
    // Early: generous 0.75–2.30s. Final zone: roughly 0.22–0.43s.
    const min = 0.75 - 0.53*d;
    const max = 2.30 - 1.87*d;
    return rnd(Math.max(.20,min), Math.max(.34,max));
  }

  function watchWindow(){
    const d = lateDifficulty();
    // Slightly longer inspections near Founder punish panic tapping and waiting.
    return rnd(MIN_WATCH + .14*d, MAX_WATCH + .48*d);
  }

  function founderTurnSpeed(){
    const d = lateDifficulty();
    // About 0.43s for a full turn early, ~0.16s in the final zone.
    return 2.35 + 3.95*d;
  }

  function detectionGraceMs(){
    const d = lateDifficulty();
    return EARLY_DETECTION_GRACE_MS + (LATE_DETECTION_GRACE_MS - EARLY_DETECTION_GRACE_MS)*d;
  }

  function reset(){
    Object.assign(state,{
      phase:'ready', t:0, progress:0, moving:false,
      founderWatching:false, founderLook:0, targetLook:0,
      nextTurn:rnd(1.05,2.25), watchUntil:0,
      detectionArmedAt:Infinity, power:0, caught:false,
      paused:false, lastTs:performance.now(), seed:Math.random()*99999
    });
    overlay.hidden = true;
    dangerEl.classList.remove('show');
    holdBtn.classList.remove('active');
    statusCaption.textContent = 'READY';
    updateHUD();
  }

  function start(){
    reset();
    state.phase='playing';
    statusCaption.textContent='SNEAK';
  }

  function setMove(on){
    if(state.phase!=='playing' || state.paused) return;
    state.moving = !!on;
    holdBtn.classList.toggle('active', state.moving);
  }

  function founderTurnToWatch(){
    state.founderWatching = true;
    state.targetLook = 1;
    // Watching duration starts once the turn begins; the actual detection
    // is armed in update() only when he is essentially fully left-facing.
    state.watchUntil = state.t + watchWindow() + .30;
    state.detectionArmedAt = Infinity;
    dangerEl.textContent = 'TURNING';
    dangerEl.classList.add('show');
    statusCaption.textContent = 'TURNING';
  }

  function founderTurnAway(){
    state.founderWatching = false;
    state.targetLook = 0;
    state.detectionArmedAt = Infinity;
    state.nextTurn = state.t + safeWindow();
    dangerEl.classList.remove('show');
    statusCaption.textContent='SNEAK';
  }

  function finish(reason){
    if(state.phase!=='playing') return;
    state.phase='over';
    state.moving=false;
    state.caught = reason === 'caught';
    holdBtn.classList.remove('active');
    state.power=calcPower();

    const result={
      power: state.power,
      nearest: +remainingPct().toFixed(2),
      time: +state.t.toFixed(2),
      reason
    };

    const best=JSON.parse(localStorage.getItem('sniff-best')||'null');
    if(!best || result.power>best.power){
      localStorage.setItem('sniff-best',JSON.stringify(result));
    }

    statusCaption.textContent=reason==='caught'?'CAUGHT':'SHIFT OVER';
    updateHUD();
    renderLeaderboard();
    setTimeout(()=>showScorecard(result),350);
  }

  function update(dt){
    // Founder becomes much quicker to check behind him as Threadguy gets close.
    const turnSpeed = founderTurnSpeed();
    const delta = state.targetLook - state.founderLook;
    state.founderLook += Math.sign(delta) * Math.min(Math.abs(delta), turnSpeed*dt);

    // Threadguy is only "seen" when Founder is actually facing LEFT at him.
    if(state.phase==='playing' && state.founderWatching && state.founderLook >= .985){
      if(state.detectionArmedAt === Infinity){
        state.detectionArmedAt = performance.now() + detectionGraceMs();
      }
      dangerEl.textContent = 'FREEZE';
      statusCaption.textContent = 'FREEZE';
    }

    if(state.phase!=='playing'||state.paused) return;

    state.t += dt;
    if(state.t>=RUN_SECONDS){
      state.t=RUN_SECONDS;
      finish('time');
      return;
    }

    if(!state.founderWatching && state.t>=state.nextTurn) founderTurnToWatch();
    if(state.founderWatching && state.t>=state.watchUntil) founderTurnAway();

    if(!state.founderWatching && state.founderLook < .90){
      dangerEl.classList.remove('show');
      statusCaption.textContent='SNEAK';
    }

    if(state.moving){
      if(state.founderWatching && performance.now() >= state.detectionArmedAt){
        finish('caught');
        return;
      }
      state.progress = Math.min(0.9995, state.progress + progressSpeed()*dt);
      state.power = calcPower();
    }
    updateHUD();
  }

  function drawImageCover(image, x, y, w, h, focusY=.62){
    if(!image.complete || !image.naturalWidth) return;
    const iw=image.naturalWidth, ih=image.naturalHeight;
    const destRatio=w/h, srcRatio=iw/ih;
    let sx=0, sy=0, sw=iw, sh=ih;
    if(destRatio > srcRatio){
      sh = iw/destRatio;
      sy = Math.max(0, Math.min(ih-sh, (ih-sh)*focusY));
    } else {
      sw = ih*destRatio;
      sx = (iw-sw)/2;
    }
    ctx.drawImage(image,sx,sy,sw,sh,x,y,w,h);
  }

  function drawSprite(img, centerX, floorY, targetH){
    if(!img || !img.complete || !img.naturalWidth) return;
    const ratio=img.naturalWidth/img.naturalHeight;
    const w=targetH*ratio;
    ctx.drawImage(img, Math.round(centerX-w/2), Math.round(floorY-targetH), Math.round(w), Math.round(targetH));
  }

  function founderFrame(){
    // Correct Sniff Game orientation:
    // SAFE state starts at frame 0 and Founder turns through the supplied
    // turnaround in the natural order: 0 -> 1 -> 2 -> 3 -> 4.
    // Frame 4 is the observation state facing Threadguy.
    const look = Math.max(0, Math.min(1, state.founderLook));
    if(look < .125) return founder[0];
    if(look < .375) return founder[1];
    if(look < .625) return founder[2];
    if(look < .875) return founder[3];
    return founder[4];
  }

  function threadFrame(){
    if(state.caught) return thread[3];
    if(state.moving) return thread[(Math.floor(state.t*6)%2)?1:2];
    return thread[0];
  }

  function draw(){
    resizeCanvas();
    const W=state.viewW, H=state.viewH;

    // The factory is the arena CSS background with background-size:cover.
    // Canvas remains transparent so the 2:1 source image is never stretched.
    ctx.clearRect(0,0,W,H);

    const floorY=H*.93;
    const startX=W*.13;
    const founderX=W*.89;
    // Even an exceptional run never lets the sprites physically overlap.
    const unreachableX=founderX-W*.086;
    const threadX=startX+(unreachableX-startX)*state.progress;

    // Light guide only; does not reveal an invisible "wall".
    ctx.save();
    ctx.globalAlpha=.27;
    ctx.strokeStyle='#dfb65f';
    ctx.lineWidth=1;
    ctx.setLineDash([7,10]);
    ctx.beginPath();
    ctx.moveTo(startX+30,floorY+10);
    ctx.lineTo(founderX-18,floorY+10);
    ctx.stroke();
    ctx.restore();

    // Character proportions stay consistent regardless of viewport.
    const founderH=Math.min(H*.73, 286);
    const threadH=Math.min(H*.64, 245);

    drawSprite(founderFrame(), founderX, floorY, founderH);
    drawSprite(threadFrame(), threadX, floorY, threadH);

    if(state.progress>.80){
      const a=(state.progress-.80)/.20*.16;
      const grad=ctx.createLinearGradient(founderX-W*.18,0,founderX,0);
      grad.addColorStop(0,'rgba(223,182,95,0)');
      grad.addColorStop(1,`rgba(223,182,95,${a})`);
      ctx.fillStyle=grad;
      ctx.fillRect(founderX-W*.18,0,W*.18,H);
    }
  }

  function loop(ts){
    const dt=Math.min(.035,(ts-state.lastTs)/1000||0);
    state.lastTs=ts;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  function updateHUD(){
    nearestEl.innerHTML=`${remainingPct().toFixed(1)}<small>%</small>`;
    const best=JSON.parse(localStorage.getItem('sniff-best')||'null');
    bestScoreEl.textContent=(best?.power||0).toLocaleString('en-US');
    bestPowerEl.textContent=best ? `${best.nearest.toFixed(2)}%` : '100.00%';
    timeLeftEl.textContent=Math.max(0,RUN_SECONDS-state.t).toFixed(1);
  }

  function renderLeaderboard(){
    const best=JSON.parse(localStorage.getItem('sniff-best')||'null');

    // Local V1 preview only. These demo workers are placeholders until the
    // live Employee Record leaderboard endpoint is wired in.
    const entries=[
      {name:'@nosework', nearest:1.34, power:9874},
      {name:'@threadmaxi', nearest:1.89, power:9632},
      {name:'@factoryrat', nearest:2.44, power:9410},
      {name:'@cuckshift', nearest:3.08, power:9188},
      {name:'@walnutworker', nearest:4.12, power:8870}
    ];

    if(best){
      entries.push({
        name:'@YOU',
        nearest:Number(best.nearest),
        power:Number(best.power),
        you:true
      });
    }

    // CUCK POWER is the competitive ranking metric because it already
    // combines proximity and pace. Nearest is shown as the secondary stat.
    entries.sort((a,b)=>{
      if(b.power !== a.power) return b.power-a.power;
      return a.nearest-b.nearest;
    });

    $('leaderRows').innerHTML=entries.map((entry,i)=>`
      <tr${entry.you?' class="leaderboard-you"':''}>
        <td>${i+1}</td>
        <td>${entry.name}${entry.you?' <small>YOU</small>':''}</td>
        <td>${entry.nearest.toFixed(2)}%</td>
        <td>${entry.power.toLocaleString('en-US')}</td>
      </tr>
    `).join('');
  }

  function scorecardCover(image, c, x,y,w,h, focusY=.62){
    if(!image.complete || !image.naturalWidth) return false;
    const iw=image.naturalWidth, ih=image.naturalHeight;
    const destRatio=w/h, srcRatio=iw/ih;
    let sx=0,sy=0,sw=iw,sh=ih;
    if(destRatio>srcRatio){sh=iw/destRatio;sy=Math.max(0,Math.min(ih-sh,(ih-sh)*focusY));}
    else{sw=ih*destRatio;sx=(iw-sw)/2;}
    c.drawImage(image,sx,sy,sw,sh,x,y,w,h);
    return true;
  }

  function showScorecard(r){
    cardPower.textContent=r.power.toLocaleString('en-US');
    drawScorecard(r);
    scorecardBackdrop.hidden=false;
  }

  function drawScorecard(r){
    const c=cardCtx;c.clearRect(0,0,1200,960);c.fillStyle='#130b07';c.fillRect(0,0,1200,960);
    if(cardScene.complete&&cardScene.naturalWidth){
      const iw=cardScene.naturalWidth,ih=cardScene.naturalHeight,dr=1200/874,sr=iw/ih;let sx=0,sy=0,sw=iw,sh=ih;
      if(dr>sr){sh=iw/dr;sy=Math.max(0,Math.min(ih-sh,(ih-sh)*.46));}else{sw=ih*dr;sx=(iw-sw)/2;}
      c.drawImage(cardScene,sx,sy,sw,sh,0,0,1200,874);
    }
    const top=c.createLinearGradient(0,0,0,220);top.addColorStop(0,'#100805d9');top.addColorStop(1,'#10080500');c.fillStyle=top;c.fillRect(0,0,1200,220);
    const bottom=c.createLinearGradient(0,525,0,874);bottom.addColorStop(0,'#10080500');bottom.addColorStop(.58,'#100805aa');bottom.addColorStop(1,'#100805f2');c.fillStyle=bottom;c.fillRect(0,525,1200,349);
    c.textAlign='center';c.shadowColor='#100805';c.shadowBlur=15;c.shadowOffsetY=3;c.fillStyle='#fff1ce';c.font='700 100px Oswald';c.fillText('SNIFF GAME',600,118);
    c.fillStyle='#edc879';c.font='600 27px "IBM Plex Mono"';c.fillText('NEAREST APPROACH TO THE FOUNDER',600,685);
    const nearest=`${r.nearest.toFixed(2)}% AWAY`;c.fillStyle='#fff1ce';c.font='700 132px Oswald';let w=c.measureText(nearest).width;if(w>1080)c.font=`700 ${132*1080/w}px Oswald`;c.fillText(nearest,600,818);
    c.shadowBlur=0;c.shadowOffsetY=0;c.fillStyle='#d8ae5c';c.fillRect(0,874,1200,4);c.fillStyle='#f6ecd4';c.fillRect(0,878,1200,82);c.fillStyle='#7d211c';c.font='700 28px Oswald';
    const line=`${r.power.toLocaleString('en-US')} CUCK POWER  ·  ${r.time.toFixed(1)}s  ·  PLAY @ CUCKS.MONEY`;c.fillText(line,600,931);
  }

  function downloadCard(){
    try{
      const a=document.createElement('a');
      a.download=`sniff-game-${state.power}-cuck-power.png`;
      a.href=scorecard.toDataURL('image/png');
      a.click();
    }catch(err){
      alert('Image export is available when the game is served over HTTP/HTTPS.');
    }
  }

  function shareX(){
    const best=JSON.parse(localStorage.getItem('sniff-best')||'null');
    if(!best) return;
    const text=`I got within ${best.nearest.toFixed(2)}% of the Founder and scored ${best.power.toLocaleString('en-US')} CUCK POWER in SNIFF GAME.\n\nGet to work: cucks.money`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`,'_blank','noopener,noreferrer');
  }

  // Keyboard + pointer controls.
  addEventListener('keydown',e=>{
    if(e.code==='Space'){
      e.preventDefault();
      if(!e.repeat) setMove(true);
    }
  });
  addEventListener('keyup',e=>{
    if(e.code==='Space'){
      e.preventDefault();
      setMove(false);
    }
  });
  addEventListener('blur',()=>setMove(false));

  [holdBtn, canvas].forEach(el=>{
    el.addEventListener('pointerdown',e=>{
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      setMove(true);
    });
    el.addEventListener('pointerup',e=>{
      e.preventDefault();
      setMove(false);
    });
    el.addEventListener('pointercancel',()=>setMove(false));
    el.addEventListener('lostpointercapture',()=>setMove(false));
  });

  $('startBtn').addEventListener('click',start);
  pauseBtn.addEventListener('click',()=>{
    if(state.phase!=='playing') return;
    state.paused=!state.paused;
    pauseBtn.textContent=state.paused?'▶':'Ⅱ';
    statusCaption.textContent=state.paused?'PAUSED':(state.founderWatching?'FREEZE':'SNEAK');
    if(state.paused) setMove(false);
  });
  $('playAgainBtn').addEventListener('click',()=>{scorecardBackdrop.hidden=true;start();});
  $('closeCardBtn').addEventListener('click',()=>scorecardBackdrop.hidden=true);
  $('downloadBtn').addEventListener('click',downloadCard);
  $('shareBtn').addEventListener('click',shareX);

  renderLeaderboard();
  updateHUD();
  addEventListener('resize',resizeCanvas);
  requestAnimationFrame(ts=>{state.lastTs=ts;loop(ts);});
})();
