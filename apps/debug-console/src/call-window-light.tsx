import { useEffect, useRef } from 'react';
import { mountCallGlass } from './call-glass-canvas';
import './call-window-light.css';

export function CallWindowLight() {
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{const node=canvas.current,screen=node?.closest<HTMLElement>('.phone-screen');if(node&&screen)return mountCallGlass(node,screen);},[]);
  return <div className="call-window-light" aria-hidden="true"><canvas ref={canvas} className="call-window-light__scene" /></div>;
}
