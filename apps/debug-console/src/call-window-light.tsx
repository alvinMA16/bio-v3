import { useId } from 'react';
import './call-window-light.css';

/* A projected four-pane window, with tree shadows moving inside its light. */
export function CallWindowLight() {
  const id = useId().replace(/:/g, '');
  const panes = `${id}-panes`, softness = `${id}-softness`, leaf = `${id}-leaf`, broadLeaf = `${id}-broad-leaf`;
  return <div className="call-window-light" aria-hidden="true">
    <svg className="call-window-light__scene" viewBox="0 0 390 844" preserveAspectRatio="none" focusable="false">
      <defs>
        <clipPath id={panes}>
          <path d="M126 344 274 390 205 571 59 522Z M289 395 441 443 373 628 220 576Z M54 536 199 585 127 780 -22 726Z M214 590 368 642 296 840 142 785Z" />
        </clipPath>
        <filter id={softness} x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="2.2" /></filter>
        <path id={broadLeaf} d="M0 0C-7-3-6-17-20-20C-29-10-17 4 0 0Z" />
        <path id={leaf} d="M0 0C-3-9-14-18-26-15C-25-4-13 4 0 0Z" />
      </defs>
      <g filter={`url(#${softness})`}>
        <g clipPath={`url(#${panes})`}>
          <path className="call-window-light__sun" d="M-40 320H460V880H-40Z" />
          <g className="call-window-light__branch call-window-light__branch--far">
            <path d="M-30 774C53 719 75 643 123 594C146 570 164 540 184 504" strokeWidth="8" />
            <path d="M76 652C54 611 40 565 15 538M111 609C143 622 176 615 202 594M150 557C129 530 111 506 89 493" strokeWidth="3.5" />
            {[[18,543,-40,1.3],[35,575,130,1],[59,617,-30,1.25],[91,633,82,1],[130,614,190,1.15],[161,614,140,1.3],[194,597,165,1],[107,515,20,1.15],[129,537,110,1.2],[163,535,-20,1],[178,514,85,1.2]].map(([x,y,r,s], i) => <use key={i} href={`#${i % 3 === 0 ? broadLeaf : leaf}`} transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`} />)}
          </g>
          <g className="call-window-light__branch call-window-light__branch--near">
            <path d="M433 889C374 815 355 749 310 676C279 627 265 570 260 518C257 480 243 449 220 416" strokeWidth="9" />
            <path d="M340 730C303 714 268 715 230 692M290 639C320 604 350 581 388 563M265 566C230 549 199 522 176 489M258 511C282 486 310 477 340 474" strokeWidth="4" />
            <path d="M313 609 307 574M230 540 230 508M280 712 260 745M292 486 300 450M246 466 218 464" strokeWidth="2" />
            {[[229,692,10,1.2],[255,707,74,1.3],[278,715,190,1.2],[263,739,-82,1.1],[322,697,140,1.4],[309,673,-15,1.1],[296,647,75,1.3],[307,580,60,1.05],[331,599,190,1.3],[356,582,132,1.1],[382,566,166,1.35],[272,597,26,1.3],[265,570,-65,1.1],[231,541,5,1.25],[231,511,70,1.1],[204,519,125,1.25],[178,492,35,1],[267,500,115,1.15],[297,485,176,1.3],[300,455,80,1.15],[335,476,152,1.1],[250,479,0,1.25],[221,462,-25,1.05],[228,434,100,1.2]].map(([x,y,r,s], i) => <use key={i} href={`#${i % 3 === 0 ? broadLeaf : leaf}`} transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`} />)}
          </g>
          <g className="call-window-light__bird">
            <path d="M-22 3Q-12-14 0 0Q10-12 23-8Q10-5 2 5L-2 6Q-11-3-22 3Z" />
          </g>
        </g>
      </g>
    </svg>
  </div>;
}
