let pdfName=null,pages=0,current=1,paths=[],selectedType='text',selectedPath=-1,drawing=false,start=null;
let libraryPdfs=[],batchSelection=new Set();
const img=document.getElementById('pageImg'),canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d');
function status(s){document.getElementById('status').textContent=s}
function setType(t){selectedType=t;document.querySelectorAll('#tools button').forEach(b=>b.classList.toggle('selected',b.dataset.type===t));status('Draw a rectangle: '+t)}
document.querySelectorAll('#tools button').forEach(b=>b.onclick=()=>setType(b.dataset.type));setType('text');
function resizeCanvas(){canvas.width=img.clientWidth;canvas.height=img.clientHeight;redraw()}
window.addEventListener('resize',resizeCanvas);
function loadPage(n){current=n;img.src='/api/page?page='+n+'&pdf='+encodeURIComponent(pdfName);img.onload=()=>{resizeCanvas();status('Page '+n+' — choose a type and draw a path.');};document.querySelectorAll('.thumb').forEach((x,i)=>x.classList.toggle('active',i+1===n))}

const HANDLE_SIZE=8;
let interaction=null;

function clamp(v,min=0,max=1){return Math.max(min,Math.min(max,v));}
function pointFromEvent(e){
  const r=canvas.getBoundingClientRect();
  return {x:clamp((e.clientX-r.left)/canvas.width),y:clamp((e.clientY-r.top)/canvas.height)};
}
function pathRectPx(p){
  const r=p.rect;
  return {x:r[0]*canvas.width,y:r[1]*canvas.height,w:r[2]*canvas.width,h:r[3]*canvas.height};
}
function hitPath(pt, onlyCurrent=true){
  for(let i=paths.length-1;i>=0;i--){
    const p=paths[i]; if(onlyCurrent && p.page!==current) continue;
    const r=p.rect;
    if(pt.x>=r[0] && pt.x<=r[0]+r[2] && pt.y>=r[1] && pt.y<=r[1]+r[3]) return i;
  }
  return -1;
}
function getHandle(pt,p){
  const r=pathRectPx(p), hs=HANDLE_SIZE+3;
  const x=pt.x*canvas.width,y=pt.y*canvas.height;
  const handles={
    nw:[r.x,r.y], n:[r.x+r.w/2,r.y], ne:[r.x+r.w,r.y],
    e:[r.x+r.w,r.y+r.h/2], se:[r.x+r.w,r.y+r.h],
    s:[r.x+r.w/2,r.y+r.h], sw:[r.x,r.y+r.h], w:[r.x,r.y+r.h/2]
  };
  for(const [name,[hx,hy]] of Object.entries(handles)){
    if(Math.abs(x-hx)<=hs && Math.abs(y-hy)<=hs) return name;
  }
  return null;
}
function drawHandles(p){
  const r=pathRectPx(p), s=HANDLE_SIZE;
  const pts=[[r.x,r.y],[r.x+r.w/2,r.y],[r.x+r.w,r.y],[r.x+r.w,r.y+r.h/2],[r.x+r.w,r.y+r.h],[r.x+r.w/2,r.y+r.h],[r.x,r.y+r.h],[r.x,r.y+r.h/2]];
  ctx.fillStyle='#fff';ctx.strokeStyle='#2563eb';ctx.lineWidth=1.5;
  pts.forEach(([x,y])=>{ctx.beginPath();ctx.rect(x-s/2,y-s/2,s,s);ctx.fill();ctx.stroke();});
}
function redraw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  paths.forEach((p,i)=>{
    if(p.page!==current)return;
    const r=p.rect,x=r[0]*canvas.width,y=r[1]*canvas.height,w=r[2]*canvas.width,h=r[3]*canvas.height;
    const selected=i===selectedPath;
    ctx.strokeStyle=selected?'#2563eb':'#f59e0b';ctx.lineWidth=selected?2.5:2;ctx.strokeRect(x,y,w,h);
    ctx.fillStyle=selected?'#1d4ed8':'#0b1220cc';ctx.fillRect(x,y,Math.min(145,w),20);
    ctx.fillStyle='#fff';ctx.font='12px Arial';ctx.fillText((i+1)+' '+p.type,x+5,y+14);
    if(selected) drawHandles(p);
  });
}
function updateCursor(e){
  const pt=pointFromEvent(e);
  if(selectedPath>=0 && paths[selectedPath]?.page===current){
    const h=getHandle(pt,paths[selectedPath]);
    if(h){canvas.style.cursor=({n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize',ne:'nesw-resize',sw:'nesw-resize',nw:'nwse-resize',se:'nwse-resize'})[h];return;}
    const hit=hitPath(pt);
    if(hit===selectedPath){canvas.style.cursor='move';return;}
  }
  canvas.style.cursor='crosshair';
}
canvas.addEventListener('mousemove',e=>{
  if(!interaction){updateCursor(e);return;}
  const pt=pointFromEvent(e), it=interaction;
  const p=paths[it.index];
  if(!p)return;
  if(it.mode==='draw'){
    const x0=Math.min(it.start.x,pt.x),y0=Math.min(it.start.y,pt.y),w=Math.abs(pt.x-it.start.x),h=Math.abs(pt.y-it.start.y);
    redraw();ctx.strokeStyle='#22d3ee';ctx.lineWidth=2;ctx.setLineDash([5,4]);ctx.strokeRect(x0*canvas.width,y0*canvas.height,w*canvas.width,h*canvas.height);ctx.setLineDash([]);return;
  }
  if(it.mode==='move'){
    const dx=pt.x-it.last.x,dy=pt.y-it.last.y;
    p.rect[0]=clamp(p.rect[0]+dx,0,1-p.rect[2]);p.rect[1]=clamp(p.rect[1]+dy,0,1-p.rect[3]);it.last=pt;
  } else if(it.mode==='resize'){
    const min=.005; let [x,y,w,h]=p.rect;
    const right=x+w,bottom=y+h;
    if(it.handle.includes('w')){x=clamp(pt.x,0,right-min);w=right-x;}
    if(it.handle.includes('e')){w=clamp(pt.x-x,min,1-x);}
    if(it.handle.includes('n')){y=clamp(pt.y,0,bottom-min);h=bottom-y;}
    if(it.handle.includes('s')){h=clamp(pt.y-y,min,1-y);}
    p.rect=[x,y,w,h];
  }
  renderPathList();redraw();updateCursor(e);
});
canvas.addEventListener('mousedown',e=>{
  if(e.button!==0)return;
  const pt=pointFromEvent(e);
  if(selectedPath>=0 && paths[selectedPath]?.page===current){
    const handle=getHandle(pt,paths[selectedPath]);
    if(handle){interaction={mode:'resize',index:selectedPath,handle};return;}
    if(hitPath(pt)===selectedPath){interaction={mode:'move',index:selectedPath,last:pt};return;}
  }
  const hit=hitPath(pt);
  if(hit>=0){selectedPath=hit;renderPathList();redraw();interaction={mode:'move',index:hit,last:pt};return;}
  interaction={mode:'draw',start:pt};
});
window.addEventListener('mouseup',e=>{
  if(!interaction)return;
  const it=interaction;interaction=null;
  if(it.mode==='draw'){
    const pt=pointFromEvent(e),x0=Math.min(it.start.x,pt.x),y0=Math.min(it.start.y,pt.y),w=Math.abs(pt.x-it.start.x),h=Math.abs(pt.y-it.start.y);
    if(w>=.01&&h>=.01){paths.push({page:current,type:selectedType,rect:[x0,y0,w,h]});selectedPath=paths.length-1;renderPathList();status('Path dibuat — tarik sudut/tepi untuk resize, atau tarik bagian tengah untuk memindahkan.');}
  } else if(it.mode==='move' || it.mode==='resize'){
    renderPathList();status(`Path ${selectedPath+1} dapat diubah langsung dengan drag.`);
  }
  redraw();updateCursor(e);
});
canvas.addEventListener('mouseleave',()=>{if(!interaction)canvas.style.cursor='crosshair'});
function syncTypeEditor(){
  const el=document.getElementById('pathType');
  if(!el)return;
  const p=paths[selectedPath];
  el.disabled=!(p && p.page===current);
  el.value=p?.type||'text';
}
function changeSelectedType(type){
  const allowed=['text','image','image_text'];
  if(!allowed.includes(type)||selectedPath<0||!paths[selectedPath])return;
  paths[selectedPath].type=type;
  syncTypeEditor();
  renderPathList();
  redraw();
  status(`Path ${selectedPath+1}: type diubah menjadi ${type==='image_text'?'Image + Text':type==='text'?'Text':'Image'}.`);
}
function renderPathList(){
  const el=document.getElementById('pathList');
  if(!el)return;
  if(!paths.length){el.className='empty';el.textContent='Tidak ada Path';syncTypeEditor();return;}
  el.className='path-items';
  el.innerHTML='';
  paths.forEach((p,i)=>{
    const item=document.createElement('button');
    item.type='button';
    item.className='path-item'+(i===selectedPath?' selected':'');
    item.innerHTML=`<span class="path-name">Path ${i+1}</span><span class="path-meta">Page ${p.page} · ${p.type}</span>`;
    item.onclick=()=>{selectedPath=i;current=p.page;loadPage(current);renderPathList();redraw();};
    el.appendChild(item);
  });
  syncTypeEditor();
  updateBatchButton();
}

/* ---- Pustaka PDF: listing, switch, delete ---- */
async function refreshLibrary(){
  try{
    const r=await fetch('/api/pdfs');
    const d=await r.json();
    libraryPdfs=Array.isArray(d.pdfs)?d.pdfs:[];
    renderLibrary();
  }catch(err){
    console.error('Gagal memuat Pustaka PDF',err);
  }
}
function renderLibrary(){
  const el=document.getElementById('pdfLibrary');
  if(!el)return;
  if(!libraryPdfs.length){
    el.className='empty';
    el.textContent='Belum ada PDF diupload.';
    updateBatchButton();
    return;
  }
  el.className='lib-items';
  el.innerHTML='';
  libraryPdfs.forEach(p=>{
    const row=document.createElement('div');
    row.className='lib-item'+(p.name===pdfName?' active':'');
    const checked=batchSelection.has(p.name)?'checked':'';
    row.innerHTML=`
      <label class="lib-check"><input type="checkbox" ${checked}></label>
      <div class="lib-info">
        <div class="lib-name" title="${p.name}">${p.name}</div>
        <div class="lib-meta">${p.pages} halaman</div>
      </div>
      <button type="button" class="lib-del" title="Hapus dari server">✕</button>
    `;
    row.querySelector('input[type=checkbox]').onchange=e=>{
      if(e.target.checked)batchSelection.add(p.name);else batchSelection.delete(p.name);
      updateBatchButton();
    };
    row.querySelector('.lib-info').onclick=()=>openLibraryPdf(p.name);
    row.querySelector('.lib-del').onclick=e=>{e.stopPropagation();deleteLibraryPdf(p.name);};
    el.appendChild(row);
  });
  updateBatchButton();
}
function updateBatchButton(){
  const btn=document.getElementById('batchExtractBtn');
  if(btn)btn.disabled=batchSelection.size<1||!paths.length;
}
function openLibraryPdf(name){
  const entry=libraryPdfs.find(p=>p.name===name);
  pdfName=name;pages=entry?entry.pages:0;paths=[];selectedPath=-1;
  renderPathList();
  const p=document.getElementById('pages');p.innerHTML='';
  for(let i=1;i<=pages;i++){
    const div=document.createElement('div');div.className='thumb';
    div.innerHTML=`<img src="/api/page?page=${i}&pdf=${encodeURIComponent(pdfName)}"><div>Page ${i}</div>`;
    div.onclick=()=>loadPage(i);p.appendChild(div);
  }
  document.getElementById('extractBtn').disabled=false;
  document.getElementById('generateBtn').disabled=false;
  loadPage(1);
  renderLibrary();
  status(`PDF aktif: ${name} — ${pages} halaman.`);
}
async function deleteLibraryPdf(name){
  if(!confirm(`Hapus "${name}" dari server secara permanen?`))return;
  try{
    const r=await fetch('/api/delete_pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pdf:name})});
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    batchSelection.delete(name);
    if(pdfName===name){
      pdfName=null;pages=0;paths=[];selectedPath=-1;
      document.getElementById('pages').innerHTML='';
      document.getElementById('extractBtn').disabled=true;
      document.getElementById('generateBtn').disabled=true;
      img.removeAttribute('src');
      renderPathList();redraw();
      status('PDF aktif dihapus. Buka atau upload PDF lain.');
    }
    await refreshLibrary();
  }catch(err){alert('Gagal menghapus PDF: '+(err?.message||err));}
}
async function batchExtract(){
  if(!batchSelection.size){alert('Centang minimal satu PDF di Pustaka untuk batch extract.');return;}
  if(!paths.length){alert('Definisikan Path terlebih dahulu di PDF yang sedang aktif.');return;}
  const btn=document.getElementById('batchExtractBtn');
  if(btn)btn.disabled=true;
  status(`Menjalankan Ekstrak Batch untuk ${batchSelection.size} PDF...`);
  try{
    const r=await fetch('/api/batch_extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pdfs:[...batchSelection],paths,text_mode:document.getElementById('textMode').value})});
    const raw=await r.text();
    let d;try{d=JSON.parse(raw)}catch{throw new Error(raw||`HTTP ${r.status}`)}
    if(!r.ok||d.error)throw new Error(d.error||`Batch extract gagal (HTTP ${r.status})`);
    document.getElementById('result').textContent=JSON.stringify(d.summary,null,2)+'\n\nDownload: '+d.download;
    document.getElementById('modal').classList.add('show');
    status(`Batch selesai: ${d.summary.success}/${d.summary.total_pdfs} PDF berhasil.`);
  }catch(err){alert('Batch extract gagal: '+(err?.message||err));status('Batch extract gagal.');}
  finally{updateBatchButton();}
}
function deleteSelected(){
  if(selectedPath<0 || !paths[selectedPath])return false;
  const deletedIndex=selectedPath;
  paths.splice(deletedIndex,1);
  if(!paths.length){
    selectedPath=-1;
  }else{
    selectedPath=Math.min(deletedIndex,paths.length-1);
  }
  renderPathList();
  redraw();
  status(`Path ${deletedIndex+1} dihapus.`);
  return true;
}

// Hapus Path terpilih dengan keyboard Delete / Backspace.
// Jangan menangkap tombol ketika user sedang mengetik di input/select/textarea.
document.addEventListener('keydown',e=>{
  if(e.key!=='Delete' && e.key!=='Backspace')return;
  const target=e.target;
  const tag=(target?.tagName||'').toLowerCase();
  if(tag==='input' || tag==='textarea' || tag==='select' || target?.isContentEditable)return;
  if(selectedPath<0 || !paths[selectedPath])return;
  e.preventDefault();
  deleteSelected();
});

function savePaths(){
  if(!pdfName){alert('Buka PDF terlebih dahulu.');return;}
  const blob=new Blob([JSON.stringify({pdf:pdfName,paths},null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=pdfName.replace(/\.pdf$/i,'')+'.paths.json';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),500);
}
function loadPaths(){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.json,application/json';
  inp.onchange=async()=>{
    const file=inp.files?.[0];
    if(!file)return;
    try{
      const d=JSON.parse(await file.text());
      if(!Array.isArray(d.paths))throw new Error('File Path tidak valid: data paths tidak ditemukan.');
      if(d.pdf && pdfName && d.pdf!==pdfName){
        const ok=confirm(`Path ini dibuat untuk PDF "${d.pdf}". PDF yang sedang dibuka adalah "${pdfName}". Tetap import?`);
        if(!ok)return;
      }
      paths=d.paths.filter(p=>p && Number.isFinite(p.page) && Array.isArray(p.rect) && p.rect.length===4).map(p=>({
        page:Number(p.page),type:p.type||'text',rect:p.rect.map(Number)
      }));
      selectedPath=-1;
      renderPathList();
      if(paths.length){current=paths[0].page;loadPage(current);}
      redraw();
      status(`Import Path berhasil: ${paths.length} Path.`);
    }catch(err){alert('Import Path gagal: '+(err?.message||err));status('Import Path gagal.');}
    finally{inp.value='';}
  };
  document.body.appendChild(inp);inp.click();inp.remove();
}
async function generatePaths(){
  if(!pdfName){alert('Buka PDF terlebih dahulu.');return;}
  if(paths.length && !confirm('Generate Paths akan mengganti Path yang sedang ada. Lanjutkan?'))return;
  const btn=document.getElementById('generateBtn');
  if(btn)btn.disabled=true;
  status('Generating Paths untuk seluruh PDF...');
  try{
    const r=await fetch('/api/generate_paths',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pdf:pdfName})});
    const raw=await r.text();
    let d;try{d=JSON.parse(raw)}catch{throw new Error(raw||`Server mengembalikan HTTP ${r.status}`)}
    if(!r.ok || d.error)throw new Error(d.error||`Generate gagal (HTTP ${r.status})`);
    paths=Array.isArray(d.paths)?d.paths:[];
    selectedPath=paths.length?0:-1;
    renderPathList();
    if(paths.length){current=paths[0].page;loadPage(current);redraw();}
    status(`Generate selesai: ${paths.length} Path dibuat untuk ${pages} halaman.`);
  }catch(err){console.error(err);alert('Generate Paths gagal: '+(err?.message||err));status('Generate Paths gagal.');}
  finally{if(btn)btn.disabled=!pdfName;}
}
async function openPdfFile(file){
  if(!file)return;
  if(file.type!=='application/pdf' && !/\.pdf$/i.test(file.name)){
    alert('File yang dipilih harus PDF.');return;
  }
  const btn=document.querySelector('header button');
  if(btn)btn.disabled=true;
  status('Uploading PDF...');
  try{
    const r=await fetch('/api/upload',{
      method:'POST',
      headers:{'Content-Type':'application/pdf','X-Filename':encodeURIComponent(file.name)},
      body:file
    });
    const raw=await r.text();
    let d;try{d=JSON.parse(raw)}catch{throw new Error(raw||`Server mengembalikan HTTP ${r.status}`)}
    if(!r.ok || d.error)throw new Error(d.error||`Upload gagal (HTTP ${r.status})`);
    pdfName=d.pdf;pages=Number(d.pages)||0;paths=[];selectedPath=-1;
    renderPathList();
    const p=document.getElementById('pages');p.innerHTML='';
    for(let i=1;i<=pages;i++){
      const div=document.createElement('div');div.className='thumb';
      div.innerHTML=`<img src="/api/page?page=${i}&pdf=${encodeURIComponent(pdfName)}"><div>Page ${i}</div>`;
      div.onclick=()=>loadPage(i);p.appendChild(div);
    }
    document.getElementById('extractBtn').disabled=false;
    document.getElementById('generateBtn').disabled=false;
    loadPage(1);
    await refreshLibrary();
    status(`PDF berhasil diimport: ${file.name} — ${pages} halaman.`);
  }catch(err){
    console.error(err);alert('Import PDF gagal: '+(err?.message||err));status('Import PDF gagal.');
  }finally{
    if(btn)btn.disabled=false;
    document.getElementById('file').value='';
  }
}
document.getElementById('file').addEventListener('change',e=>openPdfFile(e.target.files?.[0]));
async function extract(){if(!pdfName||!paths.length)return;document.getElementById('extractBtn').disabled=true;status('Extracting — '+(document.getElementById('textMode').value==='split'?'Pisah (Label : Nilai)':'Gabung')+'...');let r=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pdf:pdfName,paths,text_mode:document.getElementById('textMode').value})});let d=await r.json();document.getElementById('extractBtn').disabled=false;if(d.error){alert(d.error);status('Extraction failed');return}document.getElementById('result').textContent=JSON.stringify(d.summary,null,2)+'\n\nDownload: '+d.download;document.getElementById('modal').classList.add('show');status('Extraction complete');}
function closeModal(){document.getElementById('modal').classList.remove('show')}

function deleteAllPaths(){
  if(!paths || paths.length===0)return;
  const confirmed=confirm(`Hapus semua ${paths.length} Path?`);
  if(!confirmed)return;
  paths.length=0;
  selectedPath=-1;
  renderPathList();
  redraw();
  status('Semua Path dihapus.');
}

document
  .getElementById("deleteAllPathsBtn")
  .addEventListener("click", deleteAllPaths);

refreshLibrary();
