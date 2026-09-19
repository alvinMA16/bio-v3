import { GlassTravelingWave } from './glass-traveling-wave.js';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// A single offscreen 3D scene is shared by the comparison card and phone preview.
let sceneState;
let restTime = -1, openness = 0, lastSound = -10;
const colors=[0x55b9a0,0x61c6b5,0x62bfcc,0x68b6df,0x829fe5,0xa49ae0,0xc59ad4,0xdbabc0];
function createScene() {
  const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(960,300,false);
  renderer.setClearColor(0x000000,0);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=.95;
  const scene=new THREE.Scene();
  const environment=new RoomEnvironment();
  const pmrem=new THREE.PMREMGenerator(renderer);
  const environmentTarget=pmrem.fromScene(environment,.04);
  scene.environment=environmentTarget.texture;
  environment.dispose();pmrem.dispose();
  const camera=new THREE.PerspectiveCamera(28,960/300,.1,50);
  camera.position.set(4.8,.15,8.0);camera.lookAt(0,0,0);camera.zoom=2.35;camera.updateProjectionMatrix();
  const wideCamera=new THREE.OrthographicCamera(-3.6,3.6,1.125,-1.125,.1,50);
  wideCamera.position.copy(camera.position);wideCamera.lookAt(0,0,0);
  const group=new THREE.Group();scene.add(group);
  const geometry=new THREE.BoxGeometry(.055,.92,.92);
  const edgeGeometry=new THREE.EdgesGeometry(geometry);
  const softGeometry=new RoundedBoxGeometry(.055,.92,.92,2,.023);
  const plates=[];
  for(let i=0;i<40;i++){
    const color=new THREE.Color(colors[Math.round(i/39*(colors.length-1))]);
    const material=new THREE.MeshPhysicalMaterial({color,metalness:.02,roughness:.08,transparent:true,opacity:.50,depthWrite:false,transmission:.32,thickness:.14,ior:1.46,clearcoat:1,clearcoatRoughness:.08,envMapIntensity:1.45,attenuationColor:color,attenuationDistance:2.2});
    const plate=new THREE.Mesh(geometry,material);
    const edges=new THREE.LineSegments(edgeGeometry,new THREE.LineBasicMaterial({color:0xf3ffff,transparent:true,opacity:.16}));
    plate.add(edges);group.add(plate);plates.push(plate);
  }
  scene.add(new THREE.HemisphereLight(0xffffff,0xc7d9d6,2.3));
  const key=new THREE.DirectionalLight(0xffffff,4);key.position.set(-3,6,5);scene.add(key);
  const rim=new THREE.DirectionalLight(0xc7ddff,2);rim.position.set(4,1,-4);scene.add(rim);
  return {renderer,scene,camera,wideCamera,group,plates,geometry,softGeometry,edgeGeometry,environmentTarget,lastTime:-1,lastVariant:-1,travelingWave:new GlassTravelingWave(),crop:[0,960],projected:new THREE.Vector3(),tint:new THREE.Color()};
}

