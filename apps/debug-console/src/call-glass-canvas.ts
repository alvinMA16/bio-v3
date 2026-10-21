import { lensOffset, lensSurface, lensLighting } from './glass-optics';
import { createFeltGrain, paintCallScene } from './call-scene';

const tintRGB=[205,230,202] as const;

type Lens = { layer: HTMLCanvasElement; context: CanvasRenderingContext2D; image: ImageData; field: Float32Array; key: string };
type Placement = { element: HTMLButtonElement; x: number; y: number; w: number; h: number; r: number; lens: Lens };

/** Cache optical geometry; only live background samples change from frame to frame. */
function createLens(w: number, h: number, r: number, scale: number): Lens {
  const layer=document.createElement('canvas');layer.width=Math.ceil(w*scale);layer.height=Math.ceil(h*scale);
  const context=layer.getContext('2d')!;
  const image=context.createImageData(layer.width,layer.height),field=new Float32Array(layer.width*layer.height*5);
  for(let y=0;y<layer.height;y++) for(let x=0;x<layer.width;x++) {
    const px=(x+.5)/scale,py=(y+.5)/scale;
    const {depth,nx,ny}=lensSurface(px,py,w,h,r);
    const i=(y*layer.width+x)*5;if(depth<=0)continue;
    const offset=lensOffset(px,py,w,h,r),lighting=lensLighting(depth,nx,ny);
    field[i]=(px+offset.x)*scale;field[i+1]=(py+offset.y)*scale;
    field[i+2]=lighting.light;field[i+3]=lighting.shade;
    field[i+4]=Math.min(1,depth*scale);

  }
  return {layer,context,image,field,key:`${w}:${h}:${r}:${scale}`};
}

