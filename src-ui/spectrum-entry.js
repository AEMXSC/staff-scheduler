// Bundled to public/vendor/spectrum.js by `npm run build:ui`.
import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/spectrum-two/theme-dark.js';
import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';
import '@spectrum-web-components/theme/spectrum-two/scale-large.js';
import '@spectrum-web-components/button/sp-button.js';
import '@spectrum-web-components/action-button/sp-action-button.js';
import '@spectrum-web-components/action-group/sp-action-group.js';
import '@spectrum-web-components/tabs/sp-tabs.js';
import '@spectrum-web-components/tabs/sp-tab.js';
import '@spectrum-web-components/picker/sp-picker.js';
import '@spectrum-web-components/menu/sp-menu.js';
import '@spectrum-web-components/menu/sp-menu-item.js';
import '@spectrum-web-components/menu/sp-menu-group.js';
import '@spectrum-web-components/search/sp-search.js';
import '@spectrum-web-components/textfield/sp-textfield.js';
import '@spectrum-web-components/field-label/sp-field-label.js';
import '@spectrum-web-components/accordion/sp-accordion.js';
import '@spectrum-web-components/accordion/sp-accordion-item.js';
import '@spectrum-web-components/dialog/sp-dialog.js';
import '@spectrum-web-components/badge/sp-badge.js';
import '@spectrum-web-components/status-light/sp-status-light.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-calendar.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-people.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-device-phone.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-bell.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-left.js';
import '@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-right.js';

// Spectrum's touch scale on phones/tablets, desktop scale elsewhere.
document.querySelector('sp-theme')?.setAttribute('scale', matchMedia('(pointer: coarse)').matches ? 'large' : 'medium');