export function drawGlassStack(surface,input) {
  const {ctx:c,w,h}=surface;if(!w||!h)return;
  c.clearRect(0,0,w,h);
  try {sceneState??=createScene();} catch {
    c.fillStyle='#667d75';c.font='12px system-ui';c.textAlign='center';c.fillText('3D 预览需要 WebGL 支持',w/2,h*.35);return;
  }
  const s=sceneState;
  const variant=input.index-5;
  if(s.lastTime!==input.time||s.lastVariant!==variant){
    const t=input.reduced?0:input.time;
    const thinking=input.reduced?(input.state==='think'?1:0):input.thinkingMix;
    const voice=input.reduced?.15:input.level;
    const energy=voice*(1-thinking)+.18*thinking;
    if(variant===2||variant>=4)s.travelingWave.update(input.time,voice,thinking);
    if(variant===5 && restTime!==input.time){
      const dt=restTime<0?0:Math.min(.1,Math.max(0,input.time-restTime));
      if(voice>.035 || thinking>.1)lastSound=input.time;
      const target=input.time-lastSound<.65?1:0;
      openness+=(target-openness)*(1-Math.exp(-dt/(target>openness?.20:.85)));
      restTime=input.time;
    }
    const unfold=input.reduced?.65:openness;
    const count=variant===0?15:(variant===2||variant>=4)?40:20;
    for(let i=0;i<s.plates.length;i++){
      const plate=s.plates[i];plate.visible=i<count;if(!plate.visible)continue;
      const u=i/(count-1), middle=Math.sin(u*Math.PI);
      const traveling=Math.sin(t*(thinking?1.8:3.8)-u*7);
      const band=input.reduced?.1:input.bands[i%3]*(1-thinking);
      const originalScale=.76+middle*.22+energy*(.12+.30*(traveling+1)/2)+band*.12;
      let scale=originalScale;
      let x=(i-7)*(.185+energy*.026);
      let wave=traveling*energy*.25;
      let response=energy;
      let slope=0, echo=0;
      if(variant===1){x=(i-9.5)*.275;scale=originalScale*.84;wave=traveling*energy*.16;}
      if(variant===2){
        x=(u-.5)*5.225;
        // A crest takes ~1 second to cross the array. Later plates respond to
        // earlier sound, rather than all sharing the current microphone level.
        response=input.reduced?.10:s.travelingWave.at(input.time,u*19);
        scale=.26+response*.95;
        wave=response*.04;
      }
      if(variant>=4){
        x=(u-.5)*5.225;
        const position=u*19;
        const main=input.reduced?.10:s.travelingWave.at(input.time,position);
        echo=input.reduced?.10:s.travelingWave.at(input.time,position+3.4);
        const ahead=input.reduced?.10:s.travelingWave.at(input.time,Math.max(0,position-.7));
        const behind=input.reduced?.10:s.travelingWave.at(input.time,position+.7);
        slope=Math.max(-.6,Math.min(.6,(ahead-behind)*2.6));
        response=main*.82+echo*.18;
        const edgeSoftness=.90+.10*Math.sin(u*Math.PI);
        scale=.26+response*.95*edgeSoftness;
        // The secondary ripple lags behind the main crest, moving the centre
        // gently instead of simply scaling every face about a rigid baseline.
        wave=(main-echo)*.11;
      }
      if(variant===3){
        const side=i<10?-1:1, j=i%10;
        x=side*(1.72+j*.145);
        scale=.50+energy*.24+.08*Math.sin(j/9*Math.PI);
        wave=traveling*energy*.12;
      }
      plate.position.set(x,wave,Math.cos(t*1.5-u*5)*response*.05);
      plate.scale.set(1,scale,scale);
      plate.rotation.set(.10+response*.06*Math.sin(t*2-u*5),.05*Math.sin(u*3+t*.45)*response,.025+traveling*response*.11);
      plate.geometry=variant>=4?s.softGeometry:s.geometry;
      plate.children[0].visible=variant<4;
      plate.material.envMapIntensity=variant>=4?1.25+response*.5:1.45;
      if(variant>=4){
        plate.rotation.set(.10+slope*.17,slope*.18,.025+slope*.24);
        plate.scale.z=scale*(1+.07*Math.sin(t*.9-u*4)*response);
        plate.position.z=(response-echo)*.14;
      }
      if(variant===5){
        // Keep a fixed camera frame: fitting the crop to the shrinking stack
        // would stretch the quiet state back into a full-width coloured bar.
        const spread=.12+.88*unfold;
        plate.position.x*=spread;
        const quietScale=.055+.016*Math.sin(t*.75+u*2.4);
        const quietMix=1-unfold;
        plate.scale.y=plate.scale.z=quietScale*quietMix+scale*unfold;
        plate.scale.x=.35+.65*unfold;
        plate.position.y=wave*unfold+Math.sin(u*4+t*.65)*.012*quietMix;
        plate.rotation.y+=quietMix*.22*Math.sin(t*.4+u*3);
      }
      if(variant===2)plate.rotation.set(.10,0,.025+response*.025);
      plate.material.opacity=variant>=4?.29:variant===2?.26:.50;
      if(variant===5)plate.material.opacity=.025+.265*unfold;
      plate.children[0].material.opacity=variant===2?.055:.16;
      const color=colors[Math.round(u*(colors.length-1))];
      plate.material.color.setHex(color);plate.material.attenuationColor.setHex(color);
      if(variant===2||variant>=4){
        const position=u*(colors.length-1),lo=Math.floor(position),hi=Math.min(colors.length-1,lo+1);
        plate.material.color.setHex(colors[lo]).lerp(s.tint.setHex(colors[hi]),position-lo);
        plate.material.attenuationColor.copy(plate.material.color);
      }
    }

    s.group.rotation.z=0;
    const camera=variant===0?s.camera:s.wideCamera;
    s.scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
    if(variant>0){
      let lo=960,hi=0;
      // Fit actual projected glass edges to the same content width as the attachment.
      for(const plate of s.plates)if(plate.visible){
        for(const x of [-.0275,.0275])for(const y of [-.46,.46])for(const z of [-.46,.46]){
          s.projected.set(x,y,z).applyMatrix4(plate.matrixWorld).project(camera);
          const px=(s.projected.x+1)*480;lo=Math.min(lo,px);hi=Math.max(hi,px);
        }
      }
      s.crop=[Math.max(0,lo),Math.min(960,hi)];
    }
    if(variant===5){
      s.projected.set(-2.85,0,0).project(camera);
      const left=(s.projected.x+1)*480;
      s.projected.set(2.85,0,0).project(camera);
      s.crop=[left,(s.projected.x+1)*480];
    }
    s.renderer.render(s.scene,camera);s.lastTime=input.time;s.lastVariant=variant;
  }
  if(variant===0){
    const width=Math.min(w+10,370),height=width*300/960;
    c.drawImage(s.renderer.domElement,(w-width)/2,h*.5-height/2,width,height);
  }else{
    const [left,right]=s.crop,cropWidth=Math.max(1,right-left);
    const height=300*w/cropWidth;
    c.drawImage(s.renderer.domElement,left,0,cropWidth,300,0,(h-height)/2,w,height);
  }
}
export function disposeGlassStack(){
  if(!sceneState)return;
  const s=sceneState;
  s.plates.forEach(p=>{p.material.dispose();p.children[0].material.dispose();});
  s.geometry.dispose();s.softGeometry.dispose();s.edgeGeometry.dispose();s.environmentTarget.dispose();s.renderer.dispose();sceneState=undefined;restTime=-1;openness=0;lastSound=-10;
}
