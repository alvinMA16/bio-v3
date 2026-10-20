# Product interaction standard

The public product and internal phone preview share these rules and the same components.

## Information and actions

Keep character art and current status together. Put actions in a separate group with clear space between the groups. On call waiting, paused, recovery, and failure screens, keep actions at the bottom and let status content scroll if needed. Show each state once. Labels describe outcomes, such as “取消呼叫” and “返回书桌”.

## Shared controls

`apps/debug-console/src/product-controls.css` owns the shared material and feedback. Apply `product-control` to conventional action buttons, and `product-control--primary` to the preferred action. Use `product-control--danger` for destructive actions. Component styles own placement and width, not a separate material recipe.

- Primary and secondary controls belong to the same translucent sage glass family. Primary controls have stronger tint; secondary controls retain a visible surface.
- Glass combines translucency, a soft optical highlight, a subtle inner edge, background blur, and a restrained contact shadow. Neither an opaque flat fill nor blur alone is sufficient.
- Use 24px pill radii, fixed 14px labels, and at least 44px touch height. Reading preferences affect documents only.
- Use shared hover, pressed, focus-visible, disabled, and reduced-motion behavior. Avoid opaque background substitutions on press.
- Adapt text contrast and glass tint to light and dark surroundings through shared variables.
- Icon navigation is a visible compact glass control with an accessible name. Destructive actions retain distinct semantics and confirmation.
- Segmented selection and slide-to-end controls share the material but retain their selected/drag affordances. Felt object entries and file covers remain directly manipulable artwork, rather than being wrapped in unrelated pills.

## Review before release

Review the entire affected flow, including normal, waiting, paused, retry, expired recovery, disabled, and failure states. Include receipt dismissal, folder navigation, preview actions, deletion confirmation, and paging when changing the shared controls. Check light and dark scenes, narrow phones and desktop frames, long labels, and keyboard focus. Keep information and actions distinct and prevent content from displacing controls.
