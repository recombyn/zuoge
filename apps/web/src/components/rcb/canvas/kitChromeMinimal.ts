/**
 * Minimal Kit UIEngine id stubs for RCB embed.
 * Kit's full chrome.html (header/layers/side-panel) is NOT injected —
 * product owns chrome; UIEngine only needs these ids to construct safely.
 */
export const KIT_CHROME_MINIMAL = `
<div id="canvas-container">
  <canvas id="editor-canvas"></canvas>
</div>
<div data-rcb-kit-chrome-stub="1" aria-hidden="true" hidden>
  <div id="layer-list" tabindex="0"></div>
  <div id="zoom-level"></div>
  <input id="opacity" type="number" value="100" />
  <div id="fills-list"></div>
  <div id="strokes-list"></div>
  <div id="effects-list"></div>
  <button id="add-fill-btn" type="button"></button>
  <button id="add-stroke-btn" type="button"></button>
  <button id="add-effect-btn" type="button"></button>
  <select id="blend-mode"><option value="0">Normal</option></select>
  <input id="prop-corner-radius" type="number" value="0" />
  <div id="corner-radius-cell"></div>
  <input id="prop-x" type="number" value="0" />
  <input id="prop-y" type="number" value="0" />
  <input id="prop-w" type="number" value="0" />
  <input id="prop-h" type="number" value="0" />
  <input id="prop-rotation" type="number" value="0" />
  <input id="prop-skew-x" type="number" value="0" />
  <input id="prop-skew-y" type="number" value="0" />
  <input id="prop-scale-x" type="number" value="100" />
  <input id="prop-scale-y" type="number" value="100" />
  <button id="toggle-visible" type="button"></button>
  <button id="toggle-locked" type="button"></button>
  <button id="aspect-lock" type="button"></button>
  <div id="ref-anchor"></div>
  <textarea id="text-content"></textarea>
  <select id="text-font-family"><option value="">Default</option></select>
  <input id="text-font-size" type="number" value="32" />
  <input id="text-line-height" type="number" value="1.2" />
  <select id="text-align"><option value="0">Left</option></select>
  <select id="text-weight"><option value="400">Regular</option></select>
  <select id="text-italic"><option value="0">Normal</option></select>
  <input id="text-letter-spacing" type="number" value="0" />
  <div id="typography-section"></div>
  <div id="context-menu"></div>
  <div id="artboard-section" style="display:none"></div>
  <div id="node-props" style="display:none"></div>
  <div id="props-empty"></div>
  <input id="ab-name" type="text" />
  <input id="ab-x" type="number" value="0" />
  <input id="ab-y" type="number" value="0" />
  <input id="ab-w" type="number" value="0" />
  <input id="ab-h" type="number" value="0" />
  <input id="ab-bg" type="color" value="#ffffff" />
  <input id="ab-transparent" type="checkbox" />
  <select id="ab-preset"><option value=""></option></select>
  <button id="ab-delete" type="button"></button>
  <button id="undo-btn" type="button"></button>
  <button id="redo-btn" type="button"></button>
  <button id="reveal-selection-btn" type="button"></button>
  <div id="layers-panel"></div>
  <div id="layers-panel-resizer"></div>
  <div id="export-pane-section" style="display:none"></div>
  <select id="export-pane-scale"><option value="1">1×</option></select>
  <select id="export-pane-format"><option value="png">PNG</option></select>
  <input id="export-pane-suffix" type="text" />
  <input id="export-pane-transparent" type="checkbox" checked />
  <button id="export-pane-btn" type="button"></button>
  <div id="export-pane-size-row" style="display:none"></div>
  <input id="export-pane-width" type="number" />
  <input id="export-pane-height" type="number" />
  <button id="export-pane-ratio-lock" type="button"></button>
</div>
`;
