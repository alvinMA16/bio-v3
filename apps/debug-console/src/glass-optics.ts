/** Shared capsule geometry used by live SVG displacement and the Canvas renderer. */
export function lensSurface(x: number, y: number, width: number, height: number, radius: number) {
  const dx=x-width/2,dy=y-height/2;
  const qx=Math.max(Math.abs(dx)-(width/2-radius),0),qy=Math.max(Math.abs(dy)-(height/2-radius),0);
  const length=Math.hypot(qx,qy);
  return { dx,dy,depth:radius-length,nx:length?Math.sign(dx)*qx/length:0,ny:length?Math.sign(dy)*qy/length:0 };
}
export function lensOffset(x: number, y: number, width: number, height: number, radius: number) {
  const {dx,dy,depth,nx,ny}=lensSurface(x,y,width,height,radius);
  if(depth<=0)return {x:0,y:0};
  const magnification=1+.045*(1-Math.exp(-depth/7));
  const bend=9*Math.exp(-depth/7)*(1-Math.exp(-depth/1.1));
  return {x:dx/magnification-dx+nx*bend,y:dy/magnification-dy+ny*bend};
}
export function lensLighting(depth: number, nx: number, ny: number) {
  if(depth<=0)return {light:0,shade:0};
  // One fine directional glint; the refraction supplies the curved depth.
  const rim=Math.exp(-depth/.72);
  return {
    light:rim*Math.max(0,-nx*.5-ny*.85)*.58,
    shade:rim*Math.max(0,nx*.5+ny*.85)*.18,
  };
}

const selector = '.phone-screen .product-control, .phone-screen .slide-to-end, .phone-screen .slide-to-end-thumb, .phone-screen .material-filters, .phone-screen .material-glass-thumb, .phone-screen .material-add, .phone-screen .search-clear, .phone-screen .document-highlight-note button, .account-card button';
const ns = 'http://www.w3.org/2000/svg';
let nextId = 0;
export function installGlassOptics(root: HTMLElement = document.body) {
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  const defs = document.createElementNS(ns, 'defs'); svg.append(defs); root.append(svg);
  const entries = new Map<HTMLElement, { filter: SVGFilterElement; size: string }>();
  const reduced = matchMedia('(prefers-reduced-transparency: reduce)');
  let frame = 0;
  const update = (element: HTMLElement) => {
    const entry = entries.get(element); if (!entry) return;
    const width = element.offsetWidth, height = element.offsetHeight;
    if (!width || !height) return;
    const radius = Math.min(width / 2, height / 2, parseFloat(getComputedStyle(element).borderTopLeftRadius) || 24);
    const size = `${width}:${height}:${radius}`;
    if (entry.size === size) return;
    entry.size = size;
    const map = document.createElement('canvas'); map.width = width; map.height = height;
    const context = map.getContext('2d'); if (!context) return;
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = lensOffset(x + .5, y + .5, width, height, radius), i = (y * width + x) * 4;
      image.data[i] = Math.round(255 * (.5 + offset.x / 32));
      image.data[i + 1] = Math.round(255 * (.5 + offset.y / 32));
      image.data[i + 2] = 128; image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    // A directional curved reflection, generated from the same surface as the lens.
    const rim=document.createElement('canvas'),density=Math.min(devicePixelRatio||1,2);
    rim.width=Math.ceil(width*density);rim.height=Math.ceil(height*density);
    const rimContext=rim.getContext('2d')!;const pixels=rimContext.createImageData(rim.width,rim.height);
    for(let y=0;y<rim.height;y++)for(let x=0;x<rim.width;x++){
      const surface=lensSurface((x+.5)/density,(y+.5)/density,width,height,radius);
      if(surface.depth<=0)continue;
      const {light,shade}=lensLighting(surface.depth,surface.nx,surface.ny);
      const alpha=light+shade*(1-light),i=(y*rim.width+x)*4;
      const value=alpha?255*light*(1-shade)/alpha:0;
      pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=value;
      pixels.data[i+3]=alpha*Math.min(1,surface.depth*density)*255;
    }
    rimContext.putImageData(pixels,0,0);element.style.setProperty('--glass-rim',`url("${rim.toDataURL()}")`);
    const source = document.createElementNS(ns, 'feImage');
    source.setAttribute('href', map.toDataURL()); source.setAttribute('width', String(width)); source.setAttribute('height', String(height)); source.setAttribute('result', 'lens');
    const displacement = document.createElementNS(ns, 'feDisplacementMap');
    for (const [key, value] of Object.entries({ in: 'SourceGraphic', in2: 'lens', scale: '32', xChannelSelector: 'R', yChannelSelector: 'G' })) displacement.setAttribute(key, value);
    entry.filter.replaceChildren(source, displacement);
    element.style.setProperty('--glass-optics', `url("#${entry.filter.id}")`);
  };
  const resize = new ResizeObserver(items => { for (const item of items) update(item.target as HTMLElement); });
  const scan = () => {
    frame = 0;
    for (const [element, entry] of entries) if (reduced.matches || !root.contains(element) || !element.matches(selector)) {
      resize.unobserve(element); element.style.removeProperty('--glass-optics'); element.style.removeProperty('--glass-rim'); entry.filter.remove(); entries.delete(element);
    }
    if (reduced.matches) return;
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      if (entries.has(element)) continue;
      const filter = document.createElementNS(ns, 'filter'); filter.id = `product-lens-${++nextId}`;
      for (const [key, value] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' })) filter.setAttribute(key, value);
      defs.append(filter); entries.set(element, { filter, size: '' }); resize.observe(element); update(element);
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(scan); };
  const mutations = new MutationObserver(records => { if (records.some(record => !svg.contains(record.target))) schedule(); });
  mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  reduced.addEventListener('change', schedule); scan();
  return () => {
    cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect(); reduced.removeEventListener('change', schedule);
    for (const element of entries.keys()) { element.style.removeProperty('--glass-optics'); element.style.removeProperty('--glass-rim'); }
    entries.clear(); svg.remove();
  };
}
