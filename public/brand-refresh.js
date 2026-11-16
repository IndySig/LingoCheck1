(()=>{
 const e=React.createElement;
 const examples=[
  {title:'Meaning',source:'El desayuno se sirve de siete a diez.',before:'Breakfast is served from seven until nine.',start:'Breakfast is served from seven until ',wrong:'nine',right:'ten',end:'.',note:'One small word. A different promise. The reviewer checks the detail against the source.'},
  {title:'Natural tone',source:'Siéntete como en casa.',before:'Make yourself at your house.',start:'',wrong:'Make yourself at your house.',right:'Make yourself at home.',end:'',note:'The words were almost right. A reviewer makes the expression feel natural.'},
  {title:'Terminology',source:'Guarda tus cambios en el espacio de trabajo.',before:'Save your changes to the workshop.',start:'Save your changes to the ',wrong:'workshop',right:'workspace',end:'.',note:'Context matters. Here, “workspace” refers to software, not a physical workshop.'}
 ];
 function MotionHeading(){
  const ref=React.useRef(null);
  React.useEffect(()=>{
   const host=ref.current,chars=Array.from(host.querySelectorAll('.kinetic-char')),media=matchMedia('(prefers-reduced-motion: reduce)');
   let raf=0,mx=-9999,my=-9999,last=performance.now(),local=[];
   const state=chars.map(()=>({x:0,y:0,r:0}));
   const measure=()=>{const box=host.getBoundingClientRect();local=chars.map(c=>{const b=c.getBoundingClientRect();return {x:b.left+b.width/2-box.left,y:b.top+b.height/2-box.top};});};
   const draw=now=>{raf=0;const dt=Math.min(.05,(now-last)/1000);last=now;const box=host.getBoundingClientRect();const scroll=Math.max(0,Math.min(1,-(box.top-100)/500));const k=1-Math.exp(-dt*14);let moving=false;chars.forEach((c,i)=>{const p=local[i]||{x:0,y:0};const dx=box.left+p.x-mx,dy=box.top+p.y-my,dist=Math.hypot(dx,dy),force=media.matches?0:Math.max(0,1-dist/140);const tx=force*dx*.2,ty=force*dy*.2-scroll*(i%5)*7,tr=force*dx*.04;const s=state[i];s.x+=(tx-s.x)*k;s.y+=(ty-s.y)*k;s.r+=(tr-s.r)*k;if(Math.abs(s.x-tx)+Math.abs(s.y-ty)+Math.abs(s.r-tr)>.04)moving=true;c.style.transform='translate3d('+s.x.toFixed(2)+'px,'+s.y.toFixed(2)+'px,0) rotate('+s.r.toFixed(2)+'deg)';});if(moving)raf=requestAnimationFrame(draw);};
   const start=()=>{if(!raf){last=performance.now();raf=requestAnimationFrame(draw);}};
   const move=ev=>{if(ev.pointerType==='touch')return;mx=ev.clientX;my=ev.clientY;start();};const leave=()=>{mx=my=-9999;start();};
   const onScroll=()=>{measure();start();};
   measure();
   host.addEventListener('pointermove',move);host.addEventListener('pointerleave',leave);window.addEventListener('scroll',onScroll,{passive:true});window.addEventListener('resize',measure);
   return()=>{cancelAnimationFrame(raf);host.removeEventListener('pointermove',move);host.removeEventListener('pointerleave',leave);window.removeEventListener('scroll',onScroll);window.removeEventListener('resize',measure);};
  },[]);
  return e('h1',{id:'brand-title',ref,'aria-label':'AI gets it started. People get it right.'},['AI gets it started.','People get it right.'].map((line,k)=>e('span',{className:'kinetic-line',key:k,'aria-hidden':'true'},line.split(' ').map((word,j)=>e('span',{className:'kinetic-word',key:j},word.split('').map((c,i)=>e('span',{className:'kinetic-char',key:i},c)),j<line.split(' ').length-1?'\u00a0':'')))));
 }
 function riverPath(w,h){
  const n=Math.max(3,Math.round(h/980));
  let y=-80,x=w*0.78,d='M '+x.toFixed(1)+' '+y.toFixed(1);
  for(let i=0;i<n;i++){
   const y1=i===n-1?h+80:y+(h+160)/n;
   const edge=i%2===0?-w*0.12:w*1.12;
   const mid=(y+y1)/2;
   const land=i%2===0?w*0.18:w*0.82;
   d+=' C '+x.toFixed(1)+' '+(y+(mid-y)*0.72).toFixed(1)+', '+edge.toFixed(1)+' '+(mid-120).toFixed(1)+', '+edge.toFixed(1)+' '+mid.toFixed(1);
   d+=' C '+edge.toFixed(1)+' '+(mid+140).toFixed(1)+', '+land.toFixed(1)+' '+(y1-110).toFixed(1)+', '+land.toFixed(1)+' '+y1.toFixed(1);
   x=land;y=y1;
  }
  return d;
 }
 function RiverLine(){
  React.useEffect(()=>{
   const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
   svg.setAttribute('class','brand-river-page');
   svg.setAttribute('aria-hidden','true');
   const stroke=document.createElementNS('http://www.w3.org/2000/svg','path');
   stroke.setAttribute('class','brand-river-stroke');
   svg.append(stroke);
   document.body.prepend(svg);
   const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
   let built={w:0,h:0},len=1,samples=[],raf=0,current=0,target=0;
   const place=at=>{
    const drawn=Math.max(0,Math.min(len,at));
    stroke.style.strokeDasharray=String(len);
    stroke.style.strokeDashoffset=String(len-drawn);
    stroke.style.opacity=drawn<12?'0':'1';
   };
   const lengthForY=y=>{
    let at=0;
    for(let i=0;i<samples.length;i++) if(samples[i].y<=y) at=samples[i].len;
    return at;
   };
   const step=()=>{
    current+=(target-current)*(reduced?1:0.18);
    if(Math.abs(target-current)<1.5){current=target;raf=0;}
    else raf=requestAnimationFrame(step);
    place(current);
   };
   const rebuild=()=>{
    const w=document.documentElement.clientWidth||window.innerWidth;
    const h=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight,window.innerHeight);
    if(Math.abs(w-built.w)<12&&Math.abs(h-built.h)<24)return;
    built={w,h};
    svg.setAttribute('viewBox','0 0 '+w+' '+h);
    svg.style.height=h+'px';
    stroke.setAttribute('d',riverPath(w,h));
    stroke.style.strokeWidth=Math.round(Math.min(56,Math.max(26,w*0.03)))+'px';
    len=stroke.getTotalLength()||1;
    samples=[];
    const steps=Math.max(64,Math.round(len/20));
    for(let i=0;i<=steps;i++){
     const at=len*i/steps,pt=stroke.getPointAtLength(at);
     samples.push({len:at,y:pt.y});
    }
    place(current);
   };
   const measure=()=>{
    rebuild();
    const max=Math.max(1,document.documentElement.scrollHeight-window.innerHeight);
    const p=Math.max(0,Math.min(1,window.scrollY/max));
    target=reduced?len:(window.scrollY<4?0:lengthForY(window.scrollY+window.innerHeight*(0.5+0.65*p)));
    if(!raf)raf=requestAnimationFrame(step);
   };
   measure();
   window.addEventListener('scroll',measure,{passive:true});
   window.addEventListener('resize',measure);
   const watch=new ResizeObserver(measure);
   watch.observe(document.body);
   return()=>{cancelAnimationFrame(raf);watch.disconnect();window.removeEventListener('scroll',measure);window.removeEventListener('resize',measure);svg.remove();};
  },[]);
  return null;
 }
 window.LcLanding=function(){
  const [active,setActive]=React.useState(0),[reviewed,setReviewed]=React.useState(true);
  const item=examples[active];
  return e(React.Fragment,null,
   e('section',{className:'brand-hero','aria-labelledby':'brand-title'},
    e('div',{className:'brand-hero-grid'},
    e('div',{className:'brand-hero-content'},
     e('div',{className:'brand-eyebrow'},e('span',{className:'brand-spark','aria-hidden':'true'},'✦'),' AI TRANSLATION. HUMAN PRECISION.'),
     e(MotionHeading),
     e('p',{className:'brand-intro'},'Keep the speed of AI. Add the judgement of a human. Your translation, carefully checked against the original.'),
     e('div',{className:'brand-actions'},e('a',{href:'#review-start',className:'brand-button brand-primary'},'Check your translation ',e('span',{'aria-hidden':'true'},'↗')),e('a',{href:'#review-example',className:'brand-button brand-secondary'},'See the difference ',e('span',{'aria-hidden':'true'},'↓'))),
     e('div',{className:'brand-trust'},e('span',null,'Your AI tool'),e('b',{'aria-hidden':'true'},'+'),e('span',null,'Human expertise'),e('b',{'aria-hidden':'true'},'='),e('span',null,'Words you can stand behind'))
    ),
    ),
   ),
   e(RiverLine),
   e('section',{className:'brand-proof'},
    e('div',{className:'brand-proof-intro'},e('span',{className:'brand-small'},'A SMALL CHANGE. A BIG DIFFERENCE.'),e('h2',null,'The details make',e('br'),e('em',null,'the difference.')),e('p',null,'Meaning. Tone. Terminology. See what changes when a human looks closer.')),
    e('div',{className:'brand-example',id:'review-example',onPointerMove:ev=>{if(ev.pointerType==='touch'||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const b=ev.currentTarget.getBoundingClientRect();ev.currentTarget.style.setProperty('--tilt-x',((ev.clientY-b.top)/b.height-.5)*-3+'deg');ev.currentTarget.style.setProperty('--tilt-y',((ev.clientX-b.left)/b.width-.5)*3+'deg');},onPointerLeave:ev=>{ev.currentTarget.style.setProperty('--tilt-x','0deg');ev.currentTarget.style.setProperty('--tilt-y','0deg');}},
     e('div',{className:'brand-example-header'},e('div',null,e('span',{className:'brand-icon','aria-hidden':'true'},'L'),e('strong',null,'The human difference')),e('span',{className:'brand-example-label'},'Interactive example')),
     e('div',{className:'brand-tabs',role:'group','aria-label':'Example type'},examples.map((x,i)=>e('button',{key:x.title,type:'button','aria-pressed':active===i,onClick:()=>{setActive(i);setReviewed(true);},className:active===i?'selected':''},x.title))),
     e('div',{className:'brand-source'},e('span',{className:'brand-small'},'SPANISH SOURCE'),e('p',null,item.source)),
     e('div',{className:'brand-comparison'},
      e('div',{className:'brand-draft'},e('span',{className:'brand-small'},'AI DRAFT'),e('p',null,item.before),e('span',{className:'brand-caption'},'Fluent doesn’t always mean accurate.')),
      e('div',{className:'brand-revised'},e('div',{className:'brand-revised-heading'},e('span',{className:'brand-small'},'WITH HUMAN REVIEW'),e('button',{type:'button',className:'brand-toggle','aria-pressed':reviewed,onClick:()=>setReviewed(!reviewed)},reviewed?'Hide correction':'Show correction')),
       e('p',{'aria-live':'polite'},reviewed?e(React.Fragment,null,item.start,e('del',null,item.wrong),' ',e('mark',null,item.right),item.end):item.before),
       e('div',{className:'brand-review-note'},e('span',{'aria-hidden':'true'},'✦'),reviewed?item.note:'Reveal the correction to see what a human reviewer adds.'))
     ),
     e('div',{className:'brand-example-bottom'},e('span',null,'Illustrative examples · not a live AI result'),e('a',{href:'/revisor.html'},'Explore the review workspace ↗'))
    )
   ),
   e('section',{className:'brand-benefits','aria-label':'What a reviewer checks'},
    e('p',{className:'brand-benefits-title'},'Beyond spelling.',e('br'),e('strong',null,'Down to the meaning.')),
    e('div',null,e('span',null,'01 / ACCURACY'),e('p',null,'Nothing lost.',e('br'),'Nothing invented.')),
    e('div',null,e('span',null,'02 / VOICE'),e('p',null,'The right words.',e('br'),'The right feeling.')),
    e('div',null,e('span',null,'03 / CONSISTENCY'),e('p',null,'Your terminology.',e('br'),'Used consistently.'))
   )
  );
 };
})();