export function mountCallGlass(canvas: HTMLCanvasElement, screen: HTMLElement) {
  const ctx=canvas.getContext('2d');if(!ctx)return;
  const backdrop=document.createElement('canvas'),bg=backdrop.getContext('2d',{willReadFrequently:true});if(!bg)return;
  const grain=bg.createPattern(createFeltGrain(),'repeat');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),solid=matchMedia('(prefers-reduced-transparency: reduce)');
  const lenses=new Map<HTMLButtonElement,Lens>();
  let frame=0,last=0,stopped=false,dirty=true;
  let startedAt: number | undefined;
  function clearControls(){for(const e of lenses.keys())e.removeAttribute('data-canvas-glass');lenses.clear();}
  function draw(now: number) {
    frame=0;if(stopped||document.hidden)return;
    if(!dirty&&now-last<1000/24){if(!reduced.matches)frame=requestAnimationFrame(draw);return;}
    dirty=false;last=now;
    try {
      const box=canvas.getBoundingClientRect(),w=canvas.clientWidth,h=canvas.clientHeight;
      if(!w||!h){schedule();return;}
      // Start at the designed entrance phase, independent of the page's age.
      startedAt??=now;
      const scale=Math.min(devicePixelRatio||1,1.5),pw=Math.round(w*scale),ph=Math.round(h*scale);
      if(canvas.width!==pw||canvas.height!==ph){canvas.width=backdrop.width=pw;canvas.height=backdrop.height=ph;}
      bg!.setTransform(scale,0,0,scale,0,0);paintCallScene(bg!,w,h,reduced.matches?0:(now-startedAt)/1000,grain);
      ctx!.setTransform(scale,0,0,scale,0,0);ctx!.clearRect(0,0,w,h);ctx!.drawImage(backdrop,0,0,w,h);
      if(solid.matches){clearControls();}
      else {
        const placements: Placement[]=[];
        for(const element of screen.querySelectorAll<HTMLButtonElement>('.phone-dialing button.product-control')) {
          const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)continue;
          const sx=w/box.width,sy=h/box.height,bw=rect.width*sx,bh=rect.height*sy;
          const r=Math.min(bw/2,bh/2,parseFloat(getComputedStyle(element).borderTopLeftRadius)||24);
          const key=`${bw}:${bh}:${r}:${scale}`;let lens=lenses.get(element);
          if(!lens||lens.key!==key){lens=createLens(bw,bh,r,scale);lenses.set(element,lens);}
          placements.push({element,x:(rect.x-box.x)*sx,y:(rect.y-box.y)*sy,w:bw,h:bh,r,lens});
        }
        for(const e of lenses.keys())if(!placements.some(p=>p.element===e)){e.removeAttribute('data-canvas-glass');lenses.delete(e);}
        if(placements.length){
          const left=Math.max(0,Math.floor(Math.min(...placements.map(p=>p.x))*scale)-32);
          const top=Math.max(0,Math.floor(Math.min(...placements.map(p=>p.y))*scale)-32);
          const right=Math.min(pw,Math.ceil(Math.max(...placements.map(p=>p.x+p.w))*scale)+32);
          const bottom=Math.min(ph,Math.ceil(Math.max(...placements.map(p=>p.y+p.h))*scale)+32);
          if(right<=left||bottom<=top){clearControls();return;}
          const source=bg!.getImageData(left,top,right-left,bottom-top),src=source.data;
          for(const p of placements){
            const {element,lens}=p,disabled=element.disabled,tint=element.classList.contains('product-control--primary')?.09:.055;
            const opacity=disabled?.45:1,pressed=element.matches(':active'),hovered=element.matches(':hover');
            ctx!.save();ctx!.globalAlpha=opacity;ctx!.shadowColor=hovered?'#06171d55':'#06171d44';ctx!.shadowBlur=pressed?4:hovered?10:8;ctx!.shadowOffsetY=pressed?1:3;
            ctx!.fillStyle='#c8e1cc0c';ctx!.beginPath();ctx!.roundRect(p.x,p.y,p.w,p.h,p.r);ctx!.fill();ctx!.restore();
            for(let k=0;k<lens.field.length/5;k++){
              const f=k*5,i=k*4,a=lens.field[f+4]!;if(!a)continue;
              const sx=Math.max(0,Math.min(source.width-2,p.x*scale-left+lens.field[f]!));
              const sy=Math.max(0,Math.min(source.height-2,p.y*scale-top+lens.field[f+1]!));
              const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy,b=(iy*source.width+ix)*4;
              for(let c=0;c<3;c++){
                const v0=(src[b+c]!*(1-fx)+src[b+c+4]!*fx)*(1-fy)+(src[b+c+source.width*4]!*(1-fx)+src[b+c+source.width*4+4]!*fx)*fy;
                let v=v0*(1-tint)+tintRGB[c]!*tint;
                v+=(255-v)*lens.field[f+2]!;v-=v*lens.field[f+3]!;
                lens.image.data[i+c]=v;
              }
              lens.image.data[i+3]=a*255;
            }
            lens.context.putImageData(lens.image,0,0);
            ctx!.save();ctx!.globalAlpha=opacity;ctx!.drawImage(lens.layer,p.x,p.y,p.w,p.h);ctx!.restore();
            element.setAttribute('data-canvas-glass','');
          }
        }
      }
    } catch (error) {
      console.warn('Call glass rendering unavailable; using native controls.', error);
      // Keep native controls readable and interactive if the canvas cannot render.
      stopped=true;clearControls();return;
    }
    if(!reduced.matches)frame=requestAnimationFrame(draw);
  }
  function schedule(){dirty=true;if(!stopped&&!frame&&!document.hidden)frame=requestAnimationFrame(draw);}
  const resize=new ResizeObserver(schedule);resize.observe(canvas);resize.observe(screen);
  const mutations=new MutationObserver(schedule);mutations.observe(screen,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','disabled']});
  function visibility(){if(document.hidden){cancelAnimationFrame(frame);frame=0;}else schedule();}
  document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',schedule);solid.addEventListener('change',schedule);
  screen.addEventListener('pointerover',schedule);screen.addEventListener('pointerout',schedule);
  screen.addEventListener('pointerdown',schedule);screen.addEventListener('pointerup',schedule);screen.addEventListener('pointercancel',schedule);screen.addEventListener('focusin',schedule);screen.addEventListener('scroll',schedule,true);
  schedule();
  return ()=>{stopped=true;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();clearControls();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',schedule);solid.removeEventListener('change',schedule);screen.removeEventListener('pointerover',schedule);screen.removeEventListener('pointerout',schedule);screen.removeEventListener('pointerdown',schedule);screen.removeEventListener('pointerup',schedule);screen.removeEventListener('pointercancel',schedule);screen.removeEventListener('focusin',schedule);screen.removeEventListener('scroll',schedule,true);};
}
