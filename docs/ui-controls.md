# Product interaction standard

The public product and internal phone preview share these rules and the same components.

## Information and actions

Keep character art and current status together. Put actions in a separate group with clear space between the groups. On call waiting, paused, recovery, and failure screens, keep actions at the bottom and let status content scroll if needed. Show each state once. Labels describe outcomes, such as “取消呼叫” and “返回书桌”.

## Shared controls

`apps/debug-console/src/product-controls.css` owns the shared material and feedback. Apply `product-control` to conventional action buttons, and `product-control--primary` to the preferred action. Use `product-control--danger` for destructive actions. Component styles own placement and width, not a separate material recipe.

- Primary and secondary controls belong to the same translucent sage glass family. Primary controls have stronger tint; secondary controls retain a visible surface.
- Glass reveals the actual scene behind the control. Use a faint sage tint (5.5% secondary / 9% primary), a curved optical shoulder, a directional rim reflection and a restrained contact shadow. Avoid broad white gradients, metallic reflections and milky blur. Labels stay crisp above the glass.
- `glass-optics.ts` shares capsule geometry and directional surface lighting between renderers. Native controls use a size-matched live backdrop displacement filter: up to 1.045× central magnification and a smooth 7px edge refraction field. Resize updates the displacement and curved reflection maps; removed controls release their resources. Chromium uses SVG backdrop optics; browsers without SVG backdrop support retain native transparent glass without the displacement. Reduced-transparency preferences disable the lens and use readable solid surfaces.
- Call waiting/recovery screens render the room and glass together in Canvas, sampling the same live scene with the shared lens field. Keep labels, focus, semantics and interaction in native DOM buttons. Cache static lighting, soft tree textures and optical geometry; cap backing density at 1.5× and animate at up to 24 fps. Stop painting when hidden or when reduced motion is requested, and release resources on unmount. If Canvas is unavailable, retain native controls; reduced transparency uses solid surfaces.
- Keep the material on individual controls. Never introduce a glass panel behind the entire action group, and keep decorative layers out of layout flow.
- Use 24px pill radii, fixed 14px labels, and at least 44px touch height. Reading preferences affect documents only.
- Use shared hover, pressed, focus-visible, disabled, and reduced-motion behavior. Avoid opaque background substitutions on press.
- Adapt text contrast and glass tint to light and dark surroundings through shared variables.
- Icon navigation is a visible compact glass control with an accessible name. Destructive actions retain distinct semantics and confirmation.
- The circular hang-up thumb uses transparent ruby-red glass (38% tint) with a dark burgundy handset on light scenes and an ivory handset on dark scenes. Keep the track in the neutral glass family.
- Segmented selection and slide-to-end controls share the material but retain their selected/drag affordances. Felt object entries and file covers remain directly manipulable artwork, rather than being wrapped in unrelated pills.

## Review before release

Review the entire affected flow, including normal, waiting, paused, retry, expired recovery, disabled, and failure states. Include receipt dismissal, folder navigation, preview actions, deletion confirmation, and paging when changing the shared controls. Check light and dark scenes, narrow phones and desktop frames, long labels, and keyboard focus. Keep information and actions distinct and prevent content from displacing controls.

## Call waiting atmosphere

Dialing, paused, recovery and failed-call screens share a softly illuminated felt room with a tall arched fanlight and rectangular panes, inspired by old library windows. Spread the warm daylight over the full screen while keeping portrait/status contrast clear. The frame stays fixed; irregular branches and leaves sway inside its light, with an occasional faint bird shadow. Use recognizable natural silhouettes rather than abstract stripes. The background and Canvas lenses form one non-interactive sibling layer outside layout flow. Reduced-motion preferences retain a still scene.
